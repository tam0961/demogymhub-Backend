import { renderTpl } from '../zalobot/clean';
import { ptTemplates, type BotCfg } from '../zalobot/config';
import { getReportCfg, saveReportCfg, driveReady } from './config';
import { buildReport, previousMonthVN } from './data';
import { uploadPdf } from './drive';
import { reportPdf } from './pdf';

export async function createReportPdf(month: string): Promise<Buffer> {
  return reportPdf(await buildReport(month));
}

/** Builds the report PDF, uploads it to Drive and posts the link; returns the link. */
export async function publishReport(bot: BotCfg, month: string, say: (text: string) => Promise<unknown>): Promise<string> {
  const rc = await getReportCfg();
  if (!driveReady(rc)) throw new Error('Chưa dán địa chỉ Web app Apps Script cho báo cáo tháng');
  const pdf = await createReportPdf(month);
  const url = await uploadPdf(rc, `Bao-cao-thang-${month}.pdf`, pdf);
  await say(renderTpl(ptTemplates(bot).report, { month: `${month.slice(5, 7)}/${month.slice(0, 4)}`, link: url, bot: bot.botName }));
  await saveReportCfg({ ...rc, last: { month, url, at: new Date().toISOString() } });
  return url;
}

export interface ReportDeps {
  say: (text: string) => Promise<unknown>;
  once: (key: string) => Promise<boolean>;
  release: (key: string) => Promise<unknown>;
}

/** 07:00 on the 1st (VN): sends last month's report once; a failed attempt is retried by the next minute tick within 10 minutes. */
export async function runMonthlyReport(bot: BotCfg, deps: ReportDeps, now: { date: string; h: number; mi: number }, at = new Date()) {
  if (!bot.enabled || !bot.token || !bot.ptGroup) return;
  if (now.date.slice(8, 10) !== '01' || now.h !== 7 || now.mi >= 10) return;
  const rc = await getReportCfg();
  if (!rc.on || !driveReady(rc)) return;
  const month = previousMonthVN(at);
  const key = `monthly:${month}`;
  if (!(await deps.once(key))) return;
  try {
    await publishReport(bot, month, deps.say);
  } catch (e) {
    await deps.release(key);
    throw e;
  }
}
