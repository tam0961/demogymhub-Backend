import { readFileSync } from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ReportData } from './data';

const FONT_DIR = path.resolve(process.cwd(), 'assets', 'fonts');
const vnd = (n: number) => `${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
const num = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const LINE = rgb(0.85, 0.85, 0.85);
const GOLD = rgb(0.96, 0.72, 0);

/** Monthly summary report as an A4 PDF in Be Vietnam Pro so Vietnamese diacritics render. */
export async function reportPdf(d: ReportData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font: PDFFont = await doc.embedFont(readFileSync(path.join(FONT_DIR, 'BeVietnamPro-Regular.ttf')), { subset: true });
  const bold: PDFFont = await doc.embedFont(readFileSync(path.join(FONT_DIR, 'BeVietnamPro-Bold.ttf')), { subset: true });
  const W = 595;
  const H = 842;
  const M = 44;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - 52;

  const ensure = (need: number) => {
    if (y - need < 50) {
      page = doc.addPage([W, H]);
      y = H - 52;
    }
  };
  const text = (s: string, x: number, size = 10.5, f = font, color = INK) => page.drawText(s.normalize('NFC'), { x, y, size, font: f, color });
  const right = (raw: string, xr: number, size = 10.5, f = font) => {
    const s = raw.normalize('NFC');
    page.drawText(s, { x: xr - f.widthOfTextAtSize(s, size), y, size, font: f, color: INK });
  };
  const heading = (s: string) => {
    ensure(40);
    y -= 14;
    page.drawRectangle({ x: M, y: y - 6, width: 4, height: 18, color: GOLD });
    text(s, M + 12, 13, bold);
    y -= 22;
  };
  const row = (cols: { v: string; x: number; r?: boolean; b?: boolean }[], head = false) => {
    ensure(20);
    for (const c of cols) (c.r ? right : text)(c.v, c.x, 10, c.b || head ? bold : font);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: head ? 1 : 0.5, color: head ? MUTED : LINE });
    y -= 14;
  };

  text('TH Gym & Fitness', M, 11, bold, MUTED);
  y -= 26;
  text(`BÁO CÁO THÁNG ${d.label}`, M, 20, bold);
  y -= 18;
  text(`Tạo lúc ${new Date(d.generatedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`, M, 9, font, MUTED);
  y -= 10;

  heading('Tổng quan');
  const t = d.totals;
  const kv: [string, string][] = [
    ['Doanh thu thực thu', vnd(t.revenue)],
    ['Hợp đồng mới', num(t.contractsNew)],
    ['Hội viên mới', num(t.membersNew)],
    ['Lượt check-in', num(t.checkins)],
    ['Buổi PT 1:1 đã dạy', num(t.ptSessions)],
    ['Lớp nhóm đã dạy', num(t.groupClasses)],
    ['Hợp đồng còn nợ (hiện tại)', `${num(t.debtCount)} hợp đồng, ${vnd(t.debtAmount)}`],
    ['Hợp đồng hết hạn trong 7 ngày tới', num(t.expiring7)],
  ];
  for (const [k, v] of kv) row([{ v: k, x: M }, { v, x: W - M, r: true, b: true }]);

  heading('Theo chi nhánh');
  row([{ v: 'Chi nhánh', x: M }, { v: 'Thực thu', x: 300, r: true }, { v: 'HĐ mới', x: 385, r: true }, { v: 'HV mới', x: 460, r: true }, { v: 'Check-in', x: W - M, r: true }], true);
  for (const b of d.branches) row([{ v: b.name, x: M }, { v: vnd(b.revenue), x: 300, r: true }, { v: num(b.contractsNew), x: 385, r: true }, { v: num(b.membersNew), x: 460, r: true }, { v: num(b.checkins), x: W - M, r: true }]);

  heading('Thực thu theo loại gói');
  if (!d.byCategory.length) row([{ v: 'Không có thu trong tháng', x: M }]);
  for (const c of d.byCategory) row([{ v: c.label, x: M }, { v: vnd(c.revenue), x: W - M, r: true }]);

  heading('Thực thu theo nhân viên Sale');
  if (!d.sales.length) row([{ v: 'Chưa có hợp đồng gắn Sale', x: M }]);
  d.sales.forEach((s, i) => row([{ v: `${i + 1}. ${s.name}`, x: M }, { v: vnd(s.revenue), x: W - M, r: true }]));

  heading('PT: buổi dạy trong tháng');
  row([{ v: 'PT', x: M }, { v: 'Buổi 1:1', x: 400, r: true }, { v: 'Lớp nhóm', x: W - M, r: true }], true);
  if (!d.pts.length) row([{ v: 'Chưa có buổi dạy được ghi nhận', x: M }]);
  for (const p of d.pts) row([{ v: p.name, x: M }, { v: num(p.sessions), x: 400, r: true }, { v: num(p.classes), x: W - M, r: true }]);

  ensure(30);
  y -= 6;
  text('Thực thu = tiền đã xác nhận trong tháng trừ tiền hoàn. Công nợ và hợp đồng sắp hết hạn tính tại thời điểm tạo báo cáo.', M, 8.5, font, MUTED);
  return Buffer.from(await doc.save());
}
