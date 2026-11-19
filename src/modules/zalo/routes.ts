import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { getZns, publicZns, saveZns, sendZns, sendExpiryReminders, SAMPLE_VARS, ZNS_EVENTS } from './service';

export const zaloRouter = Router();
zaloRouter.use(authenticate, authorize('system.manage_settings'));

const eventSchema = z.object({
  enabled: z.boolean(),
  template_id: z.string().trim().max(100),
  days: z.array(z.number().int().min(1).max(90)).max(6).default([]),
  params: z.record(z.string().trim().max(60), z.string().trim().max(40)).default({}),
});
const configSchema = z.object({
  app_id: z.string().trim().max(100),
  oa_id: z.string().trim().max(100),
  test_phone: z.string().trim().max(20),
  secret_key: z.string().trim().max(200).optional(),
  access_token: z.string().trim().max(2000).optional(),
  refresh_token: z.string().trim().max(2000).optional(),
  events: z.partialRecord(z.enum(ZNS_EVENTS), eventSchema),
});

zaloRouter.get('/config', async (_req, res) => {
  res.json({ data: publicZns(await getZns()) });
});

zaloRouter.put('/config', async (req, res) => {
  const b = configSchema.parse(req.body);
  const cfg = await getZns();
  cfg.appId = b.app_id;
  cfg.oaId = b.oa_id;
  cfg.testPhone = b.test_phone;
  if (b.secret_key) cfg.secretKey = b.secret_key;
  if (b.access_token) cfg.accessToken = b.access_token;
  if (b.refresh_token) cfg.refreshToken = b.refresh_token;
  for (const k of ZNS_EVENTS) {
    const e = b.events[k];
    if (!e) continue;
    if (e.enabled && !e.template_id) throw badRequest('TEMPLATE_REQUIRED', 'Template ID is required for enabled events');
    cfg.events[k] = { enabled: e.enabled, templateId: e.template_id, days: [...new Set(e.days)].sort((x, y) => y - x), params: e.params };
  }
  await saveZns(cfg);
  await audit(req.auth!.userId, 'zns.config_updated', { events: ZNS_EVENTS.filter((k) => cfg.events[k].enabled) }, req.ip);
  res.json({ data: publicZns(cfg) });
});

zaloRouter.post('/test', async (req, res) => {
  const b = z.object({ event: z.enum(ZNS_EVENTS), phone: z.string().trim().max(20).optional() }).parse(req.body);
  const cfg = await getZns();
  const phone = b.phone || cfg.testPhone;
  if (!phone) throw badRequest('PHONE_REQUIRED', 'Enter a test phone number');
  const r = await sendZns({ event: b.event, dedupeKey: `test:${b.event}`, phone, vars: SAMPLE_VARS, force: true });
  res.json({ data: r });
});

zaloRouter.post('/run-reminders', async (_req, res) => {
  res.json({ data: await sendExpiryReminders() });
});

zaloRouter.get('/logs', async (_req, res) => {
  const rows = await prisma.znsLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({
    data: rows.map((r) => ({ id: r.id, event: r.event, phone: r.phone, status: r.status, error: r.error, created_at: r.createdAt.toISOString() })),
  });
});
