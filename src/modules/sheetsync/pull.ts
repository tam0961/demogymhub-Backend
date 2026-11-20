import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { todayVN } from '../../lib/dates';
import { nextMemberCode } from '../contracts/codes';
import { getBotCfg } from '../zalobot/config';
import { branchTrainers } from '../pt/shift-message';
import { fold, mapStatus, normalizePhone, parseClassLabel } from '../pt/sheet-import';
import { lastWord } from '../pt/zalo-shift';
import { getSheetSyncCfg, patchSheetSyncCfg } from './config';

export interface PullResult {
  ok: boolean;
  error?: string;
  counts: Record<string, number>;
  unmatched: { name: string; phone: string }[];
}

interface Dump {
  ok?: boolean;
  error?: string;
  members?: string[][];
  registrations?: string[][];
  classes?: string[][];
  schedule?: string[][];
}

type Status = 'booked' | 'attended' | 'absent' | 'cancelled';

interface ClassInfo {
  date: string;
  start: string;
  end: string;
  muscle: string | null;
  capacity: number | null;
  pt: string;
  regs: { name: string; phone: string; email: string; status: Status | null }[];
}

const cell = (r: string[], i: number) => String(r[i] ?? '').trim();
const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmm = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  return m ? `${pad2(Number(m[1]))}:${m[2]}` : '';
};

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** yyyy-mm-dd, dd-mm-yyyy, dd/mm/yy, dd/mm/yyyy (optionally followed by a time) -> yyyy-mm-dd, or '' */
export function parseDateAny(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(s);
  if (m) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
  }
  return '';
}

