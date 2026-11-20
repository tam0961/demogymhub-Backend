import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { badRequest, HttpError, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchAllowed } from '../rbac/service';
import { VAT_RATES, computeInvoice, getInvoiceCfg, getInvoicePass, moneyWords, saveInvoiceCfg, saveInvoicePass, sendToViettel, validateInvoice, type InvoiceInput } from './service';

export const invoiceRouter = Router();
invoiceRouter.use(authenticate);

const uuid = z.string().uuid();
const short = (n: number) => z.string().trim().max(n);

invoiceRouter.get('/config', authorize('system.manage_settings'), async (_req, res) => {
  res.json({ data: { cfg: await getInvoiceCfg(), has_pass: !!(await getInvoicePass()), vat_rates: VAT_RATES } });
});

const cfgSchema = z.object({
  live: z.boolean(),
  base: short(200),
  supplierCode: short(40),
  invoiceType: short(20),
  templateCode: short(40),
  user: short(80),
  vat: z.number().refine((v) => VAT_RATES.includes(v)),
  sellerName: short(200),
  sellerTaxCode: short(30),
  sellerAddress: short(300),
  sellerPhone: short(30),
  sellerEmail: short(120),
  sellerBank: short(100),
  sellerAccount: short(40),
  pass: z.string().max(200).optional(),
});

invoiceRouter.put('/config', authorize('system.manage_settings'), async (req, res) => {
  const b = cfgSchema.parse(req.body);
  const { pass, ...cfg } = b;
  cfg.base = cfg.base.replace(/\/+$/, '');
  if (!/^https:\/\//i.test(cfg.base)) throw badRequest('BASE_HTTPS', 'Địa chỉ máy chủ Viettel phải bắt đầu bằng https://');
  await saveInvoiceCfg(cfg);
  if (pass) await saveInvoicePass(pass);
  await audit(req.auth!.userId, 'invoice.config_updated', { live: cfg.live }, req.ip);
  res.json({ data: { cfg: await getInvoiceCfg(), has_pass: !!(await getInvoicePass()), vat_rates: VAT_RATES } });
});

invoiceRouter.get('/config/public', authorize('payments.create'), async (_req, res) => {
  const c = await getInvoiceCfg();
  res.json({ data: { live: c.live, vat: c.vat, vat_rates: VAT_RATES } });
});

const issueSchema = z.object({
  contract_id: uuid.nullish(),
  payment_id: uuid.nullish(),
  buyer: z.object({ name: short(200).optional(), legalName: short(200).optional(), taxCode: short(30).optional(), address: short(300).optional(), email: short(120).optional(), phone: short(30).optional() }),
  items: z.array(z.object({ name: short(300), unit: short(30).optional(), qty: z.number().int().min(1).max(1000).optional(), gross: z.number().int().min(0).max(10_000_000_000), vat: z.number().optional() })).min(1).max(50),
  pay_method: short(40).optional(),
});

invoiceRouter.post('/issue', authorize('payments.create'), async (req, res) => {
  const b = issueSchema.parse(req.body);
  if (b.contract_id) {
    const c = await prisma.contract.findUnique({ where: { id: b.contract_id }, select: { branchId: true } });
    if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Contract not found');
  }
  const cfg = await getInvoiceCfg();
  const input: InvoiceInput = { buyer: b.buyer, items: b.items, payMethod: b.pay_method };
  const calc = computeInvoice(input, cfg.vat);
  const errors = validateInvoice(input, calc);
  if (errors.length) throw badRequest('INVOICE_INVALID', errors.join('. '));
  const r = await sendToViettel(cfg, input, calc);
  const buyerName = (b.buyer.legalName || b.buyer.name || '').trim();
  const row = await prisma.invoice.create({
    data: {
      contractId: b.contract_id ?? null,
      paymentId: b.payment_id ?? null,
      status: r.ok ? (r.status ?? 'test') : 'failed',
      invoiceNo: r.invoiceNo || null,
      reservationCode: r.reservationCode || null,
      transactionId: r.transactionId || null,
      buyerName,
      buyerTaxCode: b.buyer.taxCode?.replace(/\s/g, '') || null,
      net: calc.net,
      tax: calc.tax,
      total: calc.total,
      payload: { input, calc } as unknown as Prisma.InputJsonValue,
      error: r.ok ? null : (r.errors ?? []).join('. '),
      createdBy: req.auth!.userId,
    },
  });
  await audit(req.auth!.userId, r.ok ? 'invoice.issued' : 'invoice.failed', { invoice_id: row.id, status: row.status, total: calc.total, contract_id: b.contract_id ?? null }, req.ip, row.id);
  if (!r.ok) throw new HttpError(r.httpStatus ?? 502, 'INVOICE_FAILED', (r.errors ?? []).join('. '));
  res.status(201).json({ data: { id: row.id, status: row.status, live: cfg.live, note: r.note ?? null, invoice_no: row.invoiceNo, reservation_code: row.reservationCode, calc, words: moneyWords(calc.total) } });
});

invoiceRouter.get('/', authorize('payments.read'), async (req, res) => {
  const q = z.object({ contract_id: uuid }).parse(req.query);
  const c = await prisma.contract.findUnique({ where: { id: q.contract_id }, select: { branchId: true } });
  if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Contract not found');
  const rows = await prisma.invoice.findMany({ where: { contractId: q.contract_id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ data: rows.map((r) => ({ id: r.id, status: r.status, invoice_no: r.invoiceNo, buyer_name: r.buyerName, net: r.net, tax: r.tax, total: r.total, error: r.error, created_at: r.createdAt.toISOString() })) });
});
