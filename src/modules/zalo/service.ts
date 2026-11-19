import type { Prisma } from '@prisma/client';
import { addDays, dateOnly, todayVN } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';

export const ZNS_EVENTS = ['new_contract', 'renewal', 'expiring', 'pt_signed'] as const;
export type ZnsEvent = (typeof ZNS_EVENTS)[number];

export interface EventCfg {
  enabled: boolean;
  templateId: string;
  days: number[];
  params: Record<string, string>;
}
export interface ZnsCfg {
  appId: string;
  oaId: string;
  secretKey: string;
  accessToken: string;
  refreshToken: string;
  testPhone: string;
  events: Record<ZnsEvent, EventCfg>;
}

const KEY = 'zns';
const blank = (days: number[] = []): EventCfg => ({ enabled: false, templateId: '', days, params: {} });
const fresh = (): ZnsCfg => ({
  appId: '',
  oaId: '',
  secretKey: '',
  accessToken: '',
  refreshToken: '',
  testPhone: '',
  events: { new_contract: blank(), renewal: blank(), expiring: blank([30, 14, 7]), pt_signed: blank() },
});

export async function getZns(): Promise<ZnsCfg> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const saved = (row?.value ?? {}) as Partial<ZnsCfg>;
  const base = fresh();
  const events = { ...base.events };
  for (const k of ZNS_EVENTS) events[k] = { ...base.events[k], ...(saved.events?.[k] ?? {}) };
  return { ...base, ...saved, events };
}

export async function saveZns(cfg: ZnsCfg) {
  const value = cfg as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

export function publicZns(cfg: ZnsCfg) {
  return {
    app_id: cfg.appId,
    oa_id: cfg.oaId,
    test_phone: cfg.testPhone,
    has_secret_key: !!cfg.secretKey,
    has_access_token: !!cfg.accessToken,
    has_refresh_token: !!cfg.refreshToken,
    events: Object.fromEntries(
      ZNS_EVENTS.map((k) => [k, { enabled: cfg.events[k].enabled, template_id: cfg.events[k].templateId, days: cfg.events[k].days, params: cfg.events[k].params }]),
    ),
  };
}

export const normalizePhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  if (d.startsWith('84')) return d;
  if (d.startsWith('0')) return '84' + d.slice(1);
  return d;
};

const fmtVN = (d: Date | null | undefined) =>
  d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}` : '';
const fmtTimeVN = (d: Date) => {
  const v = new Date(d.getTime() + 7 * 3600 * 1000);
  return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')} ${fmtVN(v)}`;
};

type ZaloReply = { error?: number; message?: string; access_token?: string; refresh_token?: string };

async function refreshToken(cfg: ZnsCfg): Promise<boolean> {
  if (!cfg.refreshToken || !cfg.appId || !cfg.secretKey) return false;
  const res = await fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: cfg.secretKey },
    body: new URLSearchParams({ refresh_token: cfg.refreshToken, app_id: cfg.appId, grant_type: 'refresh_token' }),
  });
  const j = (await res.json().catch(() => ({}))) as ZaloReply;
  if (!j.access_token) return false;
  cfg.accessToken = j.access_token;
  if (j.refresh_token) cfg.refreshToken = j.refresh_token;
  await saveZns(cfg);
  return true;
}

