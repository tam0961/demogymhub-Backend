import { vnDayOf } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { getSheetSyncCfg } from './config';
import * as pullModule from './pull';

const MAX_ATTEMPTS = 5;
const MEMBER_OK_MS = 10 * 60_000;
const knownInSheet = new Map<string, number>();

interface SheetMemberApi {
  upsertSheetMember?: (m: { name: string; phone: string; email: string | null }) => Promise<{ ok: boolean; added?: boolean; error?: string; skipped?: 'no_email' | 'not_configured' }>;
}

/** Makes sure the member is in the Sheet Members tab (the bridge only accepts known members). Returns null when ready, or the failure to record. */
async function ensureSheetMember(m: { name: string; phone: string; email: string | null }): Promise<{ status: 'skipped' | 'failed'; reason: string } | null> {
  const seen = knownInSheet.get(m.phone);
  if (seen && seen > Date.now()) return null;
  const api = pullModule as unknown as SheetMemberApi;
  if (typeof api.upsertSheetMember !== 'function') return null;
  const r = await api.upsertSheetMember(m);
  if (r.skipped === 'no_email') return { status: 'skipped', reason: 'Hội viên chưa có email, thêm email trong hồ sơ rồi đăng ký lại' };
  if (r.skipped === 'not_configured') return { status: 'failed', reason: 'Chưa cấu hình kéo từ Sheet nên chưa thêm được hội viên vào tab Members' };
  if (!r.ok) return { status: 'failed', reason: `Không thêm được hội viên vào Sheet: ${r.error ?? 'lỗi không rõ'}` };
  knownInSheet.set(m.phone, Date.now() + MEMBER_OK_MS);
  return null;
}

export const _resetSheetMemberCache = () => knownInSheet.clear();
const VN_MS = 7 * 3600_000;

const hm = (d: Date) => new Date(d.getTime() + VN_MS).toISOString().slice(11, 16);
export const sessionKey = (startAt: Date) => `${vnDayOf(startAt)}|${hm(startAt)}`;

const SKIP_REASON: Record<string, string> = {
  no_member: 'Số điện thoại chưa có trong tab Members của Sheet',
  conflict: 'Buổi đã đầy hoặc không còn trong Form của Sheet',
  closed: 'Buổi đã đóng đăng ký bên Sheet',
  duplicate: 'Sheet đã nhận lượt đăng ký này',
  invalid: 'Sheet từ chối dữ liệu đăng ký',
  full: 'Buổi đã đầy bên Sheet',
};
const RETRY_REASON: Record<string, string> = {
  rate: 'Sheet giới hạn tần suất, sẽ thử lại',
  busy: 'Sheet đang bận, sẽ thử lại',
  form: 'Google Form lỗi, sẽ thử lại',
  server: 'Apps Script lỗi, sẽ thử lại',
  network: 'Không kết nối được Apps Script, sẽ thử lại',
  bad_reply: 'Apps Script trả kết quả không hợp lệ, sẽ thử lại',
};

interface BridgeReply {
  ok?: boolean;
  error?: string;
  failed?: { key: string; reason: string }[];
}

async function callBridge(url: string, phone: string, keys: string[]): Promise<BridgeReply> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ phone, keys, website: '' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const j = JSON.parse(await res.text()) as BridgeReply;
    return j && typeof j === 'object' ? j : { ok: false, error: 'bad_reply' };
  } catch (e) {
    if (e instanceof SyntaxError) return { ok: false, error: 'bad_reply' };
    return { ok: false, error: 'network' };
  }
}

/** Queues the registrations (not waitlist, not coming from the Sheet) and sends them. Never throws: Sheet problems are only recorded. */
export async function enqueueSheetWrites(registrationIds: string[]): Promise<void> {
  try {
    if (!registrationIds.length) return;
    const cfg = await getSheetSyncCfg();
    if (!cfg.writeOn || !cfg.bridgeUrl) return;
    const regs = await prisma.groupRegistration.findMany({ where: { id: { in: registrationIds }, source: { not: 'sheet' }, status: 'booked' }, select: { id: true } });
    if (!regs.length) return;
    await prisma.sheetWriteLog.createMany({ data: regs.map((r) => ({ registrationId: r.id, status: 'pending' })), skipDuplicates: true });
    await sendRows(regs.map((r) => r.id));
  } catch (e) {
    logger.error({ err: e }, 'sheet write enqueue failed');
  }
}

