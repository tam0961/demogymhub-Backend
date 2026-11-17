import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { fold, mapStatus, normalizePhone, parseClassLabel, parseCsv, type RegStatus } from '../src/modules/pt/sheet-import';

const file = process.argv[2];
const branchCode = process.argv.find((a) => a.startsWith('--branch='))?.slice(9);
const apply = process.argv.includes('--apply');
if (!file || !branchCode) throw new Error('usage: tsx scripts/import-group-sheet.ts <registrations.csv> --branch=<code> [--apply]');

const prisma = new PrismaClient();
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

interface Row { phone: string; name: string; day: string; start: string; end: string; muscle: string | null; pt: string; status: RegStatus }

async function main() {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: branchCode } });
  const [, ...lines] = parseCsv(fs.readFileSync(file, 'utf8'));
  const unknown = new Map<string, number>();
  const rows: Row[] = [];
  let badLabel = 0;
  for (const c of lines) {
    const label = parseClassLabel(c[4] ?? '');
    const day = (c[5] ?? '').trim();
    if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      badLabel++;
      continue;
    }
    const status = mapStatus(c[9] ?? '') ?? (day >= today ? mapStatus(c[7] ?? '') : null);
    if (!status) {
      unknown.set(c[9] ?? '', (unknown.get(c[9] ?? '') ?? 0) + 1);
      continue;
    }
    rows.push({ phone: normalizePhone(c[2] ?? ''), name: c[1] ?? '', day, start: label.start, end: label.end, muscle: label.muscleGroup, pt: (c[8] ?? '').trim(), status });
  }

  const members = new Map((await prisma.member.findMany({ where: { branchId: branch.id }, select: { id: true, name: true, phone: true, email: true } })).map((m) => [m.phone, m]));
  const trainers = await prisma.user.findMany({ where: { userRoles: { some: { role: { key: 'trainer' } } } }, select: { id: true, name: true } });
  const trainerFor = (pt: string) => {
    const f = fold(pt);
    return f ? trainers.find((t) => fold(t.name).split(' ').pop() === f || fold(t.name).includes(f)) : undefined;
  };

  const missingMembers = new Map<string, string>();
  const missingPts = new Set<string>();
  const classes = new Map<string, { day: string; start: string; end: string; muscle: string | null; pt: string; regs: Row[] }>();
  for (const r of rows) {
    const key = `${r.day}T${r.start}`;
    const cur = classes.get(key) ?? { day: r.day, start: r.start, end: r.end, muscle: r.muscle, pt: r.pt, regs: [] };
    if (!cur.pt && r.pt) cur.pt = r.pt;
    cur.regs.push(r);
    classes.set(key, cur);
  }

  let newClasses = 0;
  let newRegs = 0;
  let skippedRegs = 0;
  for (const c of classes.values()) {
    if (c.pt && !trainerFor(c.pt)) missingPts.add(c.pt);
    const regs = c.regs.filter((r) => {
      if (members.has(r.phone)) return true;
      missingMembers.set(r.phone, r.name);
      return false;
    });
    if (!regs.length) continue;
    const startAt = new Date(`${c.day}T${c.start}:00+07:00`);
    const endAt = new Date(`${c.day}T${c.end}:00+07:00`);
    const hasAttended = regs.some((r) => r.status === 'attended');
    const status = c.day >= today ? 'scheduled' : hasAttended ? 'completed' : 'cancelled';
    let cls = await prisma.groupClass.findFirst({ where: { branchId: branch.id, startAt }, select: { id: true } });
    if (!cls) {
      newClasses++;
      if (apply) cls = await prisma.groupClass.create({ data: { branchId: branch.id, trainerId: trainerFor(c.pt)?.id ?? null, startAt, endAt, muscleGroup: c.muscle, capacity: 3, status, completedAt: status === 'completed' ? endAt : null } });
    }
    for (const r of regs) {
      const m = members.get(r.phone)!;
      const dup = cls ? await prisma.groupRegistration.findFirst({ where: { classId: cls.id, memberId: m.id, status: { not: 'cancelled' } }, select: { id: true } }) : null;
      if (dup && r.status !== 'cancelled') {
        skippedRegs++;
        continue;
      }
      newRegs++;
      if (apply && cls) await prisma.groupRegistration.create({ data: { classId: cls.id, memberId: m.id, name: m.name, phone: m.phone, email: m.email, status: r.status, deducted: false, source: 'sheet' } });
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY-RUN', rows: rows.length, badLabel, newClasses, newRegs, skippedRegs, unknownStatuses: Object.fromEntries(unknown), missingPts: [...missingPts], missingMembers: missingMembers.size }, null, 2));
  if (missingMembers.size) console.log('Members not in the app (by phone):', [...missingMembers.entries()].map(([p, n]) => `${p} ${n}`).slice(0, 50));
}

main().finally(() => prisma.$disconnect());
