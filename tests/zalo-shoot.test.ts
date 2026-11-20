import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import type { BotCfg } from '../src/modules/zalobot/config';
import { handleShoot, parseShoot, parseShootLines, runShootReminders, shootWeek } from '../src/modules/zalobot/shoot';

const sent: string[] = [];
const seen = new Set<string>();
const deps = {
  say: async (t: string) => {
    sent.push(t);
  },
  once: async (k: string) => {
    if (seen.has(k)) return false;
    seen.add(k);
    try {
      await prisma.botSent.create({ data: { key: k } });
    } catch {
      /* already stored */
    }
    return true;
  },
};
const cfg: BotCfg = { enabled: true, token: 'T', botName: 'Bot AI TH Gym', ptGroup: '', branchId: '', groupTrainer: '', groupWindows: '', cleanOn: false, cleanGroup: '', cleanTpl: {}, shootOn: true, shootGroup: 'sg', ptOn: true, shootBoss: 'emma', botLabel: '', ptTpl: {}, shootTpl: {} };
const at = (date: string, h: number, mi = 0, dow = 1) => ({ date, h, mi, dow });

beforeAll(async () => {
  await prisma.setting.deleteMany({ where: { key: 'zalobot_shoot' } });
  await prisma.botSent.deleteMany({ where: { key: { startsWith: 'shoot' } } });
});

describe('shoot group bot', () => {
  it('computes the shoot week and parses day and hour', () => {
    expect(shootWeek('2031-03-12')).toBe('2031-03-10');
    expect(shootWeek('2031-03-15')).toBe('2031-03-17');
    expect(shootWeek('2031-03-16')).toBe('2031-03-17');
    expect(parseShoot('thứ 4 14h')).toEqual({ off: 2, minutes: 14 * 60 });
    expect(parseShoot('t7 9h30')).toEqual({ off: 5, minutes: 9 * 60 + 30 });
    expect(parseShoot('chủ nhật 15:00')).toEqual({ off: 6, minutes: 15 * 60 });
    expect(parseShoot('thứ 4')).toBeNull();
    expect(parseShootLines('1/ A Trang : thứ 4 14h\n2/ Thịnh :').map((x) => x.pt.key)).toEqual(['trang']);
  });

  it('registers PTs, waits for Emma, confirms, and re-asks after a change', async () => {
    const now = at('2031-03-11', 9, 0, 2);
    await handleShoot(cfg, deps, { text: 'Trang : thứ 4 14h', from: 'Trang' }, now);
    expect(sent.at(-1)).toContain('PT Trang: Thứ 4 12/03 lúc 14h');
    expect(sent.at(-1)).toContain('Còn thiếu: PT Thịnh');
    await handleShoot(cfg, deps, { text: 'Thịnh : thứ 5 9h30', from: 'Thinh' }, now);
    expect(sent.at(-1)).toContain('ĐÃ ĐỦ LỊCH QUAY');
    expect(sent.at(-1)).toContain('nhắn "xác nhận"');

    await handleShoot(cfg, deps, { text: 'xác nhận', from: 'Khanh' }, now);
    expect(sent.at(-1)).not.toContain('EMMA ĐÃ XÁC NHẬN');
    await handleShoot(cfg, deps, { text: 'xác nhận', from: 'Emma Phạm' }, now);
    expect(sent.at(-1)).toContain('EMMA ĐÃ XÁC NHẬN');

    await handleShoot(cfg, deps, { text: 'Trang : thứ 6 10h', from: 'Trang' }, now);
    expect(await prisma.botSent.findUnique({ where: { key: 'shootok:2031-03-10' } })).toBeNull();
  });

  it('lets Emma ask to change one PT, which clears only that PT', async () => {
    const now = at('2031-03-11', 9, 0, 2);
    await handleShoot(cfg, deps, { text: 'đổi lịch Thịnh', from: 'Emma' }, now);
    expect(sent.at(-1)).toContain('EMMA MUỐN ĐỔI LỊCH QUAY');
    expect(sent.at(-1)).toContain('1/ PT Thịnh :');
    expect(sent.at(-1)).not.toContain('PT Trang');
  });

  it('rejects past days and sends the evening reminder once', async () => {
    await handleShoot(cfg, deps, { text: 'Thịnh : thứ 2 9h', from: 'Thinh' }, at('2031-03-11', 9, 0, 2));
    expect(sent.at(-1)).toContain('đã qua');

    await handleShoot(cfg, deps, { text: 'Thịnh : thứ 5 9h30', from: 'Thinh' }, at('2031-03-11', 9, 0, 2));
    sent.length = 0;
    await runShootReminders(cfg, deps, at('2031-03-12', 19, 1, 3));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('NHẮC LỊCH QUAY NGÀY MAI');
    expect(sent[0]).toContain('PT Thịnh: Thứ 5 13/03 lúc 9h30');
    await runShootReminders(cfg, deps, at('2031-03-12', 19, 2, 3));
    expect(sent).toHaveLength(1);
  });

  it('asks for what is missing at 8h and stays silent when off', async () => {
    sent.length = 0;
    await runShootReminders({ ...cfg, shootOn: false }, deps, at('2031-03-18', 8, 0, 2));
    expect(sent).toHaveLength(0);
    await runShootReminders(cfg, deps, at('2031-03-18', 8, 0, 2));
    expect(sent[0]).toContain('ĐĂNG KÝ LỊCH QUAY VỚI EMMA');
    expect(sent[0]).toContain('1/ PT Trang :');
    await runShootReminders(cfg, deps, at('2031-03-18', 8, 5, 2));
    expect(sent).toHaveLength(1);
  });

  it('renders edited shoot templates', async () => {
    const mine = { ...cfg, shootTpl: { form: 'Form tuan {week}: {list} / {bot}', remind: 'Mai {when}: {list} ({status})' } };
    sent.length = 0;
    await runShootReminders(mine, deps, at('2031-03-25', 8, 0, 2));
    expect(sent[0]).toBe('Form tuan 24/03 đến 30/03: 1/ PT Trang :' + String.fromCharCode(10) + '2/ PT Thịnh : / Bot AI TH Gym');
  });
});