/** "T4 (26/11) - 20:00-21:15 (...)" has no year: pick the year that puts the date in [today - 60 days, today + 300 days]. */
function dateFromLabel(label: string, today: string): string {
  const m = /\((\d{1,2})\/(\d{1,2})\)/.exec(label);
  if (!m) return '';
  const y = Number(today.slice(0, 4));
  for (const yy of [y, y + 1, y - 1]) {
    const iso = `${yy}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
    if (iso >= addDays(today, -60) && iso <= addDays(today, 300)) return iso;
  }
  return `${y}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
}

function regStatus(done: string, status: string): Status | null {
  const d = fold(done);
  if (d.includes('vang') || d.includes('absent')) return 'absent';
  const a = mapStatus(done);
  if (a) return a;
  const b = mapStatus(status);
  return b;
}

async function fetchDump(url: string, secret: string): Promise<Dump> {
  let res: Response;
  try {
    res = await fetch(`${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(secret)}`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Không kết nối được Apps Script: ${e instanceof Error ? e.message : 'lỗi mạng'}`);
  }
  const text = await res.text().catch(() => '');
  let j: Dump | null = null;
  try {
    j = JSON.parse(text) as Dump;
  } catch {
    j = null;
  }
  if (!j) throw new Error('Apps Script không trả dữ liệu hợp lệ. Kiểm tra đã triển khai Web app với quyền truy cập "Bất kỳ ai"');
  if (!j.ok) throw new Error(j.error === 'key' ? 'Sai mã bí mật của Apps Script' : `Apps Script báo lỗi: ${j.error ?? 'không rõ'}`);
  return j;
}

function collectClasses(d: Dump, today: string) {
  const map = new Map<string, ClassInfo>();
  const get = (date: string, start: string, end: string) => {
    const key = `${date}|${start}`;
    let c = map.get(key);
    if (!c) {
      c = { date, start, end, muscle: null, capacity: null, pt: '', regs: [] };
      map.set(key, c);
    }
    return c;
  };
  for (const r of d.schedule ?? []) {
    const date = parseDateAny(cell(r, 1));
    const start = hhmm(cell(r, 2));
    const end = hhmm(cell(r, 3));
    if (!date || !start || !end) continue;
    const c = get(date, start, end);
    c.muscle = cell(r, 4) || c.muscle;
    const cap = Number(cell(r, 5));
    if (cap > 0) c.capacity = cap;
  }
  for (const r of d.classes ?? []) {
    const label = cell(r, 1);
    const p = parseClassLabel(label);
    const date = parseDateAny(cell(r, 2)) || dateFromLabel(label, today);
    if (!p || !date) continue;
    const c = get(date, p.start, p.end);
    c.muscle = p.muscleGroup ?? c.muscle;
    c.pt = cell(r, 4) || c.pt;
  }
  const regCount = { bad: 0 };
  for (const r of d.registrations ?? []) {
    const label = cell(r, 4);
    const p = parseClassLabel(label);
    const date = parseDateAny(cell(r, 5)) || dateFromLabel(label, today);
    if (!p || !date) {
      regCount.bad++;
      continue;
    }
    const c = get(date, p.start, p.end);
    c.muscle = p.muscleGroup ?? c.muscle;
    c.pt = cell(r, 8) || c.pt;
    c.regs.push({ name: cell(r, 1), phone: cell(r, 2), email: cell(r, 3), status: regStatus(cell(r, 9), cell(r, 7)) });
  }
  return { classes: [...map.values()], badRows: regCount.bad };
}

async function sync(branchId: string, d: Dump): Promise<PullResult> {
  const today = todayVN();
  const { classes, badRows } = collectClasses(d, today);
  const trainers = await branchTrainers(branchId);
  const trainerOf = (pt: string) => {
    const key = lastWord(pt);
    if (!key) return null;
    const found = trainers.filter((t) => lastWord(t.name) === key);
    return found.length === 1 ? found[0].id : null;
  };

  const counts: Record<string, number> = { classes_created: 0, classes_updated: 0, registrations_created: 0, registrations_updated: 0, skipped: badRows, emails_filled: 0, unmatched: 0 };
  const unmatched = new Map<string, string>();
  const memberCache = new Map<string, { id: string; email: string | null } | null>();
  const memberOf = async (phone: string) => {
    const p = normalizePhone(phone);
    if (!memberCache.has(p)) memberCache.set(p, p ? await prisma.member.findUnique({ where: { phone: p }, select: { id: true, email: true } }) : null);
    return memberCache.get(p) ?? null;
  };

  for (const c of classes) {
    const startAt = new Date(`${c.date}T${c.start}:00+07:00`);
    const endAt = new Date(`${c.date}T${c.end}:00+07:00`);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) continue;
    const trainerId = trainerOf(c.pt);
    const attended = c.regs.length > 0 && c.regs.every((r) => r.status === 'attended' || r.status === 'cancelled') && c.regs.some((r) => r.status === 'attended');

    let cls = await prisma.groupClass.findFirst({ where: { branchId, startAt } });
    if (!cls) {
      cls = await prisma.groupClass.create({
        data: { branchId, startAt, endAt, muscleGroup: c.muscle, capacity: c.capacity ?? 3, trainerId, status: attended && c.date < today ? 'completed' : 'scheduled', completedAt: attended && c.date < today ? endAt : null },
      });
      counts.classes_created++;
    } else {
      const patch: { muscleGroup?: string; trainerId?: string; status?: 'completed'; completedAt?: Date } = {};
      if (!cls.muscleGroup && c.muscle) patch.muscleGroup = c.muscle;
      if (!cls.trainerId && trainerId) patch.trainerId = trainerId;
      if (cls.status === 'scheduled' && attended && c.date < today) {
        patch.status = 'completed';
        patch.completedAt = endAt;
      }
      if (Object.keys(patch).length) {
        await prisma.groupClass.update({ where: { id: cls.id }, data: patch });
        counts.classes_updated++;
      }
    }

    for (const r of c.regs) {
      const m = await memberOf(r.phone);
      if (!m) {
        const p = normalizePhone(r.phone);
        if (p && !unmatched.has(p)) unmatched.set(p, r.name);
        counts.skipped++;
        continue;
      }
      if (!m.email && r.email) {
        await prisma.member.update({ where: { id: m.id }, data: { email: r.email } });
        m.email = r.email;
        counts.emails_filled++;
      }
      const existing = await prisma.groupRegistration.findFirst({ where: { classId: cls.id, memberId: m.id }, orderBy: { createdAt: 'asc' } });
      if (existing) {
        const next = r.status;
        const appMade = existing.source !== 'sheet';
        const apply = next && next !== existing.status && (!appMade || next === 'attended' || next === 'absent' || next === 'cancelled') && !(existing.status === 'cancelled' && next === 'booked');
        if (apply && next) {
          await prisma.groupRegistration.update({ where: { id: existing.id }, data: { status: next, cancelledAt: next === 'cancelled' ? new Date() : existing.cancelledAt } });
          counts.registrations_updated++;
        } else counts.skipped++;
        continue;
      }
      if (!r.status || r.status === 'cancelled') {
        counts.skipped++;
        continue;
      }
      await prisma.groupRegistration.create({
        data: { classId: cls.id, memberId: m.id, name: r.name || 'Hội viên', phone: normalizePhone(r.phone), email: r.email || null, status: r.status, source: 'sheet', deducted: false },
      });
      counts.registrations_created++;
    }
  }
  const matched = new Set<string>();
  for (const r of d.members ?? []) {
    const phone = normalizePhone(cell(r, 1));
    if (!phone) continue;
    const m = await memberOf(phone);
    if (!m) continue;
    matched.add(phone);
    const email = cell(r, 2);
    if (!m.email && email) {
      await prisma.member.update({ where: { id: m.id }, data: { email } });
      m.email = email;
      counts.emails_filled++;
    }
  }
  await refreshPending(pendingFrom(d, matched, unmatched, new Date().toISOString()));
  counts.unmatched = unmatched.size;
  counts.pending = (await getPendingMembers()).length;
  return { ok: true, counts, unmatched: [...unmatched.entries()].map(([phone, name]) => ({ name, phone })) };
}

export interface PendingMember {
  name: string;
  phone: string;
  email: string;
  expiry: string | null;
  learned: number | null;
  remaining: number | null;
  note: string;
  seenAt: string;
}

const PENDING_KEY = 'sheetsync_pending';

export async function getPendingMembers(): Promise<PendingMember[]> {
  const row = await prisma.setting.findUnique({ where: { key: PENDING_KEY } });
  return Array.isArray(row?.value) ? (row!.value as unknown as PendingMember[]) : [];
}

async function savePending(list: PendingMember[]) {
  const value = list as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: PENDING_KEY }, create: { key: PENDING_KEY, value }, update: { value } });
}

const intOrNull = (raw: string) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

/** Sheet-only people (Members tab and registrations) that have no member in the app, keyed by normalized phone. */
function pendingFrom(d: Dump, matched: Set<string>, unmatchedRegs: Map<string, string>, now: string): Map<string, PendingMember> {
  const out = new Map<string, PendingMember>();
  for (const r of d.members ?? []) {
    const phone = normalizePhone(cell(r, 1));
    if (!phone || matched.has(phone) || out.has(phone)) continue;
    out.set(phone, { name: cell(r, 0), phone, email: cell(r, 2), expiry: parseDateAny(cell(r, 3)) || null, learned: intOrNull(cell(r, 4)), remaining: intOrNull(cell(r, 5)), note: cell(r, 8), seenAt: now });
  }
  for (const [phone, name] of unmatchedRegs) if (!out.has(phone) && !matched.has(phone)) out.set(phone, { name, phone, email: '', expiry: null, learned: null, remaining: null, note: '', seenAt: now });
  return out;
}

async function refreshPending(fresh: Map<string, PendingMember>) {
  const old = new Map((await getPendingMembers()).map((x) => [x.phone, x]));
  for (const [phone, m] of fresh) old.set(phone, { ...m, email: m.email || old.get(phone)?.email || '', seenAt: old.get(phone)?.seenAt ?? m.seenAt });
  const phones = [...old.keys()];
  const existing = phones.length ? await prisma.member.findMany({ where: { phone: { in: phones } }, select: { phone: true } }) : [];
  for (const e of existing) old.delete(e.phone);
  await savePending([...old.values()]);
}

/** Creates ONE member (no contract) from a pending Sheet person using the normal member code generator. */
export async function approvePending(phone: string, createdBy: string | null): Promise<{ memberId: string; code: string }> {
  const p = normalizePhone(phone);
  const list = await getPendingMembers();
  const entry = list.find((x) => x.phone === p);
  if (!entry) throw new Error('Hội viên này không nằm trong danh sách chờ duyệt từ Sheet');
  if (await prisma.member.findUnique({ where: { phone: p }, select: { id: true } })) {
    await savePending(list.filter((x) => x.phone !== p));
    throw new Error('Số điện thoại này đã có hội viên trong app');
  }
  const cfg = await getSheetSyncCfg();
  const branchId = cfg.branchId || (await getBotCfg()).branchId;
  if (!branchId) throw new Error('Chưa chọn chi nhánh cho hội viên từ Sheet');
  const m = await prisma.member.create({ data: { code: await nextMemberCode(), name: entry.name || 'Hội viên', phone: p, email: entry.email || null, branchId } });
  await savePending(list.filter((x) => x.phone !== p));
  await audit(createdBy, 'member.created_from_sheet', { phone: p, name: m.name }, undefined, m.id);
  return { memberId: m.id, code: m.code };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Makes sure a PT-group member exists in the Sheet's Members tab (the old bridge refuses unknown members and needs an email). */
export async function upsertSheetMember(m: { name: string; phone: string; email: string | null }): Promise<{ ok: boolean; added?: boolean; error?: string; skipped?: 'no_email' | 'not_configured' }> {
  const cfg = await getSheetSyncCfg();
  if (!cfg.dumpUrl || !cfg.secret) return { ok: false, skipped: 'not_configured' };
  const email = (m.email ?? '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, skipped: 'no_email' };
  try {
    const res = await fetch(cfg.dumpUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: cfg.secret, action: 'upsert_member', name: m.name, phone: normalizePhone(m.phone), email }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text().catch(() => '');
    let j: { ok?: boolean; added?: boolean; error?: string } | null = null;
    try {
      j = JSON.parse(text);
    } catch {
      j = null;
    }
    if (!j) return { ok: false, error: 'Apps Script không trả dữ liệu hợp lệ' };
    if (!j.ok) return { ok: false, error: j.error === 'key' ? 'Sai mã bí mật của Apps Script' : (j.error ?? 'Apps Script báo lỗi') };
    return { ok: true, added: !!j.added };
  } catch (e) {
    return { ok: false, error: `Không kết nối được Apps Script: ${e instanceof Error ? e.message : 'lỗi mạng'}` };
  }
}

/** Pulls Members, registrations, classes and schedule from the old Sheet via the dump web app and merges them into the app. */
export async function pullNow(): Promise<PullResult> {
  const cfg = await getSheetSyncCfg();
  const fail = async (error: string): Promise<PullResult> => {
    await patchSheetSyncCfg({ lastPullAt: new Date().toISOString(), lastPullError: error });
    return { ok: false, error, counts: {}, unmatched: [] };
  };
  if (!cfg.dumpUrl || !cfg.secret) return fail('Chưa cấu hình địa chỉ Apps Script đọc Sheet');
  const branchId = cfg.branchId || (await getBotCfg()).branchId;
  if (!branchId) return fail('Chưa chọn chi nhánh cho lớp từ Sheet');
  try {
    const dump = await fetchDump(cfg.dumpUrl, cfg.secret);
    const r = await sync(branchId, dump);
    await patchSheetSyncCfg({ lastPullAt: new Date().toISOString(), lastPullError: null, lastPullCounts: r.counts });
    return r;
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Không đồng bộ được từ Sheet');
  }
}

/** Members tab of the old Sheet as rows, for the one-time import of every Sheet member. */
export async function fetchMemberRows(): Promise<{ name: string; phone: string; email: string; expiry: string; learned: string; remaining: string; lastReg: string; note: string }[]> {
  const cfg = await getSheetSyncCfg();
  if (!cfg.dumpUrl || !cfg.secret) throw new Error('Chưa cấu hình địa chỉ Apps Script đọc Sheet');
  const d = await fetchDump(cfg.dumpUrl, cfg.secret);
  return (d.members ?? []).map((r) => ({ name: cell(r, 0), phone: cell(r, 1), email: cell(r, 2), expiry: cell(r, 3), learned: cell(r, 4), remaining: cell(r, 5), lastReg: cell(r, 6), note: cell(r, 8) }));
}

const LOCK = 'sheetsync:pull:lock';

export function startSheetPullJob() {
  const tick = async () => {
    const cfg = await getSheetSyncCfg();
    if (!cfg.pullOn || !cfg.dumpUrl) return;
    if ((await redis.set(LOCK, '1', 'EX', 240, 'NX')) !== 'OK') return;
    const r = await pullNow();
    if (!r.ok) logger.warn({ error: r.error }, 'sheet pull failed');
  };
  const timer = setInterval(() => {
    tick().catch((e) => logger.error({ err: e }, 'sheet pull job failed'));
  }, 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
