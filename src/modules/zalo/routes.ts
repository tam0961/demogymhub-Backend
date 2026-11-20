import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { CLEAN_TPL_KEYS, PT_TPL_KEYS, SHOOT_TPL_KEYS, getBotCfg, getBotState, publicBotCfg, saveBotCfg, parseWindows, type CleanTplKey, type PtTplKey, type ShootTplKey } from '../zalobot/config';
import { fetchBotLabel, sendText, zaloApi } from '../zalobot/service';
import { appsScriptCode, driveReady, ensureSecret, getReportCfg, publicReportCfg, saveReportCfg } from '../monthlyreport/config';
import { previousMonthVN } from '../monthlyreport/data';
import { createReportPdf, publishReport } from '../monthlyreport/service';
import { branchAllowed } from '../rbac/service';
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

const botSchema = z.object({
  enabled: z.boolean(),
  token: z.string().trim().max(300).optional(),
  bot_name: z.string().trim().min(1).max(60),
  pt_group: z.string().trim().max(100),
  branch_id: z.union([z.string().uuid(), z.literal('')]),
  group_trainer: z.string().trim().max(60),
  group_windows: z.string().trim().max(100),
  clean_on: z.boolean().optional(),
  clean_group: z.string().trim().max(100).optional(),
  clean_tpl: z.record(z.string(), z.string().max(2000)).optional(),
  shoot_on: z.boolean().optional(),
  shoot_group: z.string().trim().max(100).optional(),
  shoot_boss: z.string().trim().min(1).max(40).optional(),
  report_on: z.boolean().optional(),
  report_script_url: z.string().trim().max(400).optional(),
  report_share_link: z.boolean().optional(),
  pt_tpl: z.record(z.string(), z.string().max(2000)).optional(),
  shoot_tpl: z.record(z.string(), z.string().max(2000)).optional(),
});

zaloRouter.get('/bot/config', async (_req, res) => {
  res.json({ data: { ...publicBotCfg(await getBotCfg()), ...publicReportCfg(await getReportCfg()), state: await getBotState() } });
});

zaloRouter.put('/bot/config', async (req, res) => {
  const b = botSchema.parse(req.body);
  if (b.branch_id && !branchAllowed(req.access!, b.branch_id)) throw badRequest('BRANCH_INVALID', 'Branch not permitted');
  if (b.group_windows && parseWindows(b.group_windows).length === 0) throw badRequest('WINDOWS_INVALID', 'Use the form 06:30-07:45, 20:00-21:15');
  const cfg = await getBotCfg();
  if (b.token) {
    cfg.token = b.token;
    cfg.botLabel = config.APP_ENV === 'test' ? '' : await fetchBotLabel(b.token);
  }
  Object.assign(cfg, { enabled: b.enabled, botName: b.bot_name, ptGroup: b.pt_group, branchId: b.branch_id || cfg.branchId, groupTrainer: b.group_trainer, groupWindows: b.group_windows });
  if (!cfg.branchId) {
    const rows = await prisma.userRole.findMany({ where: { role: { key: 'trainer' }, branchId: { not: null }, user: { status: 'active' } }, select: { branchId: true }, distinct: ['branchId'] });
    if (rows.length === 1 && rows[0].branchId && branchAllowed(req.access!, rows[0].branchId)) cfg.branchId = rows[0].branchId;
  }
  if (b.enabled && (!cfg.token || !cfg.ptGroup || !cfg.branchId)) throw badRequest('BOT_INCOMPLETE', 'Token, PT group and branch are required to turn the bot on');
  if (b.clean_group !== undefined) cfg.cleanGroup = b.clean_group;
  if (b.clean_on !== undefined) {
    if (b.clean_on && (!cfg.token || !cfg.cleanGroup)) throw badRequest('CLEAN_INCOMPLETE', 'Token and cleaning group are required to turn the cleaning bot on');
    cfg.cleanOn = b.clean_on;
  }
  if (b.shoot_group !== undefined) cfg.shootGroup = b.shoot_group;
  if (b.shoot_boss !== undefined) cfg.shootBoss = b.shoot_boss;
  if (b.shoot_on !== undefined) {
    if (b.shoot_on && (!cfg.token || !cfg.shootGroup)) throw badRequest('SHOOT_INCOMPLETE', 'Token and shoot group are required to turn the shoot bot on');
    cfg.shootOn = b.shoot_on;
  }
  if (b.pt_tpl) {
    const tpl: Partial<Record<PtTplKey, string>> = {};
    for (const k of PT_TPL_KEYS) if (typeof b.pt_tpl[k] === 'string') tpl[k] = b.pt_tpl[k];
    cfg.ptTpl = tpl;
  }
  if (b.shoot_tpl) {
    const tpl: Partial<Record<ShootTplKey, string>> = {};
    for (const k of SHOOT_TPL_KEYS) if (typeof b.shoot_tpl[k] === 'string') tpl[k] = b.shoot_tpl[k];
    cfg.shootTpl = tpl;
  }
  if (b.clean_tpl) {
    const tpl: Partial<Record<CleanTplKey, string>> = {};
    for (const k of CLEAN_TPL_KEYS) if (typeof b.clean_tpl[k] === 'string') tpl[k] = b.clean_tpl[k];
    cfg.cleanTpl = tpl;
  }
  const rc = await getReportCfg();
  if (b.report_script_url !== undefined) {
    if (b.report_script_url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(b.report_script_url)) throw badRequest('SCRIPT_URL_INVALID', 'Địa chỉ Web app phải có dạng https://script.google.com/macros/s/.../exec');
    rc.scriptUrl = b.report_script_url;
  }
  if (b.report_share_link !== undefined) rc.shareLink = b.report_share_link;
  if (b.report_on !== undefined) {
    if (b.report_on && !driveReady(rc)) throw badRequest('REPORT_INCOMPLETE', 'Cần dán địa chỉ Web app của Apps Script để bật báo cáo tháng');
    rc.on = b.report_on;
  }
  await saveReportCfg(rc);
  await saveBotCfg(cfg);
  await audit(req.auth!.userId, 'zalo_bot.config_updated', { enabled: cfg.enabled, pt_group: cfg.ptGroup, branch_id: cfg.branchId }, req.ip);
  res.json({ data: { ...publicBotCfg(cfg), ...publicReportCfg(rc), state: await getBotState() } });
});

