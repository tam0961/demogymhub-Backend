import { dateOnly, dayRange, todayVN } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { getBotCfg, parseWindows } from '../zalobot/config';
import { syncZaloShifts } from './shared';
import { fmtDM, lastWord, parseShiftMessage } from './zalo-shift';

export async function branchTrainers(branchId: string) {
  return prisma.user.findMany({
    where: { status: 'active', userRoles: { some: { role: { key: 'trainer' }, OR: [{ branchId }, { branchId: null }] } } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

const minutesOf = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));

export interface ShiftReply {
  handled: boolean;
  date?: string;
  reply: string | null;
  results?: { trainer: string; added: number; removed: number; reopened: number; off: boolean }[];
  errors?: string[];
  missing?: string[];
}

/** Reads a PT shift message and writes the 1:1 slots; shared by the HTTP bot endpoint and the built-in Zalo bot. */
export async function applyShiftMessage(branchId: string, text: string, sentAt: Date): Promise<ShiftReply> {
  const parsed = parseShiftMessage(text, sentAt);
  if (!parsed) return { handled: false, reply: null };
  const today = todayVN(new Date());
  if (parsed.date < today) return { handled: true, date: parsed.date, reply: `Bỏ qua ca ngày ${fmtDM(parsed.date)} vì đã qua.`, results: [], errors: [] };
  const cfg = await getBotCfg();
  const windows = parseWindows(cfg.groupWindows);
  const groupKey = cfg.groupTrainer ? lastWord(cfg.groupTrainer) : '';
  const trainers = await branchTrainers(branchId);
  const results: NonNullable<ShiftReply['results']> = [];
  const errors: string[] = [];
  const reported = new Set<string>();
  for (const entry of parsed.entries) {
    const found = trainers.filter((t) => lastWord(t.name) === lastWord(entry.name));
    if (found.length === 0) {
      errors.push(`Chưa có PT "${entry.name}" trong DemoGym.`);
      continue;
    }
    if (found.length > 1) {
      errors.push(`Có nhiều PT trùng tên "${entry.name}".`);
      continue;
    }
    const t = found[0];
    const hours = groupKey && lastWord(t.name) === groupKey ? entry.hours.filter((h) => !windows.some(([a, b]) => minutesOf(h) >= a && minutesOf(h) < b)) : entry.hours;
    const r = await syncZaloShifts(branchId, t.id, parsed.date, entry.off ? [] : hours);
    const offKey = { trainerId: t.id, branchId, date: dateOnly(parsed.date) };
    if (entry.off) await prisma.ptDayOff.upsert({ where: { trainerId_branchId_date: offKey }, create: offKey, update: {} });
    else await prisma.ptDayOff.deleteMany({ where: offKey });
    reported.add(t.id);
    await prisma.botSent.upsert({ where: { key: `rep:${parsed.date}:${t.id}` }, create: { key: `rep:${parsed.date}:${t.id}` }, update: {} });
    results.push({ trainer: t.name, off: entry.off, ...r });
  }
  const day = dayRange(parsed.date);
  const withShifts = await prisma.ptSession.findMany({
    where: { branchId, startAt: { gte: day.gte, lt: day.lt }, status: { not: 'cancelled' } },
    select: { trainerId: true },
    distinct: ['trainerId'],
  });
  const have = new Set([...reported, ...withShifts.map((s) => s.trainerId)]);
  const missing = trainers.filter((t) => !have.has(t.id)).map((t) => t.name);
  const head = `Đã ghi nhận ca ngày ${fmtDM(parsed.date)}`;
  const tail = missing.length ? `Còn thiếu: ${missing.join(', ')}.` : `Đã đủ cho ${trainers.length} PT.`;
  const reply = [results.length ? `${head}. ${tail}` : null, ...errors].filter(Boolean).join('\n') || null;
  return { handled: true, date: parsed.date, reply, results, errors, missing };
}
