import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { fmtDate, vnDayOf } from '../../lib/dates';
import { overdueDays } from '../contracts/service';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';
import { evaluateCheckin } from '../checkins/routes';

const uuid = z.string().uuid();

const scanBus = new EventEmitter();
scanBus.setMaxListeners(500);

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface RawPunch {
  employeeNo: string;
  at: Date;
}

function parseTime(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseHikvision(body: unknown): RawPunch | null {
  let obj: unknown = body;
  if (Buffer.isBuffer(body)) {
    const text = body.toString('latin1');
    const ev = text.search(/name="event_log"/);
    obj = extractJson(ev >= 0 ? text.slice(ev) : text);
    if (!obj) {
      const emp = /<employeeNoString>([^<]+)</.exec(text)?.[1];
      const dt = /<dateTime>([^<]+)</.exec(text)?.[1];
      const at = parseTime(dt);
      return emp && at ? { employeeNo: emp.trim(), at } : null;
    }
  }
  const o = obj as { dateTime?: string; AccessControllerEvent?: { employeeNoString?: string; employeeNo?: number | string } } | null;
  const ace = o?.AccessControllerEvent;
  const emp = ace?.employeeNoString ?? (ace?.employeeNo !== undefined ? String(ace.employeeNo) : '');
  const at = parseTime(o?.dateTime);
  if (!emp || !at) return null;
  return { employeeNo: emp.trim(), at };
}

export async function recordPunch(deviceId: string | null, p: RawPunch, source = 'device', createdBy: string | null = null) {
  const user = await prisma.user.findUnique({ where: { employeeNo: p.employeeNo }, select: { id: true } });
  const dupe = await prisma.staffPunch.findFirst({
    where: { employeeNo: p.employeeNo, punchedAt: { gte: new Date(p.at.getTime() - 30_000), lte: new Date(p.at.getTime() + 30_000) } },
    select: { id: true },
  });
  if (dupe) return null;
  return prisma.staffPunch.create({ data: { deviceId, userId: user?.id ?? null, employeeNo: p.employeeNo, punchedAt: p.at, source, createdBy } });
}

const ENROLL_RANGE = /^8\d{6}$/;

/** Employee number written to the device for people enrolled from DemoGym, in ranges NextX does not use:
 * "8" + 6 digits for HV codes (HV1453 -> 8001453), "9" + 6 digits for any other prefix (GH1000 -> 9001000). */
export function deviceEmpNo(code: string, faceId: string | null): string {
  const digits = code.replace(/\D/g, '');
  if (digits && digits.length <= 6) return `${/^HV/i.test(code) ? '8' : '9'}${digits.padStart(6, '0')}`;
  return faceId ?? code;
}

export async function findMemberForScan(emp: string) {
  const digits = emp.replace(/\D/g, '');
  const enrolled = ENROLL_RANGE.test(emp) ? [{ code: { equals: `HV${String(parseInt(emp.slice(1), 10)).padStart(4, '0')}`, mode: 'insensitive' as const } }] : [];
  return prisma.member.findFirst({
    where: { OR: [{ faceId: emp }, { code: { equals: emp, mode: 'insensitive' } }, ...enrolled, ...(digits.length >= 8 ? [{ phone: digits }] : [])] },
    select: { id: true },
  });
}

export async function routeScan(device: { id: string; branchId: string }, p: RawPunch) {
  const staff = await prisma.user.findUnique({ where: { employeeNo: p.employeeNo }, select: { id: true } });
  if (staff) return recordPunch(device.id, p);
  const recent = await prisma.faceEvent.findFirst({
    where: { branchId: device.branchId, employeeNo: p.employeeNo, scannedAt: { gte: new Date(Date.now() - 10_000) } },
    select: { id: true },
  });
  if (recent) return null;
  const ref = await findMemberForScan(p.employeeNo);
  if (!ref) await recordPunch(device.id, p);
  let result: string | null = null;
  let reason: string | null = null;
  let checkinId: string | null = null;
  if (ref) {
    const member = await prisma.member.findUniqueOrThrow({ where: { id: ref.id } });
    try {
      const o = await evaluateCheckin({ userId: null }, member, device.branchId);
      result = o.result;
      reason = o.reason;
      checkinId = o.checkinId;
    } catch {
      result = 'denied';
      reason = 'ERROR';
    }
  }
  const created = await prisma.faceEvent.create({ data: { deviceId: device.id, branchId: device.branchId, employeeNo: p.employeeNo, memberId: ref?.id ?? null, result, reason, checkinId, scannedAt: new Date() } });
  scanBus.emit('scan');
  return created;
}

export const attendancePublicRouter = Router();

attendancePublicRouter.post('/hikvision/:key', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
  const device = await prisma.staffDevice.findUnique({ where: { deviceKey: String(req.params.key) } });
  if (!device) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown device' } });
    return;
  }
  await prisma.staffDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  if (device.paused) {
    res.json({ status: 'paused' });
    return;
  }
  const parsed = parseHikvision(req.body);
  if (parsed) await routeScan(device, parsed);
  res.json({ status: 'ok' });
});