zaloRouter.post('/bot/check', async (_req, res) => {
  const cfg = await getBotCfg();
  if (!cfg.token) throw badRequest('TOKEN_REQUIRED', 'Enter the bot token first');
  const r = await zaloApi(cfg.token, 'getMe');
  if (r?.ok) {
    const label = await fetchBotLabel(cfg.token);
    if (label && label !== cfg.botLabel) {
      cfg.botLabel = label;
      await saveBotCfg(cfg);
    }
  }
  res.json({ data: { ok: !!r?.ok, message: r ? (r.ok ? 'ok' : String(r.description ?? r.error_code ?? 'error')) : 'Không kết nối được Zalo' } });
});

zaloRouter.post('/bot/send-test-clean', async (_req, res) => {
  const cfg = await getBotCfg();
  if (!cfg.token || !cfg.cleanGroup) throw badRequest('BOT_INCOMPLETE', 'Token and cleaning group are required');
  const r = await sendText(cfg, cfg.cleanGroup, 'Bot vệ sinh đã kết nối với DemoGym. Tin thử, anh chị có thể bỏ qua ạ.');
  res.json({ data: { ok: !!r?.ok, message: r ? (r.ok ? 'ok' : String(r.description ?? r.error_code ?? 'error')) : 'Không kết nối được Zalo' } });
});

zaloRouter.post('/bot/send-test-shoot', async (_req, res) => {
  const cfg = await getBotCfg();
  if (!cfg.token || !cfg.shootGroup) throw badRequest('BOT_INCOMPLETE', 'Token and shoot group are required');
  const r = await sendText(cfg, cfg.shootGroup, 'Bot quay đã kết nối với DemoGym. Tin thử, anh chị có thể bỏ qua ạ.');
  res.json({ data: { ok: !!r?.ok, message: r ? (r.ok ? 'ok' : String(r.description ?? r.error_code ?? 'error')) : 'Không kết nối được Zalo' } });
});

zaloRouter.get('/bot/report-script', async (_req, res) => {
  const c = await ensureSecret();
  res.json({ data: { code: appsScriptCode(c.secret) } });
});

const reportBody = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

zaloRouter.post('/bot/report-preview', async (req, res) => {
  const b = reportBody.parse(req.body ?? {});
  const month = b.month ?? previousMonthVN();
  const pdf = await createReportPdf(month);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Bao-cao-thang-${month}.pdf"`);
  res.send(pdf);
});

zaloRouter.post('/bot/report-send', async (req, res) => {
  const b = reportBody.parse(req.body ?? {});
  const month = b.month ?? previousMonthVN();
  const cfg = await getBotCfg();
  if (!cfg.token || !cfg.ptGroup) throw badRequest('BOT_INCOMPLETE', 'Token và mã nhóm PT & Sale là bắt buộc');
  if (!driveReady(await getReportCfg())) throw badRequest('REPORT_INCOMPLETE', 'Chưa dán địa chỉ Web app Apps Script cho báo cáo tháng');
  try {
    const url = await publishReport(cfg, month, (t) => sendText(cfg, cfg.ptGroup, t));
    await audit(req.auth!.userId, 'zalo_bot.report_sent', { month }, req.ip);
    res.json({ data: { month, url } });
  } catch (e) {
    throw badRequest('REPORT_FAILED', e instanceof Error ? e.message : 'Không gửi được báo cáo');
  }
});

zaloRouter.post('/bot/send-test', async (_req, res) => {
  const cfg = await getBotCfg();
  if (!cfg.token || !cfg.ptGroup) throw badRequest('BOT_INCOMPLETE', 'Token and PT group are required');
  const r = await sendText(cfg, cfg.ptGroup, 'Bot đã kết nối với DemoGym. Tin thử, anh chị có thể bỏ qua ạ.');
  res.json({ data: { ok: !!r?.ok, message: r ? (r.ok ? 'ok' : String(r.description ?? r.error_code ?? 'error')) : 'Không kết nối được Zalo' } });
});
