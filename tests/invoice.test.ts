import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { moneyWords } from '../src/modules/invoice/service';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let BR = '';
let owner = '';
let recep = '';
let sales = '';
let contractId = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const body = (over: object = {}) => ({
  contract_id: contractId,
  buyer: { name: 'Nguyen Van A', email: 'a@b.vn' },
  items: [{ name: 'Goi 3 thang', gross: 1_100_000 }],
  ...over,
});

beforeAll(async () => {
  BR = (await prisma.branch.create({ data: { code: `iv${sfx}`, name: 'IV' } })).id;
  await makeUser(`owner@iv${sfx}.test`, 'owner', null);
  owner = await tokenFor(`owner@iv${sfx}.test`);
  await makeUser(`rec@iv${sfx}.test`, 'receptionist', `iv${sfx}`);
  recep = await tokenFor(`rec@iv${sfx}.test`);
  await makeUser(`sale@iv${sfx}.test`, 'sales', `iv${sfx}`);
  sales = await tokenFor(`sale@iv${sfx}.test`);
  const m = await prisma.member.create({ data: { code: `IV${sfx}`, name: 'IV M', phone: `iv${sfx}`, branchId: BR } });
  const pkg = await prisma.package.create({ data: { name: `IV ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: BR } });
  contractId = (await prisma.contract.create({ data: { code: `IVC${sfx}`, memberId: m.id, packageId: pkg.id, branchId: BR, status: 'active', totalAmount: 1_100_000, paidAmount: 1_100_000 } })).id;
});

afterEach(() => vi.unstubAllGlobals());

describe('invoices', () => {
  it('reads money in Vietnamese words', () => {
    expect(moneyWords(0)).toBe('Không đồng');
    expect(moneyWords(1_100_000)).toBe('Một triệu một trăm nghìn đồng');
    expect(moneyWords(21_015)).toBe('Hai mươi mốt nghìn không trăm mười lăm đồng');
  });

  it('keeps settings with the owner and hides the password', async () => {
    expect((await request(app).get('/api/invoices/config').set(auth(recep))).status).toBe(403);
    const put = await request(app).put('/api/invoices/config').set(auth(owner)).send({ live: false, base: 'https://demo-sinvoice.viettel.vn:8443/', supplierCode: '0100109106-501', invoiceType: '1', templateCode: '1/1', user: 'u', vat: 8, sellerName: 'TH Gym', sellerTaxCode: '0100109106', sellerAddress: '', sellerPhone: '', sellerEmail: '', sellerBank: '', sellerAccount: '', pass: 'secret' });
    expect(put.status).toBe(200);
    expect(put.body.data.has_pass).toBe(true);
    expect(JSON.stringify(put.body)).not.toContain('secret');
    expect(put.body.data.cfg.base).toBe('https://demo-sinvoice.viettel.vn:8443');
    expect((await request(app).put('/api/invoices/config').set(auth(owner)).send({ ...put.body.data.cfg, base: 'http://x.vn', live: false })).status).toBe(400);
    const pub = await request(app).get('/api/invoices/config/public').set(auth(recep));
    expect(pub.body.data).toEqual({ live: false, vat: 8, vat_rates: [0, 5, 8, 10] });
    expect((await request(app).get('/api/invoices/config/public').set(auth(sales))).status).toBe(403);
  });

  it('computes VAT included amounts in test mode and records the invoice', async () => {
    const r = await request(app).post('/api/invoices/issue').set(auth(recep)).send(body({ items: [{ name: 'Goi 3 thang', gross: 1_080_000 }, { name: 'Khan', gross: 110_000, vat: 10 }] }));
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('test');
    expect(r.body.data.calc).toMatchObject({ net: 1_000_000 + 100_000, tax: 80_000 + 10_000, total: 1_190_000 });
    expect(r.body.data.words).toBe('Một triệu một trăm chín mươi nghìn đồng');
    const list = await request(app).get('/api/invoices').query({ contract_id: contractId }).set(auth(recep));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ status: 'test', total: 1_190_000, buyer_name: 'Nguyen Van A' });
  });

  it('rejects invalid buyers and lines', async () => {
    expect((await request(app).post('/api/invoices/issue').set(auth(recep)).send(body({ buyer: {} }))).status).toBe(400);
    expect((await request(app).post('/api/invoices/issue').set(auth(recep)).send(body({ buyer: { name: 'A', taxCode: '12' } }))).status).toBe(400);
    expect((await request(app).post('/api/invoices/issue').set(auth(recep)).send(body({ items: [{ name: 'x', gross: 0 }] }))).status).toBe(400);
    expect((await request(app).post('/api/invoices/issue').set(auth(sales)).send(body())).status).toBe(403);
  });

  it('sends to Viettel in live mode and keeps failures', async () => {
    const cfg = (await request(app).get('/api/invoices/config').set(auth(owner))).body.data.cfg;
    await request(app).put('/api/invoices/config').set(auth(owner)).send({ ...cfg, live: true }).expect(200);
    let seen: { url: string; auth: string; body: { summarizeInfo: { totalAmountWithTax: number } } } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ errorCode: null, result: { invoiceNo: 'C26TAA1', reservationCode: 'RSV1', transactionID: 'T1' } }) };
    });
    const ok = await request(app).post('/api/invoices/issue').set(auth(recep)).send(body());
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'issued', invoice_no: 'C26TAA1', live: true });
    expect(seen!.url).toBe('https://demo-sinvoice.viettel.vn:8443/InvoiceAPI/InvoiceWS/createInvoice/0100109106-501');
    expect(seen!.auth).toBe(`Basic ${Buffer.from('u:secret').toString('base64')}`);
    expect(seen!.body.summarizeInfo.totalAmountWithTax).toBe(1_100_000);

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => '{"description":"IP not allowed"}' }));
    const bad = await request(app).post('/api/invoices/issue').set(auth(recep)).send(body());
    expect(bad.status).toBe(502);
    const list = await request(app).get('/api/invoices').query({ contract_id: contractId }).set(auth(recep));
    expect(list.body.data.map((x: { status: string }) => x.status)).toContain('failed');
    await request(app).put('/api/invoices/config').set(auth(owner)).send({ ...cfg, live: false }).expect(200);
  });
});
