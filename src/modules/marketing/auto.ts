import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';

const AUTO_KEY = 'marketing.auto';
const ADS_KEY = 'marketing.ads';
const GBP_KEY = 'marketing.gbp';
const META_BASE = 'https://graph.facebook.com';
const META_VER = 'v26.0';

export interface AutoCfg {
  rules: { k: string; b: string }[];
  defBranch: string;
  fb: { name: string; currency: string; synced: number; err: string };
  gg: { key: string; account: string; name: string; synced: number };
  gbp: { key: string; name: string; synced: number; last: null | { days: number; series: number; points: number; from: string; to: string; loc: string; at: number } };
}

const freshAuto = (): AutoCfg => ({
  rules: [{ k: 'nhà bè', b: 'nb' }, { k: 'nha be', b: 'nb' }],
  defBranch: 'q7',
  fb: { name: '', currency: '', synced: 0, err: '' },
  gg: { key: '', account: '', name: '', synced: 0 },
  gbp: { key: '', name: '', synced: 0, last: null },
});

const str = (x: unknown, n: number) => String(x == null ? '' : x).slice(0, n);
const num = (x: unknown) => {
  const v = parseFloat(String(x));
  return Number.isFinite(v) ? v : 0;
};
const pad = (n: number) => String(n).padStart(2, '0');
export const vnToday = (t = Date.now()) => {
  const v = new Date(t + 7 * 3600_000);
  return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
};
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const DATE_RE = /^\d{4}-\d\d-\d\d$/;
const dateOnly = (s: string) => new Date(`${s}T00:00:00Z`);
export const newKey = () => crypto.randomBytes(24).toString('base64url').replace(/[-_]/g, 'a');

export async function getAuto(): Promise<AutoCfg> {
  const row = await prisma.setting.findUnique({ where: { key: AUTO_KEY } });
  const v = (row?.value ?? {}) as Partial<AutoCfg>;
  const d = freshAuto();
  return { rules: Array.isArray(v.rules) ? v.rules : d.rules, defBranch: v.defBranch || d.defBranch, fb: { ...d.fb, ...v.fb }, gg: { ...d.gg, ...v.gg }, gbp: { ...d.gbp, ...v.gbp } };
}
export async function saveAuto(c: AutoCfg) {
  const value = c as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: AUTO_KEY }, create: { key: AUTO_KEY, value }, update: { value } });
}

export const sameKey = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export async function fbCreds(): Promise<{ token: string; account: string }> {
  const row = await prisma.setting.findUnique({ where: { key: ADS_KEY } });
  const f = ((row?.value ?? {}) as { facebook?: { account_id?: string; secret?: string } }).facebook;
  return { token: f?.secret ?? '', account: f?.account_id ?? '' };
}

/** First rule whose keyword appears in the campaign name wins; otherwise the default branch. */
async function branchIds() {
  const rows = await prisma.branch.findMany({ select: { id: true, code: true } });
  return new Map(rows.map((b) => [b.code, b.id]));
}
const branchCodeOf = (name: string, cfg: AutoCfg) => {
  const n = String(name || '').toLowerCase();
  return cfg.rules.find((r) => r.k && n.includes(r.k.toLowerCase()))?.b ?? cfg.defBranch;
};

interface Camp {
  id: string;
  name: string;
  status: 'active' | 'paused';
  budget: number;
  kind?: string;
}
interface Row {
  date: string;
  cid: string;
  spend: unknown;
  impr: unknown;
  clicks: unknown;
  leads?: unknown;
  msgs?: unknown;
  conv?: unknown;
}

