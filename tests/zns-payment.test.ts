import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { getZns, saveZns, sendPaymentReminders, ZNS_EVENTS } from '../src/modules/zalo/service';

const sfx = Date.now().toString(36);
const calls: { body: { template_id?: string; template_data?: Record<string, string> } }[] = [];
let ids: string[] = [];

beforeAll(async () => {
  const br = await prisma.branch.create({ data: { code: `zp${sfx}`, name: 'ZP' } });
  const pkg = await prisma.package.create({ data: { name: `ZP ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: br.id } });
  const today = dateOnly(todayVN());
  const mk = async (n: number, paid: number, due: Date | null, status: 'active' | 'draft' = 'active') => {
    const m = await prisma.member.create({ data: { code: `ZP${sfx}${n}`, name: `Khach ${n}`, phone: `0988${sfx.replace(/\D/g, '').padEnd(3, '1').slice(0, 3)}${n}00`, branchId: br.id } });
    const c = await prisma.contract.create({ data: { code: `ZPC${sfx}${n}`, memberId: m.id, packageId: pkg.id, branchId: br.id, status, totalAmount: 3_000_000, paidAmount: paid, paymentDueDate: due } });
    ids.push(c.id);
  };
  await mk(1, 1_000_000, addDays(today, 3));
  await mk(2, 3_000_000, addDays(today, 3));
  await mk(3, 0, addDays(today, 5));
  await mk(4, 500_000, addDays(today, 0));
  await mk(5, 0, addDays(today, 3), 'draft');
  const cfg = await getZns();
  cfg.accessToken = 'TOKEN';
  cfg.events.payment_due = { enabled: true, templateId: 'T-PAY', days: [3, 0], params: { name: 'customer_name', money: 'amount_due', due: 'due_date' } };
  await saveZns(cfg);
});

afterEach(() => vi.unstubAllGlobals());

describe('ZNS payment reminder replaces the renewal message', () => {
  it('has payment_due and no renewal event', () => {
    expect(ZNS_EVENTS).toContain('payment_due');
    expect(ZNS_EVENTS).not.toContain('renewal');
  });

  it('sends once per milestone only for contracts that still owe money', async () => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (_u: string, init?: { body?: string }) => {
      calls.push({ body: JSON.parse(init!.body!) });
      return { json: async () => ({ error: 0 }), status: 200 };
    });
    const first = await sendPaymentReminders();
    const mine = calls.filter((c) => c.body.template_data?.name?.startsWith('Khach '));
    expect(first.sent).toBeGreaterThanOrEqual(2);
    expect(mine.map((c) => c.body.template_data!.name).sort()).toEqual(['Khach 1', 'Khach 4']);
    const k1 = mine.find((c) => c.body.template_data!.name === 'Khach 1')!;
    expect(k1.body.template_id).toBe('T-PAY');
    expect(k1.body.template_data!.money).toBe('2.000.000');
    const again = await sendPaymentReminders();
    expect(calls.filter((c) => c.body.template_data?.name?.startsWith('Khach ')).length).toBe(2);
    expect(again.sent).toBe(0);
  });
});