attendancePublicRouter.get('/ping/:key', async (req, res) => {
  const device = await prisma.staffDevice.findUnique({ where: { deviceKey: String(req.params.key) }, select: { id: true, paused: true } });
  if (!device) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown device' } });
    return;
  }
  await prisma.staffDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  res.json({ status: 'ok', paused: device.paused });
});

attendancePublicRouter.get('/jobs/:key', async (req, res) => {
  const device = await prisma.staffDevice.findUnique({ where: { deviceKey: String(req.params.key) } });
  if (!device) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown device' } });
    return;
  }
  await prisma.staffDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  if (device.paused) {
    res.json({ data: [], paused: true });
    return;
  }
  const stale = new Date(Date.now() - 3 * 60_000);
  const jobs = await prisma.faceJob.findMany({
    where: { deviceId: device.id, OR: [{ status: 'pending' }, { status: 'claimed', claimedAt: { lt: stale } }] },
    orderBy: { createdAt: 'asc' },
    take: 3,
  });
  const out = [];
  for (const j of jobs) {
    await prisma.faceJob.update({ where: { id: j.id }, data: { status: 'claimed', claimedAt: new Date() } });
    const m = await prisma.member.findUnique({ where: { id: j.memberId }, select: { code: true, name: true, faceId: true } });
    const photo = await prisma.memberPhoto.findUnique({ where: { memberId: j.memberId } });
    const last = await prisma.contract.findFirst({ where: { memberId: j.memberId, status: { in: ['active', 'frozen'] }, endDate: { not: null } }, orderBy: { endDate: 'desc' }, select: { endDate: true } });
    if (!m) continue;
    out.push({
      id: j.id,
      employee_no: deviceEmpNo(m.code, m.faceId),
      name: m.name,
      valid_to: last?.endDate ? last.endDate.toISOString().slice(0, 10) : null,
      photo: photo ? Buffer.from(photo.data).toString('base64') : null,
    });
  }
  res.json({ data: out, paused: false });
});

attendancePublicRouter.post('/jobs/:key/done', express.json(), async (req, res) => {
  const device = await prisma.staffDevice.findUnique({ where: { deviceKey: String(req.params.key) } });
  if (!device) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown device' } });
    return;
  }
  const b = z.object({ id: uuid, ok: z.boolean(), message: z.string().max(300).optional() }).parse(req.body);
  await prisma.faceJob.updateMany({ where: { id: b.id, deviceId: device.id }, data: { status: b.ok ? 'done' : 'failed', message: b.message ?? null, finishedAt: new Date() } });
  res.json({ status: 'ok' });
});

