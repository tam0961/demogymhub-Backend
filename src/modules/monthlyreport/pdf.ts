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

  const at = (s: string, x: number, yy: number, size = 8, f = font, color = INK) => page.drawText(s.normalize('NFC'), { x, y: yy, size, font: f, color });
  const atRight = (s: string, xr: number, yy: number, size = 8, f = font, color = INK) => at(s, xr - f.widthOfTextAtSize(s.normalize('NFC'), size), yy, size, f, color);
  const COLORS = [rgb(0.96, 0.72, 0), rgb(0.15, 0.15, 0.15), rgb(0.1, 0.6, 0.55), rgb(0.2, 0.45, 0.85), rgb(0.6, 0.35, 0.8), rgb(0.85, 0.35, 0.3)];
  const pts = d.ptKpi;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const lbl = (a: number, b: number) => (b > 0 ? `${pct(a, b)}% (${a}/${b})` : '-');

  heading('Chỉ số quan trọng của PT 1:1: buổi dạy theo tuần');
  if (!pts.length) row([{ v: 'Chưa có buổi dạy được ghi nhận', x: M }]);
  else {
    const CH = 110;
    ensure(CH + 60);
    let lx = M;
    for (const [k, p] of pts.entries()) {
      page.drawRectangle({ x: lx, y: y - 2, width: 8, height: 8, color: COLORS[k % COLORS.length] });
      const t = `${p.name}: ${num(p.sessions)} buổi, TB ${String(p.perDay).replace('.', ',')}/ngày`;
      at(t, lx + 12, y - 1, 8.5);
      lx += 12 + font.widthOfTextAtSize(t.normalize('NFC'), 8.5) + 16;
    }
    y -= 16;
    const base = y - CH;
    const max = Math.max(1, ...pts.flatMap((p) => p.weeks));
    const gw = (W - 2 * M) / 5;
    const bw = Math.min(22, (gw - 16) / pts.length);
    page.drawLine({ start: { x: M, y: base }, end: { x: W - M, y: base }, thickness: 0.8, color: MUTED });
    for (let w = 0; w < 5; w++) {
      const x0 = M + w * gw + (gw - bw * pts.length) / 2;
      for (const [k, p] of pts.entries()) {
        const h = (p.weeks[w] / max) * (CH - 14);
        if (h > 0) page.drawRectangle({ x: x0 + k * bw, y: base, width: bw - 2, height: h, color: COLORS[k % COLORS.length] });
        const v = num(p.weeks[w]);
        at(v, x0 + k * bw + (bw - 2) / 2 - font.widthOfTextAtSize(v, 7.5) / 2, base + h + 3, 7.5);
      }
      const name = `Tuần ${w + 1}`;
      at(name, M + w * gw + gw / 2 - font.widthOfTextAtSize(name, 8) / 2, base - 12, 8, font, MUTED);
    }
    y = base - 26;
  }

  heading('Chỉ số quan trọng của PT 1:1: chất lượng');
  const metrics: { title: string; sub: string; val: (p: (typeof pts)[number]) => [number, number] }[] = [
    { title: 'Hoàn thành buổi', sub: 'buổi hoàn thành / tổng book hẹn', val: (p) => [p.completed, p.booked] },
    { title: 'Hủy hoặc không đến', sub: 'buổi hủy, không đến / tổng book hẹn', val: (p) => [p.cancelled, p.booked] },
    { title: 'Chuyển đổi PT 1:1', sub: 'hợp đồng PT 1:1 / lead đã chia', val: (p) => [p.contractsPt, p.leads] },
    { title: 'Chuyển đổi nhóm', sub: 'hợp đồng nhóm / lead đã chia', val: (p) => [p.contractsGroup, p.leads] },
    { title: 'Khách off track', sub: 'quá 14 ngày không đi tập / tổng khách PT 1:1', val: (p) => [p.offTrack, p.customers] },
    { title: 'Tỉ lệ renew', sub: 'hợp đồng renew / tổng khách PT 1:1', val: (p) => [p.renewed, p.customers] },
  ];
  if (!pts.length) row([{ v: 'Chưa có dữ liệu', x: M }]);
  const PW = 245;
  const panel = (x: number, top: number, m: (typeof metrics)[number]) => {
    at(m.title, x, top - 10, 10, bold);
    at(m.sub, x, top - 22, 7.5, font, MUTED);
    let yy = top - 38;
    for (const [k, p] of pts.entries()) {
      const [a, b] = m.val(p);
      at(p.name.length > 14 ? `${p.name.slice(0, 13)}.` : p.name, x, yy, 8);
      const tx = x + 78;
      const tw = PW - 78 - 70;
      page.drawRectangle({ x: tx, y: yy - 2, width: tw, height: 9, color: rgb(0.93, 0.93, 0.93) });
      const w = (Math.min(100, pct(a, b)) / 100) * tw;
      if (w > 0) page.drawRectangle({ x: tx, y: yy - 2, width: w, height: 9, color: COLORS[k % COLORS.length] });
      atRight(lbl(a, b), x + PW, yy, 8, bold);
      yy -= 16;
    }
    return top - yy + 4;
  };
  for (let i = 0; i < metrics.length; i += 2) {
    const h = 38 + pts.length * 16 + 8;
    ensure(h);
    const top = y;
    const used = Math.max(panel(M, top, metrics[i]), metrics[i + 1] ? panel(M + PW + 17, top, metrics[i + 1]) : 0);
    y = top - used - 6;
  }

  ensure(30);
  y -= 6;
  text('Thực thu = tiền đã xác nhận trong tháng trừ tiền hoàn. Công nợ và hợp đồng sắp hết hạn tính tại thời điểm tạo báo cáo.', M, 8.5, font, MUTED);
  return Buffer.from(await doc.save());
}
