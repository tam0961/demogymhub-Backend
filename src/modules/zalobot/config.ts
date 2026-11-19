import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export interface BotCfg {
  enabled: boolean;
  token: string;
  botName: string;
  ptGroup: string;
  branchId: string;
  groupTrainer: string;
  groupWindows: string;
}

export interface SeenChat {
  id: string;
  type: string;
  name: string;
  at: string;
}
export interface BotState {
  lastPollAt: string | null;
  lastError: string | null;
  lastItemAt: string | null;
  chats: SeenChat[];
}

const CFG_KEY = 'zalobot';
const STATE_KEY = 'zalobot_state';

const freshCfg = (): BotCfg => ({
  enabled: false,
  token: '',
  botName: 'Bot AI TH Gym',
  ptGroup: '',
  branchId: '',
  groupTrainer: '',
  groupWindows: '',
});

export async function getBotCfg(): Promise<BotCfg> {
  const row = await prisma.setting.findUnique({ where: { key: CFG_KEY } });
  return { ...freshCfg(), ...((row?.value ?? {}) as Partial<BotCfg>) };
}

export async function saveBotCfg(cfg: BotCfg) {
  const value = cfg as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: CFG_KEY }, create: { key: CFG_KEY, value }, update: { value } });
}

export async function getBotState(): Promise<BotState> {
  const row = await prisma.setting.findUnique({ where: { key: STATE_KEY } });
  return { lastPollAt: null, lastError: null, lastItemAt: null, chats: [], ...((row?.value ?? {}) as Partial<BotState>) };
}

export async function patchBotState(patch: Partial<BotState>) {
  const value = { ...(await getBotState()), ...patch } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
}

export function publicBotCfg(c: BotCfg) {
  return {
    enabled: c.enabled,
    has_token: !!c.token,
    bot_name: c.botName,
    pt_group: c.ptGroup,
    branch_id: c.branchId,
    group_trainer: c.groupTrainer,
    group_windows: c.groupWindows,
  };
}

/** "06:30-07:45, 20:00-21:15" -> minute ranges; invalid parts are skipped. */
export function parseWindows(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of s.split(/[,;]/)) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (m) out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  }
  return out;
}