/** Writes campaigns (keeps a branch already set) and the daily rows. Only changed rows are written. */
async function upsertData(cfg: AutoCfg, platform: 'fb' | 'gg', camps: Camp[], rows: Row[]) {
  const codes = await branchIds();
  const exist = new Map((await prisma.marketingCampaign.findMany({ where: { id: { in: camps.map((c) => c.id) } } })).map((c) => [c.id, c]));
  let written = 0;
  for (const c of camps) {
    const old = exist.get(c.id);
    const branchId = old?.branchId ?? codes.get(branchCodeOf(c.name, cfg)) ?? null;
    const data = { platform, name: str(c.name, 120), branchId, budget: Math.round(num(c.budget)), status: c.status, kind: c.kind ? str(c.kind, 30) : null };
    if (!old || old.name !== data.name || old.budget !== data.budget || old.status !== data.status || old.kind !== data.kind || old.branchId !== branchId) {
      await prisma.marketingCampaign.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: { ...data, updatedAt: new Date() } });
      written++;
    }
  }
  const valid = new Set((await prisma.marketingCampaign.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.cid))] } }, select: { id: true } })).map((c) => c.id));
  for (const r of rows) {
    if (!valid.has(r.cid) || !DATE_RE.test(r.date)) continue;
    const data = { spend: Math.round(num(r.spend)), impressions: Math.round(num(r.impr)), clicks: Math.round(num(r.clicks)), leads: Math.round(num(r.leads)), msgs: Math.round(num(r.msgs)), conv: Math.round(num(r.conv) * 10) / 10 };
    const where = { date_campaignId: { date: dateOnly(r.date), campaignId: r.cid } };
    const old = await prisma.marketingDaily.findUnique({ where });
    if (old && old.spend === data.spend && old.impressions === data.impressions && old.clicks === data.clicks && old.leads === data.leads && old.msgs === data.msgs && old.conv === data.conv) continue;
    await prisma.marketingDaily.upsert({ where, create: { date: dateOnly(r.date), campaignId: r.cid, ...data }, update: data });
    written++;
  }
  return { campaigns: camps.length, rows: rows.length, written };
}

