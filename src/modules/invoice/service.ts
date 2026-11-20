import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const VAT_RATES = [0, 5, 8, 10];
const CFG_KEY = 'invoice_cfg';
const AUTH_KEY = 'invoice_auth';

export interface InvoiceCfg {
  live: boolean;
  base: string;
  supplierCode: string;
  invoiceType: string;
  templateCode: string;
  user: string;
  vat: number;
  sellerName: string;
  sellerTaxCode: string;
  sellerAddress: string;
  sellerPhone: string;
  sellerEmail: string;
  sellerBank: string;
  sellerAccount: string;
}

const DEF_CFG: InvoiceCfg = {
  live: false,
  base: 'https://demo-sinvoice.viettel.vn:8443',
  supplierCode: '',
  invoiceType: '',
  templateCode: '',
  user: '',
  vat: 10,
  sellerName: '',
  sellerTaxCode: '',
  sellerAddress: '',
  sellerPhone: '',
  sellerEmail: '',
  sellerBank: '',
  sellerAccount: '',
};

const str = (x: unknown, n: number) => String(x == null ? '' : x).slice(0, n);

export async function getInvoiceCfg(): Promise<InvoiceCfg> {
  const row = await prisma.setting.findUnique({ where: { key: CFG_KEY } });
  return { ...DEF_CFG, ...((row?.value ?? {}) as Partial<InvoiceCfg>) };
}
export async function saveInvoiceCfg(cfg: InvoiceCfg) {
  const value = cfg as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: CFG_KEY }, create: { key: CFG_KEY, value }, update: { value } });
}
export async function getInvoicePass(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: AUTH_KEY } });
  return String((row?.value as { pass?: string } | null)?.pass ?? '');
}
export async function saveInvoicePass(pass: string) {
  const value = { pass } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: AUTH_KEY }, create: { key: AUTH_KEY, value }, update: { value } });
}

const WD = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
function read3(n: number, full: boolean) {
  const tr = Math.floor(n / 100);
  const ch = Math.floor((n % 100) / 10);
  const dv = n % 10;
  let s = '';
  if (tr > 0 || full) s += `${WD[tr]} trăm`;
  if (ch > 1) {
    s += ` ${WD[ch]} mươi`;
    if (dv === 1) s += ' mốt';
    else if (dv === 5) s += ' lăm';
    else if (dv > 0) s += ` ${WD[dv]}`;
  } else if (ch === 1) {
    s += ' mười';
    if (dv === 5) s += ' lăm';
    else if (dv > 0) s += ` ${WD[dv]}`;
  } else if (dv > 0) {
    if (tr > 0 || full) s += ' lẻ';
    s += ` ${WD[dv]}`;
  }
  return s.trim();
}
export function moneyWords(value: number) {
  let n = Math.round(Math.abs(Number(value) || 0));
  if (!n) return 'Không đồng';
  const U = ['', 'nghìn', 'triệu', 'tỷ'];
  const g: number[] = [];
  while (n > 0) {
    g.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const p: string[] = [];
  for (let i = g.length - 1; i >= 0; i--) {
    if (g[i] === 0) continue;
    p.push(read3(g[i], i < g.length - 1) + (U[i] ? ` ${U[i]}` : ''));
  }
  const s = `${p.join(' ')} đồng`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface InvoiceInput {
  buyer?: { name?: string; legalName?: string; taxCode?: string; address?: string; email?: string; phone?: string };
  items?: { name?: string; unit?: string; qty?: number; gross?: number; vat?: number }[];
  payMethod?: string;
}
export interface Line {
  line: number;
  name: string;
  unit: string;
  qty: number;
  vat: number;
  gross: number;
  net: number;
  tax: number;
  unitPrice: number;
}
export interface Calc {
  items: Line[];
  breakdown: { vat: number; net: number; tax: number }[];
  net: number;
  tax: number;
  total: number;
}

/** gross = amount paid for the line, VAT included. net = round(gross / (1 + vat)), tax = gross - net. */
export function computeInvoice(input: InvoiceInput, defVat: number): Calc {
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 50).map((x, i) => {
    const gross = Math.round(Number(x.gross) || 0);
    const vat = VAT_RATES.includes(Number(x.vat)) ? Number(x.vat) : VAT_RATES.includes(Number(defVat)) ? Number(defVat) : 10;
    const qty = Math.max(1, Math.round(Number(x.qty) || 1));
    const net = Math.round(gross / (1 + vat / 100));
    return { line: i + 1, name: str(x.name, 300).trim(), unit: str(x.unit || 'Gói', 30).trim() || 'Gói', qty, vat, gross, net, tax: gross - net, unitPrice: Math.round(net / qty) };
  });
  const by: Record<number, { vat: number; net: number; tax: number }> = {};
  for (const it of items) {
    const b = (by[it.vat] ??= { vat: it.vat, net: 0, tax: 0 });
    b.net += it.net;
    b.tax += it.tax;
  }
  const net = items.reduce((a, x) => a + x.net, 0);
  const tax = items.reduce((a, x) => a + x.tax, 0);
  return { items, breakdown: Object.values(by), net, tax, total: net + tax };
}

export function validateInvoice(input: InvoiceInput, calc: Calc): string[] {
  const e: string[] = [];
  const b = input.buyer ?? {};
  if (!calc.items.length) e.push('Chưa có dòng hàng nào');
  for (const x of calc.items) {
    if (!x.name) e.push(`Dòng ${x.line} chưa có tên hàng`);
    if (!(x.gross > 0)) e.push(`Dòng ${x.line} phải có số tiền lớn hơn 0`);
  }
  if (!str(b.name, 200).trim() && !str(b.legalName, 200).trim()) e.push('Chưa có tên người mua');
  if (b.taxCode && !/^\d{10}(-\d{3})?$|^\d{13}$/.test(String(b.taxCode).replace(/\s/g, ''))) e.push('Mã số thuế người mua không đúng (10 số, hoặc 13 số / 10 số-3 số)');
  if (b.taxCode && !str(b.legalName, 200).trim()) e.push('Có mã số thuế thì cần tên đơn vị');
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) e.push('Email người mua không đúng');
  return e;
}

