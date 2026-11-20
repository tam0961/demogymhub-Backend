import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { authenticate, authorize } from '../../middlewares/auth';
import { ensureSheetSecret, getSheetSyncCfg, patchSheetSyncCfg, publicSheetSyncCfg } from './config';
import { dumpScriptCode } from './dump-script';
import * as pullModule from './pull';
import { importSheetMembers } from './import-members';
import { pullNow } from './pull';
import { retrySheetWrites, writeSummary } from './write';

export const sheetSyncRouter = Router();
sheetSyncRouter.use(authenticate, authorize('system.manage_settings'));

const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

async function view() {
  return { ...publicSheetSyncCfg(await getSheetSyncCfg()), write_log: await writeSummary() };
}

sheetSyncRouter.get('/config', async (_req, res) => {
  res.json({ data: await view() });
});

const putSchema = z.object({
  write_on: z.boolean(),
  bridge_url: z.string().trim().max(400),
  pull_on: z.boolean(),
  dump_url: z.string().trim().max(400),
  branch_id: z.union([z.string().uuid(), z.literal('')]),
});

sheetSyncRouter.put('/config', async (req, res) => {
  const b = putSchema.parse(req.body);
  if (b.write_on && !URL_RE.test(b.bridge_url)) throw badRequest('BRIDGE_URL_INVALID', 'Địa chỉ cầu nối phải có dạng https://script.google.com/macros/s/.../exec');
  if (b.bridge_url && !URL_RE.test(b.bridge_url)) throw badRequest('BRIDGE_URL_INVALID', 'Địa chỉ cầu nối phải có dạng https://script.google.com/macros/s/.../exec');
  if (b.dump_url && !URL_RE.test(b.dump_url)) throw badRequest('DUMP_URL_INVALID', 'Địa chỉ Web app phải có dạng https://script.google.com/macros/s/.../exec');
  if (b.pull_on && !b.dump_url) throw badRequest('DUMP_URL_REQUIRED', 'Cần dán địa chỉ Web app của Apps Script để bật kéo dữ liệu từ Sheet');
  await patchSheetSyncCfg({ writeOn: b.write_on, bridgeUrl: b.bridge_url, pullOn: b.pull_on, dumpUrl: b.dump_url, branchId: b.branch_id });
  await audit(req.auth!.userId, 'sheetsync.config_updated', { write_on: b.write_on, pull_on: b.pull_on }, req.ip);
  res.json({ data: await view() });
});

sheetSyncRouter.post('/import-members', async (req, res) => {
  const b = z.object({ dry_run: z.boolean().default(true) }).parse(req.body ?? {});
  try {
    const rows = await pullModule.fetchMemberRows();
    const r = await importSheetMembers(rows, { dryRun: b.dry_run, createdBy: req.auth!.userId });
    if (!b.dry_run) await audit(req.auth!.userId, 'sheetsync.members_imported', r.counts, req.ip);
    res.json({ data: r });
  } catch (e) {
    throw badRequest('IMPORT_FAILED', e instanceof Error ? e.message : 'Không nhập được hội viên từ Sheet');
  }
});

sheetSyncRouter.get('/script', async (_req, res) => {
  const c = await ensureSheetSecret();
  res.json({ data: { code: dumpScriptCode(c.secret) } });
});

sheetSyncRouter.post('/pull-now', async (req, res) => {
  const r = await pullNow();
  await audit(req.auth!.userId, 'sheetsync.pull_now', { ok: r.ok }, req.ip);
  res.json({ data: r });
});

interface PendingApi {
  getPendingMembers?: () => Promise<unknown[]>;
  approvePending?: (phone: string, createdBy: string | null) => Promise<{ memberId: string; code: string }>;
}
const pendingApi = async () => pullModule as unknown as PendingApi;

sheetSyncRouter.get('/pending-members', async (_req, res) => {
  const api = await pendingApi();
  res.json({ data: api.getPendingMembers ? await api.getPendingMembers() : [] });
});

sheetSyncRouter.post('/pending-members/approve', async (req, res) => {
  const b = z.object({ phone: z.string().trim().min(8).max(20) }).parse(req.body);
  const api = await pendingApi();
  if (!api.approvePending) throw badRequest('NOT_AVAILABLE', 'Chưa hỗ trợ tạo hội viên từ Sheet');
  try {
    const r = await api.approvePending(b.phone, req.auth!.userId);
    await audit(req.auth!.userId, 'sheetsync.member_approved', { member_id: r.memberId, code: r.code }, req.ip, r.memberId);
    res.status(201).json({ data: { member_id: r.memberId, code: r.code } });
  } catch (e) {
    throw badRequest('APPROVE_FAILED', e instanceof Error ? e.message : 'Không tạo được hội viên');
  }
});

sheetSyncRouter.post('/retry', async (req, res) => {
  const sent = await retrySheetWrites();
  await audit(req.auth!.userId, 'sheetsync.retry', { calls: sent }, req.ip);
  res.json({ data: { calls: sent, ...(await view()) } });
});
