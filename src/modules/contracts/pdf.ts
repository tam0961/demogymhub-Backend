import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Contract, Member, Package } from '@prisma/client';
import { fmtDate } from '../../lib/dates';

const ascii = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^ -~]/g, '?');

const vnd = (n: number) => `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} VND`;

export async function contractPdf(c: Contract & { member: Member; package: Package }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (label: string, value: string) => {
    page.drawText(ascii(label), { x: 50, y, size: 11, font: bold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(ascii(value), { x: 200, y, size: 11, font });
    y -= 22;
  };
  page.drawText('GYM MEMBERSHIP CONTRACT', { x: 50, y, size: 18, font: bold });
  y -= 36;
  line('Contract code', c.code);
  line('Status', c.status);
  line('Member', `${c.member.name} (${c.member.code})`);
  line('Phone', c.member.phone);
  line('Package', `${c.package.name} [${c.package.type}]`);
  line('Start date', fmtDate(c.startDate) ?? '-');
  line('End date', fmtDate(c.endDate) ?? '-');
  if (c.sessionsTotal != null) line('Sessions', `${c.sessionsLeft ?? 0} left of ${c.sessionsTotal}`);
  line('Discount', vnd(c.discount));
  line('Total amount', vnd(c.totalAmount));
  line('Paid amount', vnd(c.paidAmount));
  line('Debt', vnd(Math.max(0, c.totalAmount - c.paidAmount)));
  if (c.signedAt) line('Signed at', c.signedAt.toISOString());
  y -= 20;
  page.drawText('Member signature', { x: 50, y, size: 11, font: bold });
  y -= 10;
  const sig = c.signatureData;
  if (sig) {
    let drawn = false;
    try {
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/s.exec(sig);
      const bytes = Buffer.from(m ? m[2] : sig, 'base64');
      const isJpg = m ? m[1] !== 'png' : bytes[0] === 0xff;
      const img = isJpg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
      const s = Math.min(220 / img.width, 100 / img.height, 1);
      page.drawImage(img, { x: 50, y: y - img.height * s, width: img.width * s, height: img.height * s });
      drawn = true;
    } catch {
      drawn = false;
    }
    if (!drawn) page.drawText(ascii(`Signed: ${sig.slice(0, 60)}`), { x: 50, y: y - 16, size: 11, font });
  } else {
    page.drawText('(not signed)', { x: 50, y: y - 16, size: 11, font, color: rgb(0.5, 0.5, 0.5) });
  }
  return Buffer.from(await doc.save());
}
