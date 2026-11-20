import { addDays as addDaysDate, dateOnly, dayRange } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { applyShiftMessage, branchTrainers } from '../pt/shift-message';
import { cleanName, fmtDM, lastWord } from '../pt/zalo-shift';
import { handleCleanText, runCleanReminders } from './clean';
import { handleShoot, runShootReminders } from './shoot';
import { getBotCfg, getBotState, patchBotState, type BotCfg } from './config';

const API = 'https://bot-api.zaloplatforms.com';
const MENTION = /@\s*bot\s*ai\s*th\s*gym/gi;

export interface ZaloReply {
  ok?: boolean;
  error_code?: number;
  description?: string;
  result?: unknown;
}

export async function zaloApi(token: string, method: string, body: object = {}, timeoutMs = 30000): Promise<ZaloReply | null> {
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as ZaloReply;
  } catch {
    return null;
  }
}

export async function sendText(cfg: Pick<BotCfg, 'token'>, chatId: string, text: string) {
  return zaloApi(cfg.token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 2000) });
}

async function once(key: string) {
  try {
    await prisma.botSent.create({ data: { key } });
    return true;
  } catch {
    return false;
  }
}

const vnParts = (d: Date) => {
  const v = new Date(d.getTime() + 7 * 3600 * 1000);
  return { h: v.getUTCHours(), mi: v.getUTCMinutes(), dow: v.getUTCDay(), date: v.toISOString().slice(0, 10) };
};
const addDays = (iso: string, n: number) => addDaysDate(dateOnly(iso), n).toISOString().slice(0, 10);
const weekStart = (iso: string) => addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));

export interface OffItem {
  name: string;
  days: number[];
}
/** "LỊCH OFF" message: lines like "1/ Thịnh: off thứ 3". Sent on Sunday counts for the coming week. Days 2..7 = Mon..Sat, 8 = Sunday. */
export function parseOffMessage(text: string, sentAt: Date): { week: string; items: OffItem[] } | null {
  const lines = text.replace(MENTION, ' ').split(/\r?\n/);
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const hi = lines.findIndex((l) => /lich\s*off/.test(fold(l)));
  if (hi < 0) return null;
  const items: OffItem[] = [];
  lines.forEach((line, i) => {
    if (i === hi) return;
    const m = line.match(/^\s*(?:\d+\s*[\/.)]\s*)?([^:：]+?)\s*[:：]\s*(.*)$/);
    if (!m) return;
    const name = cleanName(m[1]);
    if (!name) return;
    const r = fold(m[2]);
    if (/\b(khong|k)\s*(off|nghi)\b/.test(r)) {
      items.push({ name, days: [] });
      return;
    }
    const days = new Set<number>();
    for (const x of r.matchAll(/(?:thu|t)\s*([2-7])/g)) days.add(Number(x[1]));
    if (/chu\s*nhat|\bcn\b/.test(r)) days.add(8);
    items.push({ name, days: [...days].sort() });
  });
  if (!items.length) return null;
  return { week: weekStart(addDays(vnParts(sentAt).date, 1)), items };
}

async function applyOff(cfg: BotCfg, text: string, sentAt: Date): Promise<string | null> {
  const off = parseOffMessage(text, sentAt);
  if (!off) return null;
  const trainers = await branchTrainers(cfg.branchId);
  let done = 0;
  for (const it of off.items) {
    const found = trainers.filter((t) => lastWord(t.name) === lastWord(it.name));
    if (found.length !== 1) continue;
    const trainerId = found[0].id;
    await prisma.ptDayOff.deleteMany({ where: { trainerId, branchId: cfg.branchId, date: { gte: dateOnly(off.week), lte: dateOnly(addDays(off.week, 6)) } } });
    for (const n of it.days) {
      const key = { trainerId, branchId: cfg.branchId, date: dateOnly(addDays(off.week, n - 2)) };
      await prisma.ptDayOff.upsert({ where: { trainerId_branchId_date: key }, create: key, update: {} });
    }
    done++;
  }
  return done ? `✅ Đã ghi nhận lịch OFF tuần ${fmtDM(off.week)} đến ${fmtDM(addDays(off.week, 6))}` : null;
}

export async function handleGroupText(cfg: BotCfg, text: string, sentAt: Date): Promise<string | null> {
  const clean = text.replace(MENTION, ' ');
  const offReply = await applyOff(cfg, clean, sentAt);
  if (offReply) return offReply;
  const r = await applyShiftMessage(cfg.branchId, clean, sentAt);
  if (!r.handled || !r.results?.length) return null;
  return r.reply;
}

interface Update {
  event_name?: string;
  message?: {
    message_id?: string;
    text?: string;
    date?: number;
    from?: { display_name?: string; is_bot?: boolean };
    chat?: { id?: string; chat_type?: string; display_name?: string; title?: string };
  };
}