/** Sends the given log rows (pending or failed), grouped by member phone so one booking is one call. */
async function sendRows(registrationIds: string[]): Promise<number> {
  const cfg = await getSheetSyncCfg();
  if (!cfg.writeOn || !cfg.bridgeUrl) return 0;
  const logs = await prisma.sheetWriteLog.findMany({
    where: { registrationId: { in: registrationIds }, status: { in: ['pending', 'failed'] }, attempts: { lt: MAX_ATTEMPTS } },
    include: { registration: { select: { id: true, name: true, phone: true, email: true, status: true, member: { select: { email: true } }, class: { select: { startAt: true } } } } },
  });
  const byPhone = new Map<string, typeof logs>();
  for (const l of logs) byPhone.set(l.registration.phone, [...(byPhone.get(l.registration.phone) ?? []), l]);
  let sent = 0;
  for (const [phone, rows] of byPhone) {
    let todo = rows.filter((l) => l.registration.status === 'booked');
    for (const l of rows.filter((x) => x.registration.status !== 'booked')) {
      await prisma.sheetWriteLog.update({ where: { id: l.id }, data: { status: 'skipped', error: 'Đăng ký đã bị hủy trong app, không ghi sang Sheet' } });
    }
    if (todo.length) {
      const first = todo[0].registration;
      const block = await ensureSheetMember({ name: first.name, phone, email: first.member.email ?? first.email });
      if (block) {
        await prisma.sheetWriteLog.updateMany({ where: { id: { in: todo.map((l) => l.id) } }, data: { status: block.status, error: block.reason, attempts: { increment: 1 }, lastAttemptAt: new Date() } });
        todo = [];
      }
    }
    for (let round = 0; round < 3 && todo.length; round++) {
      const keys = todo.map((l) => sessionKey(l.registration.class.startAt));
      const r = await callBridge(cfg.bridgeUrl, phone, keys);
      sent++;
      const now = new Date();
      if (r.ok) {
        await prisma.sheetWriteLog.updateMany({ where: { id: { in: todo.map((l) => l.id) } }, data: { status: 'ok', error: null, attempts: { increment: 1 }, lastAttemptAt: now } });
        break;
      }
      const code = r.error ?? 'server';
      if (code === 'conflict' && r.failed?.length) {
        const bad = new Map(r.failed.map((f) => [f.key, f.reason]));
        const rest: typeof todo = [];
        for (const l of todo) {
          const reason = bad.get(sessionKey(l.registration.class.startAt));
          if (reason) await prisma.sheetWriteLog.update({ where: { id: l.id }, data: { status: 'skipped', error: reason === 'closed' ? SKIP_REASON.closed : SKIP_REASON.full, attempts: { increment: 1 }, lastAttemptAt: now } });
          else rest.push(l);
        }
        todo = rest;
        continue;
      }
      if (SKIP_REASON[code]) {
        await prisma.sheetWriteLog.updateMany({ where: { id: { in: todo.map((l) => l.id) } }, data: { status: 'skipped', error: SKIP_REASON[code], attempts: { increment: 1 }, lastAttemptAt: now } });
      } else {
        await prisma.sheetWriteLog.updateMany({ where: { id: { in: todo.map((l) => l.id) } }, data: { status: 'failed', error: RETRY_REASON[code] ?? RETRY_REASON.server, attempts: { increment: 1 }, lastAttemptAt: now } });
      }
      break;
    }
  }
  return sent;
}

/** Retries pending and failed rows once (used by the job and the manual button). */
export async function retrySheetWrites(): Promise<number> {
  const rows = await prisma.sheetWriteLog.findMany({ where: { status: { in: ['pending', 'failed'] }, attempts: { lt: MAX_ATTEMPTS } }, select: { registrationId: true }, take: 200 });
  return sendRows(rows.map((r) => r.registrationId));
}

export function startSheetRetryJob() {
  const timer = setInterval(() => {
    void (async () => {
      const got = await redis.set('sheetsync:retry:lock', '1', 'EX', 100, 'NX');
      if (got !== 'OK') return;
      await retrySheetWrites();
    })().catch((e) => logger.error({ err: e }, 'sheet retry failed'));
  }, 120_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function writeSummary() {
  const counts = await prisma.sheetWriteLog.groupBy({ by: ['status'], _count: { _all: true } });
  const rows = await prisma.sheetWriteLog.findMany({
    where: { status: { in: ['failed', 'skipped'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, status: true, error: true, attempts: true, createdAt: true, registration: { select: { name: true, phone: true, class: { select: { startAt: true } } } } },
  });
  return {
    counts: { pending: 0, ok: 0, failed: 0, skipped: 0, ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])) } as Record<string, number>,
    problems: rows.map((r) => ({ id: r.id, status: r.status, reason: r.error, attempts: r.attempts, member_name: r.registration.name, phone: r.registration.phone, class_date: vnDayOf(r.registration.class.startAt), class_start: hm(r.registration.class.startAt), created_at: r.createdAt.toISOString() })),
  };
}
