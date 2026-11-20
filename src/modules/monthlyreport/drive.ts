import type { ReportCfg } from './config';

export class DriveError extends Error {}

/** Sends the PDF to the owner's Google Apps Script web app, which saves it in the owner's Drive and returns the view link. */
export async function uploadPdf(c: ReportCfg, name: string, pdf: Buffer): Promise<string> {
  let res: Response;
  try {
    res = await fetch(c.scriptUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: c.secret, name, share: c.shareLink, pdf: pdf.toString('base64') }),
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new DriveError(`Không kết nối được Apps Script: ${e instanceof Error ? e.message : 'lỗi mạng'}`);
  }
  const text = await res.text().catch(() => '');
  let j: { ok?: boolean; url?: string; error?: string } | null = null;
  try {
    j = JSON.parse(text);
  } catch {
    j = null;
  }
  if (!j) throw new DriveError('Apps Script không trả kết quả hợp lệ. Kiểm tra đã triển khai Web app với quyền truy cập "Bất kỳ ai"');
  if (!j.ok || !j.url) throw new DriveError(`Apps Script báo lỗi: ${j.error ?? 'không rõ'}`);
  return j.url;
}