attendancePublicRouter.post('/facepush/:key', async (req, res) => {
  const device = await prisma.staffDevice.findUnique({ where: { deviceKey: String(req.params.key) } });
  if (!device) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown device' } });
    return;
  }
  if (device.paused) {
    res.json({ data: { result: 'paused' } });
    return;
  }
  const b = z.object({ employee_no: z.string().trim().min(1).max(40), photo: z.string().max(280_000).optional() }).parse(req.body);
  const m = await findMemberForScan(b.employee_no);
  if (!m) {
    res.json({ data: { result: 'no_match' } });
    return;
  }
  const full = await prisma.member.findUnique({ where: { id: m.id }, select: { id: true, branchId: true } });
  if (!full || full.branchId !== device.branchId) {
    res.json({ data: { result: 'other_branch' } });
    return;
  }
  if (!b.photo) {
    res.json({ data: { result: 'no_photo' } });
    return;
  }
  const has = await prisma.memberPhoto.findUnique({ where: { memberId: full.id }, select: { memberId: true } });
  if (has) {
    res.json({ data: { result: 'has_photo' } });
    return;
  }
  const buf = Buffer.from(b.photo, 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    res.json({ data: { result: 'bad_image' } });
    return;
  }
  await prisma.memberPhoto.create({ data: { memberId: full.id, contentType: 'image/jpeg', data: buf } });
  res.json({ data: { result: 'saved' } });
});

async function scanMemberView(memberId: string, branchId: string, todayStr: string) {
  const m = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true, code: true, name: true, phone: true, status: true, branchId: true } });
  if (!m) return null;
  const photo = await prisma.memberPhoto.findUnique({ where: { memberId: m.id }, select: { updatedAt: true } });
  const contracts = await prisma.contract.findMany({
    where: { memberId: m.id, status: { notIn: ['draft', 'cancelled'] } },
    select: { id: true, code: true, status: true, totalAmount: true, paidAmount: true, endDate: true, startDate: true, paymentDueDate: true, sessionsTotal: true, sessionsLeft: true, ptName: true, package: { select: { name: true, category: true, checkinBefore: true } }, packageName: true },
    orderBy: [{ endDate: { sort: 'desc', nulls: 'first' } }],
  });
  const mc = contracts.find((c) => c.package.category === 'member');
  const debt = contracts.reduce((a, c) => a + Math.max(c.totalAmount - c.paidAmount, 0), 0);
  const debtC = contracts.filter((c) => c.totalAmount > c.paidAmount).sort((a, b) => b.totalAmount - b.paidAmount - (a.totalAmount - a.paidAmount))[0];
  const ptC = contracts.find((c) => c.package.category !== 'member' && c.sessionsTotal != null && c.status !== 'expired');
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { code: true, name: true } });
  const lastIn = await prisma.checkin.findFirst({ where: { memberId: m.id, result: 'allowed', checkedInAt: { lt: new Date(`${todayStr}T00:00:00+07:00`) } }, orderBy: { checkedInAt: 'desc' }, select: { checkedInAt: true } });
  const outsideWhere = mc ? { memberId: m.id, contractId: mc.id, reason: 'OUTSIDE_HOURS' } : null;
  const [outsideCount, outsideRows] = outsideWhere
    ? await Promise.all([prisma.checkin.count({ where: outsideWhere }), prisma.checkin.findMany({ where: outsideWhere, orderBy: { checkedInAt: 'desc' }, take: 5, select: { checkedInAt: true } })])
    : [0, []];
  const endStr = mc?.endDate ? mc.endDate.toISOString().slice(0, 10) : null;
  const state = !mc ? 'no_package' : mc.status === 'frozen' ? 'frozen' : mc.status === 'expired' || (endStr && endStr < todayStr) ? 'expired' : mc.startDate && mc.startDate.toISOString().slice(0, 10) > todayStr ? 'not_started' : 'ok';
  return {
      id: m.id,
      code: m.code,
      name: m.name,
      phone: m.phone,
      branch_id: m.branchId,
      has_photo: !!photo,
      photo_version: photo ? photo.updatedAt.getTime() : null,
      package_name: mc ? (mc.packageName ?? mc.package.name) : null,
      end_date: endStr,
      state,
      sessions_left: mc?.sessionsTotal != null ? mc.sessionsLeft : null,
      debt,
      branch,
      contract_id: mc?.id ?? null,
      checkin_before: mc?.package.checkinBefore ?? null,
      last_checkin_at: lastIn ? lastIn.checkedInAt.toISOString() : null,
      outside_count: outsideCount,
      outside_at: outsideRows.map((r) => r.checkedInAt.toISOString()),
      debt_contract: debtC ? { id: debtC.id, code: debtC.code, amount: debtC.totalAmount - debtC.paidAmount, due_date: fmtDate(debtC.paymentDueDate), overdue_days: overdueDays(debtC, todayStr) } : null,
      pt: ptC ? { package_name: ptC.packageName ?? ptC.package.name, sessions_left: ptC.sessionsLeft, sessions_total: ptC.sessionsTotal, pt_name: ptC.ptName } : null,
  };
}

