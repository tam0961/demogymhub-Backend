import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';

const SHEET_KEY = 'sheets';
const METRIC_KEY = 'marketing.metrics';
export const SHEET_KINDS = ['leads', 'payroll', 'pt_group'] as const;
export const CHANNELS = ['facebook_ads', 'google_ads', 'google_maps'] as const;

const sheetSchema = z.object({
  name: z.string().trim().max(100).default(''),
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => u === '' || /^https:\/\/docs\.google\.com\/spreadsheets\//.test(u), 'must be a Google Sheets link'),
});
const sheetsSchema = z.object(Object.fromEntries(SHEET_KINDS.map((k) => [k, sheetSchema])) as Record<(typeof SHEET_KINDS)[number], typeof sheetSchema>);
export type SheetsCfg = z.infer<typeof sheetsSchema>;

const emptySheets = (): SheetsCfg => ({ leads: { name: '', url: '' }, payroll: { name: '', url: '' }, pt_group: { name: '', url: '' } });

export async function getSheets(): Promise<SheetsCfg> {
  const row = await prisma.setting.findUnique({ where: { key: SHEET_KEY } });
  const parsed = sheetsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : emptySheets();
}

export const sheetsRouter = Router();
sheetsRouter.use(authenticate, authorize('system.manage_settings'));
sheetsRouter.get('/', async (_req, res) => {
  res.json({ data: await getSheets() });
});
sheetsRouter.put('/', async (req, res) => {
  const value = sheetsSchema.parse(req.body);
  await prisma.setting.upsert({ where: { key: SHEET_KEY }, create: { key: SHEET_KEY, value }, update: { value } });
  await audit(req.auth!.userId, 'settings.sheets_updated', { configured: SHEET_KINDS.filter((k) => value[k].url) }, req.ip);
  res.json({ data: value });
});

const metricSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  channel: z.enum(CHANNELS),
  spend: z.number().int().min(0).max(1e12),
  impressions: z.number().int().min(0).max(1e10),
  clicks: z.number().int().min(0).max(1e10),
  leads: z.number().int().min(0).max(1e7),
  note: z.string().trim().max(300).default(''),
});
export type MetricRow = z.infer<typeof metricSchema>;

async function getMetrics(): Promise<MetricRow[]> {
  const row = await prisma.setting.findUnique({ where: { key: METRIC_KEY } });
  const parsed = z.array(metricSchema).safeParse(row?.value);
  return parsed.success ? parsed.data : [];
}

export const marketingRouter = Router();
marketingRouter.use(authenticate);
marketingRouter.get('/metrics', authorize('reports.view'), async (req, res) => {
  const month = typeof req.query.month === 'string' ? req.query.month : '';
  const rows = await getMetrics();
  res.json({ data: month ? rows.filter((r) => r.month === month) : rows });
});
marketingRouter.put('/metrics', authorize('system.manage_settings'), async (req, res) => {
  const b = metricSchema.parse(req.body);
  const rows = (await getMetrics()).filter((r) => !(r.month === b.month && r.channel === b.channel));
  rows.push(b);
  rows.sort((x, y) => y.month.localeCompare(x.month) || x.channel.localeCompare(y.channel));
  await prisma.setting.upsert({ where: { key: METRIC_KEY }, create: { key: METRIC_KEY, value: rows }, update: { value: rows } });
  await audit(req.auth!.userId, 'marketing.metrics_saved', { month: b.month, channel: b.channel }, req.ip);
  res.json({ data: b });
});

const ADS_KEY = 'marketing.ads';
const ADS_PLATFORMS = ['facebook', 'google_ads', 'maps'] as const;
type AdsPlatform = (typeof ADS_PLATFORMS)[number];
type AdsStored = Record<AdsPlatform, { account_id: string; secret: string }>;
const emptyAds = (): AdsStored => ({ facebook: { account_id: '', secret: '' }, google_ads: { account_id: '', secret: '' }, maps: { account_id: '', secret: '' } });

async function getAds(): Promise<AdsStored> {
  const row = await prisma.setting.findUnique({ where: { key: ADS_KEY } });
  const v = (row?.value ?? {}) as Partial<AdsStored>;
  const base = emptyAds();
  for (const p of ADS_PLATFORMS) base[p] = { account_id: v[p]?.account_id ?? '', secret: v[p]?.secret ?? '' };
  return base;
}
const publicAds = (a: AdsStored) => Object.fromEntries(ADS_PLATFORMS.map((p) => [p, { account_id: a[p].account_id, has_token: !!a[p].secret }]));

const adsPut = z.object({
  platform: z.enum(ADS_PLATFORMS),
  account_id: z.string().trim().max(100),
  token: z.string().trim().max(2000).optional(),
});

marketingRouter.get('/ads', authorize('reports.view'), async (_req, res) => {
  res.json({ data: publicAds(await getAds()) });
});
marketingRouter.put('/ads', authorize('system.manage_settings'), async (req, res) => {
  const b = adsPut.parse(req.body);
  const ads = await getAds();
  ads[b.platform] = { account_id: b.account_id, secret: b.token ? b.token : ads[b.platform].secret };
  await prisma.setting.upsert({ where: { key: ADS_KEY }, create: { key: ADS_KEY, value: ads }, update: { value: ads } });
  await audit(req.auth!.userId, 'marketing.ads_saved', { platform: b.platform, token_changed: !!b.token }, req.ip);
  res.json({ data: publicAds(ads) });
});
