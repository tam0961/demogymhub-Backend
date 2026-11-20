import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { renderTpl } from './clean';
import { shootTemplates, type BotCfg } from './config';

const NL = String.fromCharCode(10);
const SEP = `${NL}-----------${NL}`;
const STATE_KEY = 'zalobot_shoot';
const MENTION = /@\s*bot\s*ai\s*th\s*gym/gi;

export const SHOOT_PTS = [
  { key: 'trang', call: 'PT Trang' },
  { key: 'thinh', call: 'PT Thịnh' },
];
type ShootPt = (typeof SHOOT_PTS)[number];

interface Row {
  pt: string;
  date: string;
  minutes: number;
}
interface Store {
  weeks: Record<string, Row[]>;
}

export interface ShootDeps {
  say: (text: string) => Promise<unknown>;
  once: (key: string) => Promise<boolean>;
}
export interface Now {
  date: string;
  h: number;
  mi: number;
  dow: number;
}
export interface ShootMsg {
  text: string;
  from: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
export const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const fmt = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const fmtT = (m: number) => `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`;
const dowOf = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const mondayOf = (date: string) => addDays(date, -((dowOf(date) + 6) % 7));
const dowLbl = (date: string) => (dowOf(date) === 0 ? 'Chủ nhật' : `Thứ ${dowOf(date) + 1}`);
const weekTxt = (w: string) => `${fmt(w)} đến ${fmt(addDays(w, 6))}`;
const calls = (list: ShootPt[]) => list.map((p) => p.call).join(', ');

/** Saturday and Sunday count for next week, Monday to Friday for this week. */
export const shootWeek = (date: string) => {
  const d = dowOf(date);
  const mo = mondayOf(date);
  return d === 6 || d === 0 ? addDays(mo, 7) : mo;
};

/** "thứ 4 14h", "t7 9h30", "chủ nhật 15:00" -> off = days from Monday; null when the day or hour is missing. */
export function parseShoot(text: string): { off: number; minutes: number } | null {
  const r = norm(String(text || '').replace(MENTION, ' '));
  let off: number | null = null;
  let x: RegExpExecArray | null;
  if (/chu\s*nhat|\bcn\b/.test(r)) off = 6;
  else if ((x = /(?:thu|\bt)\s*([2-7])\b/.exec(r))) off = Number(x[1]) - 2;
  const rest = r.replace(/(?:thu|\bt)\s*[2-7]\b/, ' ');
  const t = /(\d{1,2})\s*(?:h|:|g)\s*(\d{2})?/.exec(rest);
  if (off === null || !t || Number(t[1]) > 23) return null;
  return { off, minutes: Number(t[1]) * 60 + (t[2] ? Number(t[2]) : 0) };
}

/** Lines like "Trang : thứ 4 14h" (numbering allowed); lines with only a name are ignored. */
export function parseShootLines(text: string) {
  const out: { pt: ShootPt; p: ReturnType<typeof parseShoot> }[] = [];
  for (const l of String(text || '').replace(MENTION, ' ').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:\d+\s*[/.)]\s*)?([^:：]+?)\s*[:：]\s*(\S.*)$/);
    if (!m) continue;
    const w = norm(m[1])
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((x) => x && !['a', 'anh', 'c', 'chi', 'e', 'em', 'pt', 'hlv', 'coach'].includes(x));
    const pt = SHOOT_PTS.find((p) => p.key === w[w.length - 1]);
    if (pt) out.push({ pt, p: parseShoot(m[2]) });
  }
  return out;
}

async function load(): Promise<Store> {
  const row = await prisma.setting.findUnique({ where: { key: STATE_KEY } });
  return { weeks: {}, ...((row?.value ?? {}) as Partial<Store>) } as Store;
}
async function save(s: Store, today: string) {
  const keep = addDays(today, -21);
  for (const w of Object.keys(s.weeks)) if (w < keep) delete s.weeks[w];
  const value = s as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
}
const confKey = (week: string) => `shootok:${week}`;
const hasConf = async (week: string) => !!(await prisma.botSent.findUnique({ where: { key: confKey(week) } }));
const clearConf = (week: string) => prisma.botSent.deleteMany({ where: { key: confKey(week) } });

