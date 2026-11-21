import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { cleanTemplates, type BotCfg } from './config';

export type Ca = 'sang' | 'chieu';

const CA: Record<Ca, { name: string; at: number; tpl: 'morning' | 'afternoon' }> = {
  sang: { name: 'Ca Sáng', at: 10 * 60, tpl: 'morning' },
  chieu: { name: 'Ca Chiều', at: 16 * 60 + 45, tpl: 'afternoon' },
};
const WINDOW = 75;
const HOURLY = [12 * 60, 15 * 60, 18 * 60 + 30];
const REPEAT = 30;
const STATE_KEY = 'zalobot_clean';

interface CleanState {
  date: string;
  last: string;
  sent: Ca[];
  hsent: string[];
  h: Record<string, { by: string; at: string }>;
  sang: { by: string; at: string } | null;
  chieu: { by: string; at: string } | null;
}

export interface CleanDeps {
  say: (text: string) => Promise<unknown>;
  once: (key: string) => Promise<boolean>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

export function renderTpl(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? vars[k] : all));
}

export const isLeafDay = (date: string) => {
  const d = Number(date.slice(8, 10));
  return d === 15 || d === 30;
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

async function getState(date: string): Promise<CleanState> {
  const row = await prisma.setting.findUnique({ where: { key: STATE_KEY } });
  const s = (row?.value ?? {}) as Partial<CleanState>;
  return s.date === date ? ({ last: '', sent: [], hsent: [], h: {}, sang: null, chieu: null, ...s } as CleanState) : { date, last: '', sent: [], hsent: [], h: {}, sang: null, chieu: null };
}

async function setState(s: CleanState) {
  const value = s as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
}

const hourlyLabel = (m: number) => `Vệ sinh định kỳ ${hhmm(m)}`;

const vars = (cfg: BotCfg, extra: Record<string, string> = {}) => ({ bot: cfg.botName, ...extra });

/** A "xong" message in the cleaning group confirms the latest checklist sent today. */
export async function handleCleanText(cfg: BotCfg, deps: CleanDeps, text: string, by: string, now: { date: string; h: number; mi: number }) {
  if (!/\b(xong|da xong|hoan thanh|done)\b/.test(fold(text))) return;
  const st = await getState(now.date);
  if (!st.last) return;
  const time = `${pad(now.h)}:${pad(now.mi)}`;
  let label: string;
  if (st.last.startsWith('h')) {
    if (st.h[st.last]) return;
    st.h[st.last] = { by, at: time };
    label = hourlyLabel(Number(st.last.slice(1)));
  } else {
    const ca = st.last as Ca;
    if (st[ca]) return;
    st[ca] = { by, at: time };
    label = CA[ca].name;
  }
  await setState(st);
  await deps.say(renderTpl(cleanTemplates(cfg).done, vars(cfg, { name: by, ca: label, time })));
}

/** Runs every minute; each slot is sent once (bot_sent) within 10 minutes after its time. */
export async function runCleanReminders(cfg: BotCfg, deps: CleanDeps, now: { date: string; h: number; mi: number }) {
  if (!cfg.enabled || !cfg.token || !cfg.cleanOn || !cfg.cleanGroup) return;
  const tpl = cleanTemplates(cfg);
  const mod = now.h * 60 + now.mi;
  const inWin = (m: number) => mod >= m && mod < m + 10;
  const dm = `${now.date.slice(8, 10)}/${now.date.slice(5, 7)}`;
  for (const ca of Object.keys(CA) as Ca[]) {
    const { at, name, tpl: key } = CA[ca];
    if (inWin(at) && (await deps.once(`clean:${now.date}:${ca}`))) {
      const st = await getState(now.date);
      st.last = ca;
      st.sent = [...st.sent, ca];
      await setState(st);
      await deps.say(renderTpl(tpl[key], vars(cfg, { deadline: hhmm(at + WINDOW), ca: name, date: dm })));
      if (ca === 'chieu' && isLeafDay(now.date)) await deps.say(renderTpl(tpl.leaf, vars(cfg, { date: dm })));
    }
    if (inWin(at + WINDOW)) {
      const st = await getState(now.date);
      if (st.sent.includes(ca) && !st[ca] && (await deps.once(`cleanlate:${now.date}:${ca}`))) {
        await deps.say(renderTpl(tpl.late, vars(cfg, { ca: name, deadline: hhmm(at + WINDOW), date: dm })));
      }
    }
  }
  for (const h of HOURLY) {
    const key = `h${h}`;
    if (inWin(h) && (await deps.once(`cleanh:${now.date}:${h}`))) {
      const st = await getState(now.date);
      st.last = key;
      st.hsent = [...st.hsent, key];
      await setState(st);
      await deps.say(renderTpl(tpl.hourly, vars(cfg, { date: dm })));
    }
    if (inWin(h + REPEAT)) {
      const st = await getState(now.date);
      if (st.hsent.includes(key) && !st.h[key] && (await deps.once(`cleanhlate:${now.date}:${h}`))) {
        await deps.say(renderTpl(tpl.late, vars(cfg, { ca: hourlyLabel(h), deadline: hhmm(h + REPEAT), date: dm })));
      }
    }
  }
}
