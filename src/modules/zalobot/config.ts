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
  ptOn: boolean;
  cleanOn: boolean;
  cleanGroup: string;
  cleanTpl: Partial<Record<CleanTplKey, string>>;
  shootOn: boolean;
  shootGroup: string;
  shootBoss: string;
  botLabel: string;
  ptTpl: Partial<Record<PtTplKey, string>>;
  shootTpl: Partial<Record<ShootTplKey, string>>;
}

export const CLEAN_TPL_KEYS = ['morning', 'afternoon', 'leaf', 'hourly', 'done', 'late'] as const;
export type CleanTplKey = (typeof CLEAN_TPL_KEYS)[number];

const COMMON = ['Kiểm tra vệ sinh máy móc của phòng', 'Sắp xếp tạ ngăn lắp', 'Kiểm tra vệ sinh toilet nam, nữ (đặc biệt: tóc, nước)', 'Châm giấy, bông ráy tai, dây thun cột tóc trong toilet'];
const MORNING = [...COMMON, 'Quét lá cây ban công (10h)', 'Quét lau trước sảnh, lá cây, rác trước nhà (12h)', 'Lau bụi ghế sofa, quầy lễ tân'];
const AFTERNOON = [
  ...COMMON,
  'Kiểm tra châm cồn (1/3 bình thì châm), thay khăn 17h',
  'Bật máy lạnh, đèn ban công 17h',
  'Quét lá cây ban công (17h)',
  'Sắp xếp xe máy gọn lại (17h)',
  'Quét lau trước sảnh, lá cây, rác trước nhà (17h)',
  'Lau bụi ghế sofa, quầy lễ tân 17h',
  'Lau máy chạy bộ trước khi về',
];
const NL = String.fromCharCode(10);
const numbered = (list: string[]) => list.map((t, i) => `${i + 1}/ ${t}`).join(NL);
const HOW = 'Làm xong nhắn "xong" (nhớ tag "{bot}") để bot ghi nhận.';
const lines = (...l: string[]) => l.join(NL);
const head = (ca: string) => lines(`🧹 CHECK LIST ${ca}`, 'Anh/Chị thực hiện kiểm tra theo các mục và xác nhận lại em trước {deadline}', '');

export const CLEAN_TPL_DEFAULT: Record<CleanTplKey, string> = {
  morning: lines(head('CA SÁNG'), numbered(MORNING), '', HOW),
  afternoon: lines(head('CA CHIỀU'), numbered(AFTERNOON), '', HOW),
  leaf: lines('🌿 VIỆC ĐỊNH KỲ NGÀY {date}', 'Lau lá cây: chụp hình đã vệ sinh gửi lên nhóm Vệ Sinh. Mỗi bạn PT 1 cây'),
  hourly: lines('🧹 NHẮC VỆ SINH ĐỊNH KỲ', '1/ Kiểm tra vệ sinh toilet nam, nữ (đặc biệt: tóc, nước)', '2/ Dẹp tạ gọn gàng', '', HOW),
  done: '✅ {name} đã xác nhận xong {ca} lúc {time}',
  late: '⚠️ {ca} đã quá hạn xác nhận ({deadline}) mà chưa ai nhắn "xong". Anh Chị làm xong nhắn "xong" giúp em, nhớ tag "{bot}" ạ.',
};

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

export const DEFAULT_GROUP_TRAINER = 'Thịnh';
export const DEFAULT_GROUP_WINDOWS = '06:30-07:45, 20:00-21:15';
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
  ptOn: true,
  cleanOn: false,
  cleanGroup: '',
  cleanTpl: {},
  shootOn: false,
  shootGroup: '',
  shootBoss: 'emma',
  botLabel: '',
  ptTpl: {},
  shootTpl: {},
});

