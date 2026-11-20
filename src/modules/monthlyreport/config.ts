import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export interface ReportCfg {
  on: boolean;
  scriptUrl: string;
  secret: string;
  shareLink: boolean;
  last: { month: string; url: string; at: string } | null;
}

const KEY = 'zalobot_report';

export async function getReportCfg(): Promise<ReportCfg> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const v = (row?.value ?? {}) as Partial<ReportCfg>;
  return { on: false, scriptUrl: '', secret: '', shareLink: true, last: null, ...v };
}

export async function saveReportCfg(cfg: ReportCfg) {
  const value = cfg as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

export const driveReady = (c: ReportCfg) => !!(c.scriptUrl && c.secret);

/** Secret shared with the owner's Google Apps Script; created once and never returned by the config endpoint. */
export async function ensureSecret(): Promise<ReportCfg> {
  const c = await getReportCfg();
  if (c.secret) return c;
  c.secret = crypto.randomBytes(18).toString('base64url');
  await saveReportCfg(c);
  return c;
}

export function publicReportCfg(c: ReportCfg) {
  return { report_on: c.on, report_script_url: c.scriptUrl, report_share_link: c.shareLink, report_last: c.last, report_ready: driveReady(c) };
}

const FOLDER = 'Báo cáo TH Gym';

/** Code the owner pastes into script.google.com; the secret is filled in so only the web app URL has to be copied back. */
export function appsScriptCode(secret: string) {
  return [
    `const SECRET = '${secret}';`,
    `const FOLDER_NAME = '${FOLDER}';`,
    '',
    'function doPost(e) {',
    '  try {',
    '    const b = JSON.parse(e.postData.contents);',
    "    if (b.key !== SECRET) return out({ ok: false, error: 'Sai ma bi mat' });",
    '    const it = DriveApp.getFoldersByName(FOLDER_NAME);',
    '    const folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);',
    "    const blob = Utilities.newBlob(Utilities.base64Decode(b.pdf), 'application/pdf', b.name);",
    '    const file = folder.createFile(blob);',
    '    if (b.share) file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);',
    '    return out({ ok: true, url: file.getUrl() });',
    '  } catch (err) {',
    '    return out({ ok: false, error: String(err) });',
    '  }',
    '}',
    '',
    'function out(o) {',
    '  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);',
    '}',
  ].join(String.fromCharCode(10));
}