export function buildViettelBody(cfg: InvoiceCfg, input: InvoiceInput, calc: Calc) {
  const b = input.buyer ?? {};
  return {
    generalInvoiceInfo: { invoiceType: cfg.invoiceType, templateCode: cfg.templateCode, currencyCode: 'VND', adjustmentType: '1', paymentStatus: true, cusGetInvoiceRight: true, userName: cfg.user },
    buyerInfo: {
      buyerName: str(b.name, 200).trim(),
      buyerLegalName: str(b.legalName, 200).trim(),
      buyerTaxCode: String(b.taxCode || '').replace(/\s/g, ''),
      buyerAddressLine: str(b.address, 300).trim(),
      buyerPhoneNumber: str(b.phone, 30).trim(),
      buyerEmail: str(b.email, 120).trim(),
    },
    sellerInfo: { sellerLegalName: cfg.sellerName, sellerTaxCode: cfg.sellerTaxCode, sellerAddressLine: cfg.sellerAddress, sellerPhoneNumber: cfg.sellerPhone, sellerEmail: cfg.sellerEmail, sellerBankName: cfg.sellerBank, sellerBankAccount: cfg.sellerAccount },
    payments: [{ paymentMethodName: str(input.payMethod || 'TM/CK', 40) }],
    itemInfo: calc.items.map((x) => ({ lineNumber: x.line, itemName: x.name, unitName: x.unit, unitPrice: x.unitPrice, quantity: x.qty, itemTotalAmountWithoutTax: x.net, taxPercentage: x.vat, taxAmount: x.tax, discount: 0, itemDiscount: 0 })),
    summarizeInfo: { sumOfTotalLineAmountWithoutTax: calc.net, totalAmountWithoutTax: calc.net, totalTaxAmount: calc.tax, totalAmountWithTax: calc.total, totalAmountWithTaxInWords: moneyWords(calc.total), discountAmount: 0, settlementDiscountAmount: 0 },
    taxBreakdowns: calc.breakdown.map((x) => ({ taxPercentage: x.vat, taxableAmount: x.net, taxAmount: x.tax })),
  };
}

export interface IssueResult {
  ok: boolean;
  status?: 'test' | 'issued';
  errors?: string[];
  httpStatus?: number;
  invoiceNo?: string;
  reservationCode?: string;
  transactionId?: string;
  note?: string;
}

/** Sends the invoice to Viettel S-Invoice, or only validates it in test mode. Viettel only accepts calls from the registered IP. */
export async function sendToViettel(cfg: InvoiceCfg, input: InvoiceInput, calc: Calc): Promise<IssueResult> {
  if (!cfg.live) return { ok: true, status: 'test', note: 'Chế độ chạy thử: đã tính và kiểm tra, chưa gửi cho Viettel.' };
  const pass = await getInvoicePass();
  const miss: string[] = [];
  if (!cfg.supplierCode) miss.push('mã số thuế dùng trong đường dẫn (supplierCode)');
  if (!cfg.invoiceType) miss.push('loại hóa đơn');
  if (!cfg.templateCode) miss.push('mẫu số');
  if (!cfg.sellerTaxCode) miss.push('mã số thuế bên bán');
  if (!cfg.user) miss.push('tài khoản API');
  if (!pass) miss.push('mật khẩu API');
  if (miss.length) return { ok: false, httpStatus: 400, errors: [`Chưa cấu hình: ${miss.join(', ')}`] };
  const url = `${cfg.base}/InvoiceAPI/InvoiceWS/createInvoice/${encodeURIComponent(cfg.supplierCode)}`;
  let res: Response;
  let text = '';
  let j: { errorCode?: unknown; description?: string; message?: string; result?: Record<string, unknown>; data?: Record<string, unknown> } | null = null;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Basic ${Buffer.from(`${cfg.user}:${pass}`).toString('base64')}` },
      body: JSON.stringify(buildViettelBody(cfg, input, calc)),
      signal: AbortSignal.timeout(30000),
    });
    text = await res.text();
    try {
      j = JSON.parse(text);
    } catch {
      j = null;
    }
  } catch (e) {
    return { ok: false, httpStatus: 502, errors: [`Không kết nối được Viettel: ${str(e instanceof Error ? e.message : e, 160)}`] };
  }
  const r = (j?.result ?? j?.data ?? {}) as Record<string, unknown>;
  if (!res.ok || !j || (j.errorCode && String(j.errorCode) !== '0')) {
    return { ok: false, httpStatus: 502, errors: [`Viettel từ chối (${res.status}): ${str(j?.description || j?.message || j?.errorCode || text, 200)}${res.status === 500 ? '. Kiểm tra tài khoản API và địa chỉ IP đã đăng ký với Viettel' : ''}`] };
  }
  return { ok: true, status: 'issued', invoiceNo: str(r.invoiceNo, 40), reservationCode: str(r.reservationCode, 60), transactionId: str(r.transactionID || r.transactionUuid, 80) };
}
