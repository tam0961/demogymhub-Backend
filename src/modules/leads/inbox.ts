import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hit } from '../../lib/redis';

const KEYS = 'leads.inbox_keys';
const KEY_RE = /^[A-Za-z0-9]{32,64}$/;

export interface InboxKey {
  id: string;
  hash: string;
  branch_id: string;
  label: string;
  created_at: string;
  last_at: string | null;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newInboxKey = () => crypto.randomBytes(24).toString('hex');

export async function getInboxKeys(): Promise<InboxKey[]> {
  const row = await prisma.setting.findUnique({ where: { key: KEYS } });
  return Array.isArray(row?.value) ? (row!.value as unknown as InboxKey[]) : [];
}
export async function saveInboxKeys(list: InboxKey[]) {
  const value = list as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: KEYS }, create: { key: KEYS, value }, update: { value } });
}
export async function createInboxKey(branchId: string, label: string) {
  const key = newInboxKey();
  const list = await getInboxKeys();
  const item: InboxKey = { id: crypto.randomUUID(), hash: sha(key), branch_id: branchId, label: label.slice(0, 60), created_at: new Date().toISOString(), last_at: null };
  await saveInboxKeys([...list, item].slice(-10));
  return { key, item };
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const COL = {
  name: /(^|\s)(ten|ho ten|ho va ten|name|khach hang)(\s|$)/,
  phone: /(sdt|so dien thoai|dien thoai|phone|zalo|mobile)/,
  email: /(email|mail)/,
  source: /(nguon|source|chien dich|campaign)/,
  note: /(ghi chu|note|nhu cau|loi nhan|noi dung)/,
};

/** Sheet columns -> lead fields. Columns not recognised are appended to the note. */
export function mapLeadFields(fields: Record<string, string>) {
  const out = { name: '', phone: '', email: '', source: '', note: [] as string[] };
  for (const [k, v] of Object.entries(fields)) {
    const val = String(v ?? '').trim();
    if (!val) continue;
    const c = fold(k);
    if (!out.phone && COL.phone.test(c)) out.phone = val;
    else if (!out.email && COL.email.test(c)) out.email = val;
    else if (!out.name && COL.name.test(c)) out.name = val;
    else if (!out.source && COL.source.test(c)) out.source = val;
    else if (COL.note.test(c)) out.note.push(val);
    else out.note.push(`${k}: ${val}`);
  }
  return out;
}

const normPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.startsWith('84') && d.length === 11 ? `0${d.slice(2)}` : d;
};

async function auth(key: string): Promise<{ item: InboxKey; list: InboxKey[] }> {
  if (!KEY_RE.test(key)) throw new HttpError(403, 'KEY_INVALID', 'Invalid key');
  const h = sha(key);
  const list = await getInboxKeys();
  const item = list.find((k) => k.hash === h);
  if (!item) throw new HttpError(403, 'KEY_INVALID', 'Invalid key');
  return { item, list };
}

export const leadsInboxRouter = Router();

leadsInboxRouter.use(async (req, _res, next) => {
  if (req.method !== 'POST' || (req.path !== '/in' && req.path !== '/signed')) return next();
  const { count } = await hit(`leadin:rl:${req.ip}`, 60);
  if (count > 120) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests'));
  next();
});

const inSchema = z.object({ ext: z.string().trim().min(1).max(200), fields: z.record(z.string(), z.unknown()) });

/** Google Sheet pushes one row. The key decides the branch; ext keeps a row from being added twice. */
leadsInboxRouter.post('/in', async (req, res) => {
  const { item, list } = await auth(String(req.query.key ?? ''));
  const b = inSchema.parse(req.body);
  const clean: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(b.fields)) {
    if (n++ >= 40) break;
    clean[k.slice(0, 80)] = String(v ?? '').slice(0, 500);
  }
  const f = mapLeadFields(clean);
  const phone = normPhone(f.phone);
  if (!/^\d{9,15}$/.test(phone)) throw new HttpError(422, 'PHONE_REQUIRED', 'The row has no valid phone number');
  const ext = `${item.id}:${b.ext}`;
  if (await prisma.lead.findUnique({ where: { ext }, select: { id: true } })) return res.json({ ok: true, dup: true });
  const lead = await prisma.lead.create({
    data: { name: (f.name || phone).slice(0, 100), phone, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email) ? f.email.toLowerCase() : null, source: (f.source || 'Google Sheet').slice(0, 100), note: f.note.join(' | ').slice(0, 1000) || null, branchId: item.branch_id, ext },
  });
  item.last_at = new Date().toISOString();
  await saveInboxKeys(list);
  res.json({ ok: true, id: lead.id });
});

const signedSchema = z.object({ rows: z.array(z.object({ phone: z.string().max(30), date: z.string().max(10).optional() })).max(300) });
const dayNum = (s: string) => Date.parse(`${s}T00:00:00Z`) / 864e5;

/** Which of these phones already have a signed contract: the member by phone, contract not cancelled, signed on or after the lead date and within 120 days. */
leadsInboxRouter.post('/signed', async (req, res) => {
  await auth(String(req.query.key ?? ''));
  const b = signedSchema.parse(req.body);
  const rows = b.rows.map((r) => ({ phone: normPhone(r.phone), date: /^\d{4}-\d\d-\d\d$/.test(r.date ?? '') ? (r.date as string) : '' })).filter((r) => /^0\d{9}$/.test(r.phone));
  if (!rows.length) return res.json({ signed: {} });
  const members = await prisma.member.findMany({ where: { phone: { in: [...new Set(rows.map((r) => r.phone))] } }, select: { id: true, phone: true } });
  const byPhone = new Map(members.map((m) => [m.phone, m.id]));
  const contracts = await prisma.contract.findMany({ where: { memberId: { in: members.map((m) => m.id) }, status: { not: 'cancelled' }, signedAt: { not: null } }, select: { memberId: true, signedAt: true } });
  const out: Record<string, string> = {};
  for (const r of rows) {
    const id = byPhone.get(r.phone);
    if (!id) continue;
    const days = contracts.filter((c) => c.memberId === id).map((c) => c.signedAt!.toISOString().slice(0, 10)).filter((d) => !r.date || (d >= r.date && dayNum(d) - dayNum(r.date) <= 120)).sort();
    if (days[0]) out[r.phone] = days[0];
  }
  res.json({ signed: out });
});
