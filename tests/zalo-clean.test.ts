import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { cleanTemplates, getBotCfg, type BotCfg } from '../src/modules/zalobot/config';
import { handleCleanText, renderTpl, runCleanReminders } from '../src/modules/zalobot/clean';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let owner = '';
const auth = () => ({ Authorization: `Bearer ${owner}` });
const sent: string[] = [];
const seen = new Set<string>();
const deps = {
  say: async (t: string) => {
    sent.push(t);
  },
  once: async (k: string) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  },
};
const at = (date: string, h: number, mi: number) => ({ date, h, mi });
const cfgOn = (over: Partial<BotCfg> = {}): BotCfg => ({
  enabled: true, token: 'T', botName: 'Bot AI TH Gym', ptGroup: '', branchId: '', groupTrainer: '', groupWindows: '', cleanOn: true, cleanGroup: `cg${sfx}`, cleanTpl: {}, ...over,
});

beforeAll(async () => {
  await makeUser(`owner@cl${sfx}.test`, 'owner', null);
  owner = await tokenFor(`owner@cl${sfx}.test`);
  await prisma.setting.deleteMany({ where: { key: 'zalobot_clean' } });
});

describe('cleaning bot', () => {
  it('renders placeholders and keeps unknown ones', () => {
    expect(renderTpl('Hạn {deadline} {x}', { deadline: '11:15' })).toBe('Hạn 11:15 {x}');
  });

  it('sends the morning checklist once, confirms on "xong", and warns late only if unconfirmed', async () => {
    const d = '2031-03-10';
    await runCleanReminders(cfgOn(), deps, at(d, 10, 2));
    await runCleanReminders(cfgOn(), deps, at(d, 10, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('CHECK LIST CA SÁNG');
    expect(sent[0]).toContain('11:15');
    expect(sent[0]).toContain('Bot AI TH Gym');

    await handleCleanText(cfgOn(), deps, 'Bot AI TH Gym đã xong nhé', 'Khanh', at(d, 10, 40));
    expect(sent[1]).toBe('✅ Khanh đã xác nhận xong Ca Sáng lúc 10:40');
    await handleCleanText(cfgOn(), deps, 'xong', 'Trang', at(d, 10, 50));
    expect(sent).toHaveLength(2);

    await runCleanReminders(cfgOn(), deps, at(d, 11, 16));
    expect(sent).toHaveLength(2);
  });

  it('warns once when nobody confirms the afternoon checklist, plus the leaf message on the 15th', async () => {
    const d = '2031-03-15';
    sent.length = 0;
    await runCleanReminders(cfgOn(), deps, at(d, 16, 46));
    expect(sent[0]).toContain('CHECK LIST CA CHIỀU');
    expect(sent[1]).toContain('NGÀY 15/03');
    await runCleanReminders(cfgOn(), deps, at(d, 18, 1));
    await runCleanReminders(cfgOn(), deps, at(d, 18, 4));
    const late = sent.filter((t) => t.includes('quá hạn'));
    expect(late).toHaveLength(1);
    expect(late[0]).toContain('18:00');
  });

  it('sends the hourly reminder and stays silent when off or unconfigured', async () => {
    sent.length = 0;
    await runCleanReminders(cfgOn({ cleanOn: false }), deps, at('2031-03-20', 12, 1));
    await runCleanReminders(cfgOn({ cleanGroup: '' }), deps, at('2031-03-20', 12, 1));
    expect(sent).toHaveLength(0);
    await runCleanReminders(cfgOn(), deps, at('2031-03-20', 12, 1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('NHẮC VỆ SINH ĐỊNH KỲ');
  });

  it('uses edited templates saved through the config route and falls back for blank ones', async () => {
    const put = await request(app)
      .put('/api/zalo/bot/config')
      .set(auth())
      .send({ enabled: false, token: 'TOKEN', bot_name: 'Bot AI TH Gym', pt_group: '', branch_id: '', group_trainer: '', group_windows: '', clean_group: `cg${sfx}`, clean_on: true, clean_tpl: { hourly: 'Nhắc nhanh {date}', done: '   ' } });
    expect(put.status).toBe(200);
    expect(put.body.data.clean_on).toBe(true);
    expect(put.body.data.clean_tpl.hourly).toBe('Nhắc nhanh {date}');
    expect(put.body.data.clean_tpl.done).toContain('{name}');
    const cfg = await getBotCfg();
    expect(cleanTemplates(cfg).hourly).toBe('Nhắc nhanh {date}');
    sent.length = 0;
    await runCleanReminders({ ...cfg, enabled: true }, deps, at('2031-04-02', 14, 3));
    expect(sent).toEqual(['Nhắc nhanh 02/04']);
  });

  it('refuses to turn the cleaning bot on without a group', async () => {
    const r = await request(app)
      .put('/api/zalo/bot/config')
      .set(auth())
      .send({ enabled: false, bot_name: 'Bot AI TH Gym', pt_group: '', branch_id: '', group_trainer: '', group_windows: '', clean_group: '', clean_on: true });
    expect(r.status).toBe(400);
  });
});
