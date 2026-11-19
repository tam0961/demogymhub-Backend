import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { vnDayOf } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';

const uuid = z.string().uuid();

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

export const attendancePublicRouter = Router();

attendancePublicRouter.post('/hikvision/:key', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
  const device = await prisma.staffDevice.findUnique({ where: { deviceKey: String(req.params.key) } });
  if (!device) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown device' } });
    return;
  }
  await prisma.staffDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  const parsed = parseHikvision(req.body);
  if (parsed) await recordPunch(device.id, parsed);
  res.json({ status: 'ok' });
});

export const attendanceRouter = Router();
attendanceRouter.use(authenticate);

attendanceRouter.get('/devices', authorize('attendance.manage'), async (req, res) => {
  const rows = await prisma.staffDevice.findMany({ where: branchFilter(req), orderBy: { createdAt: 'asc' }, include: { branch: { select: { name: true } } } });
  res.json({
    data: rows.map((d) => ({
      id: d.id,
      name: d.name,
      branch_id: d.branchId,
      branch_name: d.branch.name,
      device_key: d.deviceKey,
      last_seen_at: d.lastSeenAt?.toISOString() ?? null,
    })),
  });
});

attendanceRouter.post('/devices', authorize('attendance.manage'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(60), branch_id: uuid.optional() }).parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  const d = await prisma.staffDevice.create({ data: { name: b.name, branchId, deviceKey: randomBytes(16).toString('hex') } });
  await audit(req.auth!.userId, 'attendance.device_created', { device_id: d.id, name: d.name }, req.ip, d.id);
  res.status(201).json({ data: { id: d.id, name: d.name, branch_id: d.branchId, device_key: d.deviceKey, last_seen_at: null } });
});

attendanceRouter.delete('/devices/:id', authorize('attendance.manage'), async (req, res) => {
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