async function callZns(cfg: ZnsCfg, body: object): Promise<ZaloReply> {
  const go = async () => {
    const res = await fetch('https://business.openapi.zalo.me/message/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: cfg.accessToken },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => ({ error: -1, message: `HTTP ${res.status}` }))) as ZaloReply;
  };
  let j = await go();
  if ((j.error === -124 || j.error === -216) && (await refreshToken(cfg))) j = await go();
  return j;
}

export interface SendArgs {
  event: ZnsEvent;
  dedupeKey: string;
  memberId?: string | null;
  phone: string;
  vars: Record<string, string>;
  force?: boolean;
}

export async function sendZns(a: SendArgs): Promise<{ status: 'sent' | 'failed' | 'skipped'; error?: string }> {
  const cfg = await getZns();
  const ev = cfg.events[a.event];
  if (!a.force && !ev.enabled) return { status: 'skipped', error: 'event disabled' };
  if (!ev.templateId || !cfg.accessToken) return { status: 'skipped', error: 'not configured' };
  const phone = normalizePhone(a.phone);
  if (phone.length < 10) return { status: 'skipped', error: 'invalid phone' };
  const key = a.force ? `${a.dedupeKey}#${Date.now()}` : a.dedupeKey;
  const failed = await prisma.znsLog.count({ where: { dedupeKey: { startsWith: `${a.dedupeKey}#failed` } } });
  if (!a.force && failed >= 3) return { status: 'skipped', error: 'too many failures' };
  let log;
  try {
    log = await prisma.znsLog.create({
      data: { event: a.event, dedupeKey: key, memberId: a.memberId ?? null, phone, templateId: ev.templateId, status: 'pending' },
    });
  } catch {
    return { status: 'skipped', error: 'already sent' };
  }
  const data: Record<string, string> = {};
  for (const [param, variable] of Object.entries(ev.params)) if (param && variable) data[param] = a.vars[variable] ?? '';
  const fail = async (error: string) => {
    await prisma.znsLog.update({ where: { id: log.id }, data: { status: 'failed', error, dedupeKey: `${a.dedupeKey}#failed${log.id}` } });
    return { status: 'failed' as const, error };
  };
  try {
    const j = await callZns(cfg, { phone, template_id: ev.templateId, template_data: data, tracking_id: log.id });
    if (j.error === 0) {
      await prisma.znsLog.update({ where: { id: log.id }, data: { status: 'sent' } });
      return { status: 'sent' };
    }
    return await fail(`${j.error ?? ''} ${j.message ?? ''}`.trim());
  } catch (e) {
    return await fail(e instanceof Error ? e.message : 'network error');
  }
}

export const SAMPLE_VARS: Record<string, string> = {
  customer_name: 'Nguyen Van A',
  contract_code: 'HD-0001',
  package_name: 'Goi 3 thang',
  end_date: '31/12/2026',
  days_left: '7',
  pt_name: 'PT Khanh',
  session_time: '18:00 19/11/2026',
  gym_name: 'TH Gym',
};

export async function notifyContract(contractId: string) {
  try {
    const c = await prisma.contract.findUnique({ where: { id: contractId }, include: { member: true, package: true } });
    if (!c || c.status !== 'active') return;
    const event: ZnsEvent = c.renewedFromId ? 'renewal' : 'new_contract';
    await sendZns({
      event,
      dedupeKey: `${event}:${c.id}`,
      memberId: c.memberId,
      phone: c.member.phone,
      vars: { customer_name: c.member.name, contract_code: c.code, package_name: c.packageName ?? c.package.name, end_date: fmtVN(c.endDate), gym_name: 'TH Gym' },
    });
  } catch (e) {
    logger.error({ err: e }, 'notifyContract failed');
  }
}

export async function notifyPtDone(sessionId: string) {
  try {
    const s = await prisma.ptSession.findUnique({ where: { id: sessionId }, include: { member: true, trainer: true } });
    if (!s || !s.member) return;
    await sendZns({
      event: 'pt_signed',
      dedupeKey: `pt_signed:${s.id}`,
      memberId: s.memberId,
      phone: s.member.phone,
      vars: { customer_name: s.member.name, pt_name: s.trainer.name, session_time: fmtTimeVN(s.startAt), gym_name: 'TH Gym' },
    });
  } catch (e) {
    logger.error({ err: e }, 'notifyPtDone failed');
  }
}

export async function sendExpiryReminders(now = new Date()) {
  const cfg = await getZns();
  const ev = cfg.events.expiring;
  if (!ev.enabled || !ev.templateId || !cfg.accessToken) return { sent: 0 };
  const today = dateOnly(todayVN(now));
  let sent = 0;
  for (const d of ev.days) {
    const end = addDays(today, d);
    const list = await prisma.contract.findMany({ where: { status: 'active', endDate: end }, include: { member: true, package: true } });
    for (const c of list) {
      const later = await prisma.contract.findFirst({
        where: { memberId: c.memberId, id: { not: c.id }, status: { in: ['active', 'signed'] }, package: { category: c.package.category }, endDate: { gt: end } },
        select: { id: true },
      });
      if (later) continue;
      const r = await sendZns({
        event: 'expiring',
        dedupeKey: `expiring:${c.id}:${d}`,
        memberId: c.memberId,
        phone: c.member.phone,
        vars: {
          customer_name: c.member.name,
          contract_code: c.code,
          package_name: c.packageName ?? c.package.name,
          end_date: fmtVN(c.endDate),
          days_left: String(d),
          gym_name: 'TH Gym',
        },
      });
      if (r.status === 'sent') sent++;
    }
  }
  return { sent };
}

export function startZnsJob(everyMs = 3600_000) {
  const run = () => {
    const hour = new Date(Date.now() + 7 * 3600 * 1000).getUTCHours();
    if (hour < 9) return;
    sendExpiryReminders().catch((e) => logger.error({ err: e }, 'sendExpiryReminders failed'));
  };
  const t = setInterval(run, everyMs);
  t.unref();
  return t;
}