export async function handleUpdate(cfg: BotCfg, it: Update) {
  const m = it.message;
  if (!m?.message_id || !m.chat?.id) return;
  if (!(await once(`msg:${m.message_id}`))) return;
  const chatId = String(m.chat.id);
  const state = await getBotState();
  const seen = [{ id: chatId, type: String(m.chat.chat_type ?? ''), name: m.chat.title ?? m.chat.display_name ?? m.from?.display_name ?? '', at: new Date().toISOString() }, ...state.chats.filter((c) => c.id !== chatId)].slice(0, 20);
  await patchBotState({ chats: seen, lastItemAt: new Date().toISOString() });
  if (m.text && !m.from?.is_bot && cfg.shootOn && cfg.shootGroup && chatId === cfg.shootGroup) {
    const when = m.date ? new Date(m.date * (m.date < 1e12 ? 1000 : 1)) : new Date();
    await handleShoot(cfg, { say: (x) => sendText(cfg, cfg.shootGroup, x), once }, { text: m.text, from: String(m.from?.display_name ?? '') }, vnParts(when));
    return;
  }
  if (m.text && !m.from?.is_bot && cfg.cleanOn && cfg.cleanGroup && chatId === cfg.cleanGroup) {
    const when = m.date ? new Date(m.date * (m.date < 1e12 ? 1000 : 1)) : new Date();
    const by = String(m.from?.display_name ?? 'Nhân viên').slice(0, 40);
    await handleCleanText(cfg, { say: (x) => sendText(cfg, cfg.cleanGroup, x), once }, m.text.replace(MENTION, ' '), by, vnParts(when));
    return;
  }
  if (!m.text || m.from?.is_bot || !cfg.ptGroup || chatId !== cfg.ptGroup || !cfg.branchId) return;
  const reply = await handleGroupText(cfg, m.text, m.date ? new Date(m.date * (m.date < 1e12 ? 1000 : 1)) : new Date());
  if (reply) await sendText(cfg, cfg.ptGroup, reply);
}

const DOW = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

