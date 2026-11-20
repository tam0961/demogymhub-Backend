import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hit } from '../../lib/redis';
import { authorize } from '../../middlewares/auth';
import { createInboxKey, getInboxKeys, saveInboxKeys } from '../leads/inbox';
import { fbCreds, fbSync, getAuto, ingestAds, ingestGbp, newKey, sameKey, saveAuto } from './auto';

/** Public: Google Ads Script and the Business Profile Apps Script post here, authenticated by their own key. */
export const mkPublicRouter = Router();

mkPublicRouter.use(async (req, _res, next) => {
  const { count } = await hit(`mk:rl:${req.ip}`, 60);
  if (count > 120) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests'));
  next();
});

mkPublicRouter.post('/ads-in', async (req, res) => {
  const cfg = await getAuto();
  if (!cfg.gg.key || !sameKey(String(req.query.key ?? ''), cfg.gg.key)) throw new HttpError(403, 'KEY_INVALID', 'Invalid key');
  res.json({ ok: true, ...(await ingestAds(req.body ?? {})) });
});

mkPublicRouter.post('/gbp-in', async (req, res) => {
  const cfg = await getAuto();
  if (!cfg.gbp.key || !sameKey(String(req.query.key ?? ''), cfg.gbp.key)) throw new HttpError(403, 'KEY_INVALID', 'Invalid key');
  res.json({ ok: true, ...(await ingestGbp(req.body ?? {})) });
});

/** Owner side, mounted under /api/marketing/auto (already authenticated). */
export const marketingAutoRouter = Router();
marketingAutoRouter.use(authorize('system.manage_settings'));

async function view() {
  const c = await getAuto();
  const fb = await fbCreds();
  const [campaigns, daily] = await Promise.all([prisma.marketingCampaign.count(), prisma.marketingDaily.count()]);
  return {
    fb: { connected: !!(fb.token && fb.account), account: fb.account, name: c.fb.name, currency: c.fb.currency, synced: c.fb.synced, err: c.fb.err },
    gg: { key: c.gg.key, account: c.gg.account, name: c.gg.name, synced: c.gg.synced },
    gbp: { key: c.gbp.key, name: c.gbp.name, synced: c.gbp.synced, last: c.gbp.last },
    rules: c.rules,
    def_branch: c.defBranch,
    counts: { campaigns, daily },
  };
}

marketingAutoRouter.get('/config', async (_req, res) => {
  const c = await getAuto();
  if (!c.gg.key || !c.gbp.key) {
    c.gg.key ||= newKey();
    c.gbp.key ||= newKey();
    await saveAuto(c);
  }
  res.json({ data: await view() });
});

const cfgSchema = z.object({
  rules: z.array(z.object({ k: z.string().trim().min(1).max(40), b: z.string().regex(/^[a-z0-9]{1,8}$/) })).max(20).optional(),
  def_branch: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  regen_gg: z.boolean().optional(),
  regen_gbp: z.boolean().optional(),
});

marketingAutoRouter.put('/config', async (req, res) => {
  const b = cfgSchema.parse(req.body);
  const c = await getAuto();
  if (b.rules) c.rules = b.rules;
  if (b.def_branch) c.defBranch = b.def_branch;
  if (b.regen_gg || !c.gg.key) c.gg.key = newKey();
  if (b.regen_gbp || !c.gbp.key) c.gbp.key = newKey();
  await saveAuto(c);
  await audit(req.auth!.userId, 'marketing.auto_config_saved', { regen_gg: !!b.regen_gg, regen_gbp: !!b.regen_gbp, rules: c.rules.length }, req.ip);
  res.json({ data: await view() });
});

marketingAutoRouter.post('/fb-sync', async (req, res) => {
  const r = await fbSync(30);
  await audit(req.auth!.userId, 'marketing.fb_sync', { ok: r.ok }, req.ip);
  res.json({ data: { ...r, config: await view() } });
});

marketingAutoRouter.get('/lead-keys', async (_req, res) => {
  const list = await getInboxKeys();
  res.json({ data: list.map((k) => ({ id: k.id, branch_id: k.branch_id, label: k.label, created_at: k.created_at, last_at: k.last_at })) });
});

marketingAutoRouter.post('/lead-keys', async (req, res) => {
  const b = z.object({ branch_id: z.string().uuid(), label: z.string().trim().min(1).max(60) }).parse(req.body);
  if (!(await prisma.branch.findUnique({ where: { id: b.branch_id }, select: { id: true } }))) throw notFound('Branch not found');
  const { key, item } = await createInboxKey(b.branch_id, b.label);
  await audit(req.auth!.userId, 'leads.inbox_key_created', { id: item.id, branch_id: b.branch_id }, req.ip);
  res.status(201).json({ data: { id: item.id, key, branch_id: item.branch_id, label: item.label } });
});

marketingAutoRouter.delete('/lead-keys/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const list = await getInboxKeys();
  if (!list.some((k) => k.id === id)) throw notFound('Key not found');
  await saveInboxKeys(list.filter((k) => k.id !== id));
  await audit(req.auth!.userId, 'leads.inbox_key_deleted', { id }, req.ip);
  res.json({ data: { ok: true } });
});