async function state(week: string) {
  const store = await load();
  const rows = store.weeks[week] ?? [];
  return { store, rows, conf: await hasConf(week), miss: SHOOT_PTS.filter((p) => !rows.some((r) => r.pt === p.key)) };
}

const sec = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(SEP);
const lines = (...l: string[]) => l.join(NL);
const shootLine = (p: ShootPt, r: { date: string; minutes: number }) => `${p.call}: ${dowLbl(r.date)} ${fmt(r.date)} lúc ${fmtT(r.minutes)}`;
const summary = (rows: Row[]) =>
  SHOOT_PTS.map((p) => {
    const r = rows.find((x) => x.pt === p.key);
    return r ? shootLine(p, r) : null;
  })
    .filter(Boolean)
    .join(NL);
const template = (cfg: BotCfg, week: string, list: ShootPt[], head: string, note?: string) =>
  sec(
    lines(head, `Tuần ${weekTxt(week)}`, ...(note ? [note] : [])),
    list.map((p, i) => `${i + 1}/ ${p.call} :`).join(NL),
    lines('Ví dụ: Trang : thứ 4 14h', `Nhớ tag "${cfg.botName}" ạ`),
  );
const ask = (cfg: BotCfg) => lines('Emma xác nhận giúp em: nhắn "xác nhận" (nhớ tag "' + cfg.botName + '")', 'Cần đổi lịch: nhắn "Đổi lịch Trang" hoặc "Đổi lịch Thịnh"');
const pre = (cfg: BotCfg, items: { p: ShootPt; r: { date: string; minutes: number } }[], conf: boolean, when: string) =>
  renderTpl(shootTemplates(cfg).remind, {
    when: when.toUpperCase(),
    list: items.map((i) => shootLine(i.p, i.r)).join(NL),
    status: conf ? `Emma và ${calls(items.map((i) => i.p))} nhớ chuẩn bị nha ạ.` : `Emma chưa xác nhận: nhắn "xác nhận" (nhớ tag "${cfg.botName}")`,
    bot: cfg.botName,
  });
const formText = (cfg: BotCfg, week: string, list: ShootPt[]) => renderTpl(shootTemplates(cfg).form, { week: weekTxt(week), list: list.map((p, i) => `${i + 1}/ ${p.call} :`).join(NL), bot: cfg.botName });