/* ---------- Facebook Ads (Marketing API) ---------- */
async function fbGet(token: string, url: string, params: Record<string, string>) {
  const u = new URL(/^https?:/.test(url) ? url : `${META_BASE}/${META_VER}${url}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  const r = await fetch(u.toString(), { signal: AbortSignal.timeout(30000) });
  interface FbJson {
    error?: { message?: string; type?: string };
    data?: unknown[];
    paging?: { next?: string };
  }
  let j = null as FbJson | null;
  try {
    j = (await r.json()) as FbJson;
  } catch {
    j = null;
  }
  if (!r.ok || !j || j.error) throw new Error(`Facebook: ${str(j?.error?.message || j?.error?.type || `HTTP ${r.status}`, 200)}`);
  return j;
}
async function fbAll(token: string, url: string, params: Record<string, string>, max = 5000) {
  let j = await fbGet(token, url, params);
  let list = (j.data ?? []) as Record<string, unknown>[];
  while (j.paging?.next && list.length < max) {
    j = await fbGet(token, j.paging.next, {});
    list = list.concat((j.data ?? []) as Record<string, unknown>[]);
  }
  return list;
}
const actionCount = (acts: unknown, types: string[]) => {
  const list = (Array.isArray(acts) ? acts : []) as { action_type?: string; value?: unknown }[];
  for (const t of types) {
    const a = list.find((x) => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
};

export async function fbSync(days = 3): Promise<{ ok: boolean; err?: string; name?: string; currency?: string; campaigns?: number; rows?: number; written?: number }> {
  const { token, account } = await fbCreds();
  if (!token || !account) return { ok: false, err: 'Chưa nhập token hoặc ID tài khoản quảng cáo' };
  const acct = /^act_/.test(account) ? account : `act_${account.replace(/\D/g, '')}`;
  try {
    const info = (await fbGet(token, `/${acct}`, { fields: 'name,currency,account_status' })) as unknown as { name?: string; currency?: string };
    const camps: Camp[] = (await fbAll(token, `/${acct}/campaigns`, { fields: 'id,name,effective_status,daily_budget', limit: '200' })).map((c) => ({
      id: `fb${c.id}`,
      name: String(c.name ?? ''),
      status: c.effective_status === 'ACTIVE' ? 'active' : 'paused',
      budget: num(c.daily_budget),
    }));
    const today = vnToday();
    const since = addDays(today, -days + 1);
    const ins = await fbAll(token, `/${acct}/insights`, { level: 'campaign', time_increment: '1', fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions', time_range: JSON.stringify({ since, until: today }), limit: '500' });
    const known = new Set(camps.map((c) => c.id));
    const rows: Row[] = ins.map((x) => {
      const cid = `fb${x.campaign_id}`;
      if (!known.has(cid)) {
        known.add(cid);
        camps.push({ id: cid, name: String(x.campaign_name ?? ''), status: 'paused', budget: 0 });
      }
      return {
        date: String(x.date_start),
        cid,
        spend: x.spend,
        impr: x.impressions,
        clicks: x.clicks,
        leads: actionCount(x.actions, ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped']),
        msgs: actionCount(x.actions, ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.messaging_first_reply']),
      };
    });
    const cfg = await getAuto();
    cfg.fb = { name: str(info.name, 80), currency: str(info.currency, 8), synced: Date.now(), err: '' };
    const r = await upsertData(cfg, 'fb', camps, rows);
    await saveAuto(cfg);
    return { ok: true, name: cfg.fb.name, currency: cfg.fb.currency, ...r };
  } catch (e) {
    const err = str(e instanceof Error ? e.message : e, 200);
    const cfg = await getAuto();
    cfg.fb.err = err;
    await saveAuto(cfg);
    return { ok: false, err };
  }
}

/* ---------- Google Ads Script pushes here ---------- */
export interface AdsBody {
  account?: string;
  name?: string;
  campaigns?: { id?: unknown; name?: unknown; status?: unknown; budget?: unknown; ch?: unknown }[];
  rows?: { date?: string; id?: unknown; spend?: unknown; impr?: unknown; clicks?: unknown; conv?: unknown; leads?: unknown }[];
}
export async function ingestAds(b: AdsBody) {
  const cleanId = (x: unknown) => `gg${String(x).replace(/\W/g, '')}`;
  const camps: Camp[] = (Array.isArray(b.campaigns) ? b.campaigns : [])
    .slice(0, 300)
    .filter((c) => c && c.id)
    .map((c) => ({ id: cleanId(c.id), name: String(c.name ?? ''), status: c.status === 'ENABLED' || c.status === 'active' ? 'active' : 'paused', budget: num(c.budget), kind: c.ch ? str(c.ch, 30) : undefined }));
  const known = new Set(camps.map((c) => c.id));
  const rows: Row[] = (Array.isArray(b.rows) ? b.rows : [])
    .slice(0, 3000)
    .filter((r) => r && r.id && typeof r.date === 'string' && DATE_RE.test(r.date))
    .map((r) => ({ date: r.date as string, cid: cleanId(r.id), spend: r.spend, impr: r.impr, clicks: r.clicks, conv: r.conv, leads: r.leads ?? 0, msgs: 0 }));
  for (const r of rows) {
    if (!known.has(r.cid)) {
      known.add(r.cid);
      camps.push({ id: r.cid, name: `Chiến dịch ${r.cid.slice(2)}`, status: 'paused', budget: 0 });
    }
  }
  const cfg = await getAuto();
  cfg.gg.account = str(b.account, 40) || cfg.gg.account;
  cfg.gg.name = str(b.name, 80) || cfg.gg.name;
  cfg.gg.synced = Date.now();
  const r = await upsertData(cfg, 'gg', camps, rows);
  await saveAuto(cfg);
  return r;
}

/* ---------- Google Business Profile (Maps) pushes here ---------- */
const GBP_FIELDS = ['views_maps', 'views_search', 'calls', 'directions', 'web', 'msgs', 'bookings'] as const;
export type GbpDay = Record<(typeof GBP_FIELDS)[number], number>;
export interface GbpDoc {
  days: Record<string, GbpDay>;
  reviews?: { rating: number; count: number; at: number };
  name: string;
  synced: number;
}
export async function getGbp(): Promise<GbpDoc> {
  const row = await prisma.setting.findUnique({ where: { key: GBP_KEY } });
  const v = (row?.value ?? {}) as Partial<GbpDoc>;
  return { days: v.days ?? {}, reviews: v.reviews, name: v.name ?? '', synced: v.synced ?? 0 };
}
export async function ingestGbp(b: { days?: unknown; reviews?: { rating?: unknown; count?: unknown }; name?: unknown; debug?: Record<string, unknown> }) {
  const doc = await getGbp();
  let n = 0;
  for (const x of (Array.isArray(b.days) ? b.days : []).slice(0, 400) as Record<string, unknown>[]) {
    if (!x || typeof x.date !== 'string' || !DATE_RE.test(x.date)) continue;
    doc.days[x.date] = Object.fromEntries(GBP_FIELDS.map((k) => [k, Math.round(num(x[k]))])) as GbpDay;
    n++;
  }
  doc.days = Object.fromEntries(Object.keys(doc.days).sort().slice(-400).map((k) => [k, doc.days[k]]));
  if (b.reviews && typeof b.reviews === 'object') {
    const rt = num(b.reviews.rating);
    const ct = Math.round(num(b.reviews.count));
    if (ct > 0) doc.reviews = { rating: Math.round(rt * 10) / 10, count: ct, at: Date.now() };
  }
  doc.name = str(b.name, 80) || doc.name;
  doc.synced = Date.now();
  const value = doc as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: GBP_KEY }, create: { key: GBP_KEY, value }, update: { value } });
  const dbg = b.debug && typeof b.debug === 'object' ? b.debug : {};
  const cfg = await getAuto();
  cfg.gbp.last = { days: n, series: Math.round(num(dbg.series)), points: Math.round(num(dbg.points)), from: str(dbg.from, 10), to: str(dbg.to, 10), loc: str(dbg.loc, 8), at: doc.synced };
  cfg.gbp.name = doc.name;
  cfg.gbp.synced = doc.synced;
  await saveAuto(cfg);
  return { days: n };
}

/* ---------- monthly numbers for the Marketing page ---------- */
export type AutoChannel = 'facebook_ads' | 'google_ads' | 'google_maps';
export interface AutoMetric {
  month: string;
  channel: AutoChannel;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  note: string;
}

/** Aggregates the synced daily rows per month and channel. Google campaigns with a map channel count as google_maps; the Business Profile fills Maps views, actions and leads. */
export async function autoMetrics(month?: string): Promise<AutoMetric[]> {
  const where: Prisma.MarketingDailyWhereInput = month ? { date: { gte: dateOnly(`${month}-01`), lt: dateOnly(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`) } } : {};
  const rows = await prisma.marketingDaily.findMany({ where, include: { campaign: { select: { platform: true, kind: true } } } });
  const acc = new Map<string, AutoMetric>();
  const bump = (m: string, ch: AutoChannel, d: Partial<AutoMetric>, note = '') => {
    const k = `${m}|${ch}`;
    const cur = acc.get(k) ?? { month: m, channel: ch, spend: 0, impressions: 0, clicks: 0, leads: 0, note: '' };
    cur.spend += d.spend ?? 0;
    cur.impressions += d.impressions ?? 0;
    cur.clicks += d.clicks ?? 0;
    cur.leads += d.leads ?? 0;
    if (note) cur.note = note;
    acc.set(k, cur);
  };
  for (const r of rows) {
    const m = r.date.toISOString().slice(0, 7);
    const ch: AutoChannel = r.campaign.platform === 'fb' ? 'facebook_ads' : /map/i.test(r.campaign.kind ?? '') ? 'google_maps' : 'google_ads';
    bump(m, ch, { spend: r.spend, impressions: r.impressions, clicks: r.clicks, leads: r.leads + r.msgs + Math.round(r.conv) }, 'Tự động từ quảng cáo');
  }
  const gbp = await getGbp();
  const gm = new Map<string, GbpDay>();
  for (const [d, v] of Object.entries(gbp.days)) {
    const m = d.slice(0, 7);
    if (month && m !== month) continue;
    const cur = gm.get(m) ?? { views_maps: 0, views_search: 0, calls: 0, directions: 0, web: 0, msgs: 0, bookings: 0 };
    for (const k of GBP_FIELDS) cur[k] += v[k] ?? 0;
    gm.set(m, cur);
  }
  for (const [m, g] of gm) {
    const k = `${m}|google_maps`;
    const hasAds = acc.has(k);
    bump(m, 'google_maps', { impressions: hasAds ? 0 : g.views_maps + g.views_search, clicks: hasAds ? 0 : g.web + g.directions + g.calls, leads: hasAds ? 0 : g.calls + g.msgs + g.bookings }, `Hồ sơ Maps: ${g.views_maps + g.views_search} lượt xem, ${g.calls} cuộc gọi, ${g.directions} chỉ đường, ${g.web} lượt web`);
  }
  return [...acc.values()].sort((a, b) => b.month.localeCompare(a.month) || a.channel.localeCompare(b.channel));
}

/* ---------- job: Facebook pull every 15 minutes ---------- */
export async function runFbTick(now = Date.now()) {
  if (new Date(now).getUTCMinutes() % 15 !== 2) return;
  const { token, account } = await fbCreds();
  if (!token || !account) return;
  if ((await redis.set('mk:fb:lock', '1', 'EX', 600, 'NX')) !== 'OK') return;
  await fbSync(3);
}
export function startMarketingJob() {
  const timer = setInterval(() => {
    runFbTick().catch((e) => logger.error({ err: e instanceof Error ? e.message : String(e) }, 'marketing facebook sync failed'));
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