export async function getBotCfg(): Promise<BotCfg> {
  const row = await prisma.setting.findUnique({ where: { key: CFG_KEY } });
  const cfg = { ...freshCfg(), ...((row?.value ?? {}) as Partial<BotCfg>) };
  if (!cfg.groupTrainer.trim()) cfg.groupTrainer = DEFAULT_GROUP_TRAINER;
  if (!cfg.groupWindows.trim()) cfg.groupWindows = DEFAULT_GROUP_WINDOWS;
  return cfg;
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
    pt_on: c.ptOn,
    clean_on: c.cleanOn,
    clean_group: c.cleanGroup,
    clean_tpl: cleanTemplates(c),
    clean_tpl_default: CLEAN_TPL_DEFAULT,
    shoot_on: c.shootOn,
    shoot_group: c.shootGroup,
    shoot_boss: c.shootBoss,
    bot_label: c.botLabel,
    pt_tpl: ptTemplates(c),
    pt_tpl_default: PT_TPL_DEFAULT,
    shoot_tpl: shootTemplates(c),
    shoot_tpl_default: SHOOT_TPL_DEFAULT,
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

export function cleanTemplates(c: Pick<BotCfg, 'cleanTpl'>): Record<CleanTplKey, string> {
  const out = { ...CLEAN_TPL_DEFAULT };
  for (const k of CLEAN_TPL_KEYS) {
    const v = c.cleanTpl?.[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

export const PT_TPL_KEYS = ['off', 'today', 'missing', 'tomorrow', 'report'] as const;
export type PtTplKey = (typeof PT_TPL_KEYS)[number];
export const PT_TPL_DEFAULT: Record<PtTplKey, string> = {
  off: lines('📅 Nhắc lịch OFF: Anh chị PT báo giúp em lịch off tuần mới ạ. Chúc Anh/Chị cuối tuần vui vẻ !', 'Lưu ý nhớ tag tên "{bot}"'),
  today: lines('Anh Chị PT báo ca hôm nay giúp e ạ', '🍀 CA DẠY HÔM NAY 🍀', '{list}', '', 'Nhớ gõ @ rồi chọn "{bot}" để bot đọc được.'),
  missing: '⚠️ Anh Chị PT quên chưa báo ca dạy hôm nay ({date}) ạ : {names} vui lòng báo ca theo mẫu "CA DẠY" trong nhóm, nhớ tag "{bot}"',
  tomorrow: lines('🍀 CA LỚP NHÓM NGÀY MAI 🍀', '{dow} {date}', '', '{list}'),
  report: lines('📊 BÁO CÁO TỔNG HỢP THÁNG {month}', 'Anh Chị xem báo cáo tại đây:', '{link}'),
};

export const SHOOT_TPL_KEYS = ['form', 'remind', 'confirmed'] as const;
export type ShootTplKey = (typeof SHOOT_TPL_KEYS)[number];
const SEP_LINE = '-----------';
export const SHOOT_TPL_DEFAULT: Record<ShootTplKey, string> = {
  form: lines('🎬 ĐĂNG KÝ LỊCH QUAY VỚI EMMA', 'Tuần {week}', SEP_LINE, '{list}', SEP_LINE, 'Ví dụ: Trang : thứ 4 14h', 'Nhớ tag "{bot}" ạ'),
  remind: lines('🎬 NHẮC LỊCH QUAY {when}', '{list}', SEP_LINE, '{status}'),
  confirmed: lines('✅ EMMA ĐÃ XÁC NHẬN', 'Tuần {week}', SEP_LINE, '{list}{missing}'),
};

function merged<K extends string>(def: Record<K, string>, over: Partial<Record<K, string>> | undefined): Record<K, string> {
  const out = { ...def };
  for (const k of Object.keys(def) as K[]) {
    const v = over?.[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}
export const ptTemplates = (c: Pick<BotCfg, 'ptTpl'>) => merged(PT_TPL_DEFAULT, c.ptTpl);
export const shootTemplates = (c: Pick<BotCfg, 'shootTpl'>) => merged(SHOOT_TPL_DEFAULT, c.shootTpl);