/** A message in the shoot group: PTs fill the form, Emma confirms or asks to change. */
export async function handleShoot(cfg: BotCfg, deps: ShootDeps, m: ShootMsg, now: Now) {
  const week = shootWeek(now.date);
  const nt = norm(m.text);
  const boss = norm(cfg.shootBoss || 'emma');
  const isBoss = norm(m.from)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .includes(boss);
  const st = await state(week);
  if (isBoss) {
    if (/doi\s*lich/.test(nt)) {
      const only = SHOOT_PTS.filter((p) => new RegExp(`\\b${p.key}\\b`).test(nt));
      const list = only.length ? only : SHOOT_PTS;
      st.store.weeks[week] = st.rows.filter((r) => !list.some((p) => p.key === r.pt));
      await save(st.store, now.date);
      await clearConf(week);
      await deps.say(template(cfg, week, list, '🔄 EMMA MUỐN ĐỔI LỊCH QUAY', `${list.map((p) => (p.key === 'thinh' ? 'Anh Thịnh' : 'Chị Trang')).join(', ')} sắp xếp lại báo lại em ạ.`));
      return;
    }
    if (/xac\s*nhan/.test(nt)) {
      if (st.conf) return;
      if (!st.rows.length) {
        await deps.say('Chưa có lịch quay nào để xác nhận ạ');
        return;
      }
      await deps.once(confKey(week));
      await deps.say(renderTpl(shootTemplates(cfg).confirmed, { week: weekTxt(week), list: summary(st.rows), missing: st.miss.length ? `${NL}${SEP.trim()}${NL}Còn thiếu: ${calls(st.miss)}` : '', bot: cfg.botName }));
    }
  }
  const items = parseShootLines(m.text);
  if (!items.length) {
    if (/quay/.test(nt) && !isBoss) await deps.say(`Ghi lịch quay theo mẫu: Trang : thứ 4 14h (có tên, thứ và giờ), nhớ tag "${cfg.botName}" ạ`);
    return;
  }
  const done: { p: ShootPt; r: { date: string; minutes: number } }[] = [];
  const bad: string[] = [];
  let changed = false;
  let rows = [...st.rows];
  for (const it of items) {
    if (!it.p) {
      bad.push(`${it.pt.call} (thiếu thứ hoặc giờ)`);
      continue;
    }
    const date = addDays(week, it.p.off);
    if (date < now.date) {
      bad.push(`${it.pt.call} (ngày ${fmt(date)} đã qua)`);
      continue;
    }
    const old = rows.find((r) => r.pt === it.pt.key);
    if (!old || old.date !== date || old.minutes !== it.p.minutes) changed = true;
    rows = [...rows.filter((r) => r.pt !== it.pt.key), { pt: it.pt.key, date, minutes: it.p.minutes }];
    done.push({ p: it.pt, r: { date, minutes: it.p.minutes } });
  }
  st.store.weeks[week] = rows;
  await save(st.store, now.date);
  if (changed && st.conf) await clearConf(week);
  const late = done.filter((d) => (d.r.date === addDays(now.date, 1) && now.h >= 19) || d.r.date === now.date);
  const s2 = await state(week);
  const parts: string[] = [];
  if (done.length) {
    parts.push(lines('✅ ĐÃ GHI NHẬN', done.map((d) => shootLine(d.p, d.r)).join(NL)));
    if (s2.miss.length) parts.push(`Còn thiếu: ${calls(s2.miss)}`);
    else {
      parts.push(lines('ĐÃ ĐỦ LỊCH QUAY', summary(s2.rows)));
      if (!s2.conf && !late.length) parts.push(ask(cfg));
    }
  }
  if (bad.length) parts.push(lines(`Chưa ghi được: ${bad.join(', ')}`, 'Ghi theo mẫu: Trang : thứ 4 14h (có tên, thứ và giờ)'));
  if (parts.length) await deps.say(sec(...parts));
  if (late.length) {
    const fresh: typeof late = [];
    for (const d of late) if (await deps.once(`shootpre:${d.r.date}:${d.p.key}:${d.r.minutes}`)) fresh.push(d);
    if (fresh.length) await deps.say(pre(cfg, fresh, s2.conf, fresh[0].r.date === now.date ? 'hôm nay' : 'ngày mai'));
  }
}

/** 8h and 15h from Saturday before to Friday of the shoot week: ask for what is missing or for Emma's confirmation. 19h: remind tomorrow's shoots. */
export async function runShootReminders(cfg: BotCfg, deps: ShootDeps, now: Now) {
  if (!cfg.enabled || !cfg.token || !cfg.shootOn || !cfg.shootGroup) return;
  if (now.h === 19) {
    const tm = addDays(now.date, 1);
    const store = await load();
    const fresh: { p: ShootPt; r: Row }[] = [];
    let week = '';
    for (const [w, rows] of Object.entries(store.weeks)) {
      for (const r of rows.filter((x) => x.date === tm)) {
        const p = SHOOT_PTS.find((x) => x.key === r.pt);
        if (p && (await deps.once(`shootpre:${tm}:${p.key}:${r.minutes}`))) {
          fresh.push({ p, r });
          week = w;
        }
      }
    }
    if (fresh.length) await deps.say(pre(cfg, fresh, await hasConf(week), 'ngày mai'));
    return;
  }
  if (now.h !== 8 && now.h !== 15) return;
  const week = shootWeek(now.date);
  const st = await state(week);
  if (!st.miss.length && st.conf) return;
  if (!(await deps.once(`shoot:${now.date}:${now.h}`))) return;
  if (st.miss.length) await deps.say(formText(cfg, week, st.miss));
  else await deps.say(sec(lines('🎬 ĐÃ ĐỦ LỊCH QUAY', `Tuần ${weekTxt(week)}`), summary(st.rows), ask(cfg)));
}