export const attendanceRouter = Router();
attendanceRouter.use(authenticate);

attendanceRouter.get('/scans', authorize('checkins.read'), async (req, res) => {
  const q = z.object({ since: z.string().datetime({ offset: true }).optional(), wait: z.coerce.number().int().min(0).max(25).optional() }).parse(req.query);
  const bf = branchFilter(req);
  let now = new Date();
  const since = q.since ? new Date(q.since) : new Date(now.getTime() - 20_000);
  const fetchRows = () => prisma.faceEvent.findMany({ where: { ...bf, scannedAt: { gt: since } }, orderBy: { scannedAt: 'asc' }, take: 5 });
  let rows = await fetchRows();
  if (!rows.length && q.wait) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        scanBus.off('scan', done);
        req.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, q.wait! * 1000);
      scanBus.on('scan', done);
      req.on('close', done);
    });
    if (!req.destroyed) {
      now = new Date();
      rows = await fetchRows();
    }
  }
  const todayStr = vnDayOf(now);
  const items = [];
  for (const e of rows) {
    const base = { id: e.id, employee_no: e.employeeNo, scanned_at: e.scannedAt.toISOString(), result: e.result, reason: e.reason };
    if (!e.memberId) {
      items.push({ ...base, member: null });
      continue;
    }
    const member = await scanMemberView(e.memberId, e.branchId, todayStr);
    items.push({ ...base, member });
  }
  const devices = await prisma.staffDevice.findMany({ where: bf, select: { lastSeenAt: true, paused: true } });
  const paused = devices.length ? devices.every((d) => d.paused) : null;
  const bridgeOk = devices.length ? devices.some((d) => d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < 90_000) : null;
  res.json({ data: { now: now.toISOString(), items, bridge_ok: bridgeOk, paused } });
});