export async function groupClassText(branchId: string, date: string): Promise<string> {
  const day = dayRange(date);
  const classes = await prisma.groupClass.findMany({
    where: { branchId, status: { not: 'cancelled' }, startAt: { gte: day.gte, lt: day.lt } },
    orderBy: { startAt: 'asc' },
    include: { trainer: { select: { name: true } }, registrations: { select: { status: true } } },
  });
  if (!classes.length) return '';
  const blocks = classes.map((c) => {
    const regs = c.registrations.filter((r) => r.status !== 'waitlist');
    const cancelled = regs.filter((r) => r.status === 'cancelled').length;
    const v = new Date(c.startAt.getTime() + 7 * 3600 * 1000);
    const hm = `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
    const count = regs.length ? `${regs.length}${cancelled ? ` (${cancelled} hủy)` : ''}` : 'không có đăng ký';
    return `${hm} ${c.muscleGroup?.trim() || 'Lớp nhóm'}\nSố lượng học viên: ${count}\nPT phụ trách: ${c.trainer?.name ?? 'chưa có PT'}`;
  });
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `🍀 CA LỚP NHÓM NGÀY MAI 🍀\n${DOW[dow]} ${fmtDM(date)}\n\n${blocks.join('\n------------\n')}`;
}

const tagOf = (name: string) => `@${name.trim().split(/\s+/).pop()}`;

async function missingFor(branchId: string, date: string) {
  const trainers = await branchTrainers(branchId);
  const day = dayRange(date);
  const sessions = await prisma.ptSession.findMany({ where: { branchId, startAt: { gte: day.gte, lt: day.lt }, status: { not: 'cancelled' } }, select: { trainerId: true }, distinct: ['trainerId'] });
  const offs = await prisma.ptDayOff.findMany({ where: { branchId, date: dateOnly(date) }, select: { trainerId: true } });
  const reps = await prisma.botSent.findMany({ where: { key: { startsWith: `rep:${date}:` } }, select: { key: true } });
  const have = new Set([...sessions.map((s) => s.trainerId), ...offs.map((o) => o.trainerId), ...reps.map((r) => r.key.split(':')[2])]);
  return trainers.filter((t) => !have.has(t.id));
}

/** Hourly reminders in the PT group; each slot is sent once (bot_sent) within the first 5 minutes of the hour. */
export async function runReminders(now = new Date()) {
  const cfg = await getBotCfg();
  if (!cfg.enabled || !cfg.token || !cfg.ptGroup || !cfg.branchId) return;
  const t = vnParts(now);
  if (t.mi >= 5) return;
  const say = (text: string) => sendText(cfg, cfg.ptGroup, text);
  if (t.dow === 0 && t.h === 20 && (await once(`off:${t.date}`))) {
    await say(`📅 Nhắc lịch OFF: Anh chị PT báo giúp em lịch off tuần mới ạ. Chúc Anh/Chị cuối tuần vui vẻ !\nLưu ý nhớ tag tên "${cfg.botName}"`);
  }
  if (t.h === 7 && (await once(`today:${t.date}`))) {
    const trainers = await branchTrainers(cfg.branchId);
    const day = dayRange(t.date);
    const offIds = new Set((await prisma.ptDayOff.findMany({ where: { branchId: cfg.branchId, date: dateOnly(t.date) }, select: { trainerId: true } })).map((o) => o.trainerId));
    const classes = await prisma.groupClass.findMany({ where: { branchId: cfg.branchId, status: { not: 'cancelled' }, startAt: { gte: day.gte, lt: day.lt } }, orderBy: { startAt: 'asc' }, select: { trainerId: true, startAt: true } });
    const hm = (d: Date) => {
      const p = vnParts(d);
      return p.mi ? `${p.h}h${String(p.mi).padStart(2, '0')}` : `${p.h}h`;
    };
    const list = trainers
      .map((p, i) => {
        const fill = offIds.has(p.id) ? 'Off' : classes.filter((c) => c.trainerId === p.id).map((c) => `${hm(c.startAt)} (Nhóm)`).join(' ');
        return `${i + 1}/ ${p.name} :${fill ? ` ${fill}` : ''}`;
      })
      .join('\n');
    await say(`Anh Chị PT báo ca hôm nay giúp e ạ\n🍀 CA DẠY HÔM NAY 🍀\n${list}\n\nNhớ gõ @ rồi chọn "${cfg.botName}" để bot đọc được.`);
  }
  if (t.h === 8 && (await once(`chk:${t.date}`))) {
    const miss = await missingFor(cfg.branchId, t.date);
    if (miss.length) {
      await say(`⚠️ Anh Chị PT quên chưa báo ca dạy hôm nay (${fmtDM(t.date)}) ạ : ${miss.map((p) => tagOf(p.name)).join(' ')} vui lòng báo ca theo mẫu "CA DẠY" trong nhóm, nhớ tag "${cfg.botName}"`);
    }
  }
  if (t.h === 21 && t.dow !== 6) {
    const text = await groupClassText(cfg.branchId, addDays(t.date, 1));
    if (text && (await once(`gcls:${t.date}`))) await say(text);
  }
}

export async function runCleanTick(now = new Date()) {
  const cfg = await getBotCfg();
  await runCleanReminders(cfg, { say: (x) => sendText(cfg, cfg.cleanGroup, x), once }, vnParts(now));
}

export async function runShootTick(now = new Date()) {
  const cfg = await getBotCfg();
  await runShootReminders(cfg, { say: (x) => sendText(cfg, cfg.shootGroup, x), once }, vnParts(now));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK = 'zbot:lock';

async function pollOnce(cfg: BotCfg) {
  const r = await zaloApi(cfg.token, 'getUpdates', { timeout: '20' }, 35000);
  const now = new Date().toISOString();
  if (!r) {
    await patchBotState({ lastPollAt: now, lastError: 'Không kết nối được Zalo' });
    await sleep(10000);
    return;
  }
  if (!r.ok) {
    if (r.error_code === 408) {
      await patchBotState({ lastPollAt: now, lastError: null });
      return;
    }
    await patchBotState({ lastPollAt: now, lastError: String(r.description ?? `lỗi ${r.error_code}`).slice(0, 200) });
    if (/webhook/i.test(String(r.description ?? ''))) await zaloApi(cfg.token, 'deleteWebhook');
    await sleep(10000);
    return;
  }
  await patchBotState({ lastPollAt: now, lastError: null });
  const items = (Array.isArray(r.result) ? r.result : r.result ? [r.result] : []) as Update[];
  for (const it of items) {
    try {
      await handleUpdate(cfg, it);
    } catch (e) {
      logger.error({ err: e }, 'zalo bot update failed');
    }
  }
}

export function startZaloBot() {
  const owner = Math.random().toString(36).slice(2);
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const cfg = await getBotCfg();
        if (!cfg.enabled || !cfg.token) {
          await sleep(15000);
          continue;
        }
        const got = await redis.set(LOCK, owner, 'EX', 60, 'NX');
        if (got !== 'OK' && (await redis.get(LOCK)) !== owner) {
          await sleep(15000);
          continue;
        }
        await redis.expire(LOCK, 60);
        await pollOnce(cfg);
      } catch (e) {
        logger.error({ err: e }, 'zalo bot loop failed');
        await sleep(10000);
      }
    }
  })();
  const timer = setInterval(() => {
    runReminders().catch((e) => logger.error({ err: e }, 'zalo bot reminders failed'));
    runCleanTick().catch((e) => logger.error({ err: e }, 'zalo bot clean reminders failed'));
    runShootTick().catch((e) => logger.error({ err: e }, 'zalo bot shoot reminders failed'));
    void prisma.botSent.deleteMany({ where: { at: { lt: new Date(Date.now() - 120 * 86400000) } } }).catch(() => undefined);
  }, 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