attendanceRouter.get('/scan-preview', authorize('checkins.read'), async (req, res) => {
  const q = z.object({ member_id: uuid }).parse(req.query);
  const m = await prisma.member.findUnique({ where: { id: q.member_id }, select: { branchId: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const member = await scanMemberView(q.member_id, m.branchId, vnDayOf(new Date()));
  res.json({ data: { member } });
});

attendanceRouter.post('/face-jobs', authorize('members.update'), async (req, res) => {
  const b = z.object({ member_id: uuid, consent: z.literal(true) }).parse(req.body);
  const m = await prisma.member.findUnique({ where: { id: b.member_id }, select: { id: true, name: true, branchId: true, faceId: true, code: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const photo = await prisma.memberPhoto.findUnique({ where: { memberId: m.id }, select: { memberId: true } });
  if (!photo) throw conflict('NO_PHOTO', 'Member has no face photo');
  const devices = await prisma.staffDevice.findMany({ where: { branchId: m.branchId }, select: { id: true } });
  if (!devices.length) throw conflict('NO_DEVICE', 'No attendance device for this branch');
  if (!m.faceId) {
    const emp = deviceEmpNo(m.code, null);
    const taken = await prisma.member.findFirst({ where: { faceId: emp, id: { not: m.id } }, select: { id: true } });
    if (taken) throw conflict('FACE_ID_TAKEN', 'Device number already used by another member');
    await prisma.member.update({ where: { id: m.id }, data: { faceId: emp } });
  }
  await prisma.faceJob.updateMany({ where: { memberId: m.id, status: { in: ['pending', 'claimed'] } }, data: { status: 'failed', message: 'Replaced by a newer request', finishedAt: new Date() } });
  const jobs = await Promise.all(devices.map((d) => prisma.faceJob.create({ data: { deviceId: d.id, memberId: m.id, createdBy: req.auth!.userId } })));
  await audit(req.auth!.userId, 'face.enroll_requested', { member_id: m.id, consent: true, devices: devices.length }, req.ip, m.id);
  res.status(201).json({ data: jobs.map((j) => ({ id: j.id, status: j.status })) });
});

attendanceRouter.get('/face-jobs', authorize('members.read'), async (req, res) => {
  const q = z.object({ member_id: uuid }).parse(req.query);
  const m = await prisma.member.findUnique({ where: { id: q.member_id }, select: { branchId: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const rows = await prisma.faceJob.findMany({ where: { memberId: q.member_id }, orderBy: { createdAt: 'desc' }, take: 6 });
  const devs = await prisma.staffDevice.findMany({ where: { id: { in: rows.map((r) => r.deviceId) } }, select: { id: true, name: true } });
  const name = new Map(devs.map((d) => [d.id, d.name]));
  res.json({ data: rows.map((r) => ({ id: r.id, device_name: name.get(r.deviceId) ?? '', status: r.status, message: r.message, created_at: r.createdAt.toISOString(), finished_at: r.finishedAt?.toISOString() ?? null })) });
});

attendanceRouter.get('/devices', authorize('devices.manage'), async (req, res) => {
  const rows = await prisma.staffDevice.findMany({ where: branchFilter(req), orderBy: { createdAt: 'asc' }, include: { branch: { select: { name: true } } } });
  res.json({
    data: rows.map((d) => ({
      id: d.id,
      name: d.name,
      branch_id: d.branchId,
      branch_name: d.branch.name,
      device_key: d.deviceKey,
      last_seen_at: d.lastSeenAt?.toISOString() ?? null,
      paused: d.paused,
    })),
  });
});

attendanceRouter.post('/devices', authorize('devices.manage'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(60), branch_id: uuid.optional() }).parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  const d = await prisma.staffDevice.create({ data: { name: b.name, branchId, deviceKey: randomBytes(16).toString('hex') } });
  await audit(req.auth!.userId, 'attendance.device_created', { device_id: d.id, name: d.name }, req.ip, d.id);
  res.status(201).json({ data: { id: d.id, name: d.name, branch_id: d.branchId, device_key: d.deviceKey, last_seen_at: null } });
});

attendanceRouter.put('/devices/:id/pause', authorize('devices.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ paused: z.boolean() }).parse(req.body);
  const d = await prisma.staffDevice.findUnique({ where: { id } });
  if (!d || !branchAllowed(req.access!, d.branchId)) throw notFound('Device not found');
  await prisma.staffDevice.update({ where: { id }, data: { paused: b.paused } });
  await audit(req.auth!.userId, b.paused ? 'attendance.device_paused' : 'attendance.device_resumed', { device_id: id, name: d.name }, req.ip, id);
  res.json({ data: { id, paused: b.paused } });
});

attendanceRouter.delete('/devices/:id', authorize('devices.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const d = await prisma.staffDevice.findUnique({ where: { id } });
  if (!d || !branchAllowed(req.access!, d.branchId)) throw notFound('Device not found');
  await prisma.staffDevice.delete({ where: { id } });
  await audit(req.auth!.userId, 'attendance.device_deleted', { device_id: id, name: d.name }, req.ip, id);
  res.json({ data: { ok: true } });
});

attendanceRouter.put('/staff/:userId', authorize('attendance.manage'), async (req, res) => {
  const userId = uuid.parse(req.params.userId);
  const b = z.object({ employee_no: z.string().trim().min(1).max(30).nullable() }).parse(req.body);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw notFound('User not found');
  if (b.employee_no) {
    const taken = await prisma.user.findFirst({ where: { employeeNo: b.employee_no, id: { not: userId } }, select: { id: true } });
    if (taken) throw badRequest('EMPLOYEE_NO_TAKEN', 'Employee number already used by another user');
  }
  await prisma.user.update({ where: { id: userId }, data: { employeeNo: b.employee_no } });
  if (b.employee_no) await prisma.staffPunch.updateMany({ where: { employeeNo: b.employee_no, userId: null }, data: { userId } });
  await audit(req.auth!.userId, 'attendance.employee_no_set', { employee_no: b.employee_no }, req.ip, userId);
  res.json({ data: { user_id: userId, employee_no: b.employee_no } });
});

const monthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), branch_id: uuid.optional() });

attendanceRouter.get('/summary', authorize('attendance.read'), async (req, res) => {
  const q = monthSchema.parse(req.query);
  const from = new Date(`${q.month}-01T00:00:00+07:00`);
  const [y, m] = q.month.split('-').map(Number);
  const to = new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+07:00`);
  const bf = branchFilter(req, q.branch_id);
  const deviceWhere: Prisma.StaffPunchWhereInput = bf.branchId ? { OR: [{ device: { branchId: bf.branchId } }, { deviceId: null }] } : {};
  const punches = await prisma.staffPunch.findMany({
    where: { punchedAt: { gte: from, lt: to }, ...deviceWhere },
    orderBy: { punchedAt: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  });
  type Day = { date: string; first: string; last: string; count: number; hours: number };
  const staff = new Map<string, { user_id: string | null; name: string; employee_no: string; days: Map<string, Day> }>();
  for (const p of punches) {
    const k = p.userId ?? `emp:${p.employeeNo}`;
    let s = staff.get(k);
    if (!s) {
      s = { user_id: p.userId, name: p.user?.name ?? `Chưa gán (mã ${p.employeeNo})`, employee_no: p.employeeNo, days: new Map() };
      staff.set(k, s);
    }
    const date = vnDayOf(p.punchedAt);
    const iso = p.punchedAt.toISOString();
    const d = s.days.get(date);
    if (!d) s.days.set(date, { date, first: iso, last: iso, count: 1, hours: 0 });
    else {
      d.last = iso;
      d.count++;
    }
  }
  const data = [...staff.values()].map((s) => {
    const days = [...s.days.values()].map((d) => ({ ...d, hours: d.count > 1 ? Math.round(((Date.parse(d.last) - Date.parse(d.first)) / 3600000) * 100) / 100 : 0 }));
    return {
      user_id: s.user_id,
      name: s.name,
      employee_no: s.employee_no,
      linked: !!s.user_id,
      days,
      total_days: days.length,
      total_hours: Math.round(days.reduce((a, d) => a + d.hours, 0) * 100) / 100,
    };
  });
  data.sort((a, b) => Number(b.linked) - Number(a.linked) || a.name.localeCompare(b.name));
  res.json({ data });
});

attendanceRouter.get('/staff', authorize('attendance.read'), async (_req, res) => {
  const rows = await prisma.user.findMany({ where: { employeeNo: { not: null } }, select: { id: true, name: true, employeeNo: true }, orderBy: { name: 'asc' } });
  res.json({ data: rows.map((u) => ({ user_id: u.id, name: u.name, employee_no: u.employeeNo })) });
});

attendanceRouter.post('/punches', authorize('attendance.manage'), async (req, res) => {
  const b = z.object({ user_id: uuid, punched_at: z.string().datetime({ offset: true }) }).parse(req.body);
  const u = await prisma.user.findUnique({ where: { id: b.user_id }, select: { id: true, employeeNo: true } });
  if (!u) throw notFound('User not found');
  const p = await prisma.staffPunch.create({
    data: { userId: u.id, employeeNo: u.employeeNo ?? '-', punchedAt: new Date(b.punched_at), source: 'manual', createdBy: req.auth!.userId },
  });
  await audit(req.auth!.userId, 'attendance.punch_added', { user_id: u.id, punched_at: b.punched_at }, req.ip, p.id);
  res.status(201).json({ data: { id: p.id } });
});

attendanceRouter.get('/punches', authorize('attendance.read'), async (req, res) => {
  const q = z.object({ user_id: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  const from = new Date(`${q.date}T00:00:00+07:00`);
  const rows = await prisma.staffPunch.findMany({
    where: { userId: q.user_id, punchedAt: { gte: from, lt: new Date(from.getTime() + 86400000) } },
    orderBy: { punchedAt: 'asc' },
  });
  res.json({ data: rows.map((r) => ({ id: r.id, punched_at: r.punchedAt.toISOString(), source: r.source })) });
});

attendanceRouter.delete('/punches/:id', authorize('attendance.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const p = await prisma.staffPunch.findUnique({ where: { id } });
  if (!p) throw notFound('Punch not found');
  await prisma.staffPunch.delete({ where: { id } });
  await audit(req.auth!.userId, 'attendance.punch_deleted', { punch_id: id, user_id: p.userId }, req.ip, id);
  res.json({ data: { ok: true } });
});
