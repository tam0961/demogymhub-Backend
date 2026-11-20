import { audit } from '../../lib/audit';
import { todayVN } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { nextContractCode, nextMemberCode } from '../contracts/codes';
import { getBotCfg } from '../zalobot/config';
import { getSheetSyncCfg } from './config';
import { parseDateAny } from './pull';
import { normalizePhone } from '../pt/sheet-import';

export interface SheetMemberRow {
  name: string;
  phone: string;
  email: string;
  expiry: string;
  learned: string;
  remaining: string;
  lastReg: string;
  note: string;
}

export type ImportAction = 'exists' | 'create' | 'skip';

export interface ImportItem {
  name: string;
  phone: string;
  email: string;
  action: ImportAction;
  reason: string;
  total: number;
  promo: number;
  remaining: number;
  packageName: string;
  start: string | null;
  end: string | null;
  status: 'active' | 'expired' | null;
}

export interface ImportResult {
  dryRun: boolean;
  items: ImportItem[];
  counts: { exists: number; created: number; contracts: number; skipped: number; other_packages: number };
}

const GENERIC = 'PT nhóm (nhập từ Sheet)';
const PKG_10 = 'PT NHÓM 10 BUỔI';
const PKG_20 = 'PT NHÓM 20 BUỔI';

const intOf = (s: string) => {
  const n = Number(String(s ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

/** Package rule from the owner: learned + remaining = 10 -> PT nhóm 10 buổi, 20 -> 20 buổi, 11 and 22 are 10 and 20 plus 1 and 2 promo sessions; anything else becomes the generic imported package. */
export function packageFor(total: number): { name: string; promo: number; generic: boolean } {
  if (total === 10) return { name: PKG_10, promo: 0, generic: false };
  if (total === 11) return { name: PKG_10, promo: 1, generic: false };
  if (total === 20) return { name: PKG_20, promo: 0, generic: false };
  if (total === 22) return { name: PKG_20, promo: 2, generic: false };
  return { name: GENERIC, promo: 0, generic: true };
}

export function planImport(rows: SheetMemberRow[], existing: Set<string>, today: string): ImportItem[] {
  const seen = new Set<string>();
  const out: ImportItem[] = [];
  for (const r of rows) {
    const phone = normalizePhone(r.phone || '');
    const base = { name: (r.name || '').replace(/\s+/g, ' ').trim(), phone, email: (r.email || '').trim() };
    const empty = { total: 0, promo: 0, remaining: 0, packageName: '', start: null, end: null, status: null };
    if (!phone || phone.length < 9) {
      out.push({ ...base, ...empty, action: 'skip', reason: 'Thiếu số điện thoại' });
      continue;
    }
    if (/\btest\b/i.test(base.name)) {
      out.push({ ...base, ...empty, action: 'skip', reason: 'Dòng thử, bỏ qua' });
      continue;
    }
    if (seen.has(phone)) {
      out.push({ ...base, ...empty, action: 'skip', reason: 'Số điện thoại bị lặp trong Sheet' });
      continue;
    }
    seen.add(phone);
    if (existing.has(phone)) {
      out.push({ ...base, ...empty, action: 'exists', reason: 'Đã có hội viên trong app, giữ nguyên' });
      continue;
    }
    const learned = intOf(r.learned);
    const remaining = intOf(r.remaining);
    const total = learned + remaining;
    const end = parseDateAny(r.expiry || '') || null;
    const start = parseDateAny(r.lastReg || '') || null;
    if (total <= 0) {
      out.push({ ...base, ...empty, action: 'create', reason: 'Tạo hội viên, chưa có gói trong Sheet' });
      continue;
    }
    const pk = packageFor(total);
    const status: 'active' | 'expired' = remaining > 0 && (!end || end >= today) ? 'active' : 'expired';
    out.push({
      ...base,
      action: 'create',
      reason: pk.generic ? `Tạo hội viên và gói khác (${total} buổi, dùng gói chung)` : pk.promo ? `Tạo hội viên và ${pk.name} cộng ${pk.promo} buổi khuyến mãi` : `Tạo hội viên và ${pk.name}`,
      total,
      promo: pk.promo,
      remaining,
      packageName: pk.name,
      start,
      end,
      status,
    });
  }
  return out;
}

async function ensurePackage(branchId: string, name: string, sessions: number) {
  const found = await prisma.package.findFirst({ where: { branchId, category: 'pt_group', name }, orderBy: { active: 'desc' } });
  if (found) return found;
  return prisma.package.create({ data: { name, type: 'session', category: 'pt_group', sessions, price: 0, branchId, active: false } });
}

/** Creates the missing members (gender female) with a PT group contract that carries the Sheet's sessions. Existing members are left untouched except for a missing email. */
export async function importSheetMembers(rows: SheetMemberRow[], opts: { dryRun: boolean; createdBy: string | null; branchId?: string }): Promise<ImportResult> {
  const today = todayVN();
  const phones = rows.map((r) => normalizePhone(r.phone || '')).filter(Boolean);
  const known = await prisma.member.findMany({ where: { phone: { in: phones } }, select: { phone: true } });
  const items = planImport(rows, new Set(known.map((k) => k.phone)), today);
  const counts = { exists: 0, created: 0, contracts: 0, skipped: 0, other_packages: 0 };
  for (const it of items) {
    if (it.action === 'exists') counts.exists++;
    else if (it.action === 'skip') counts.skipped++;
    else if (it.packageName === GENERIC) counts.other_packages++;
  }
  if (opts.dryRun) {
    counts.created = items.filter((i) => i.action === 'create').length;
    counts.contracts = items.filter((i) => i.action === 'create' && i.total > 0).length;
    return { dryRun: true, items, counts };
  }

  const cfg = await getSheetSyncCfg();
  const branchId = opts.branchId || cfg.branchId || (await getBotCfg()).branchId;
  if (!branchId) throw new Error('Chưa chọn chi nhánh cho hội viên từ Sheet');

  for (const it of items) {
    if (it.action === 'exists' && it.email) {
      await prisma.member.updateMany({ where: { phone: it.phone, OR: [{ email: null }, { email: '' }] }, data: { email: it.email } });
    }
    if (it.action !== 'create') continue;
    const member = await prisma.member.create({ data: { code: await nextMemberCode(), name: it.name || 'Hội viên', phone: it.phone, email: it.email || null, gender: 'female', branchId } });
    counts.created++;
    await audit(opts.createdBy, 'member.created_from_sheet', { phone: it.phone, name: member.name, bulk: true }, undefined, member.id);
    if (it.total <= 0) continue;
    const pkg = await ensurePackage(branchId, it.packageName, it.total);
    const note = `Nhập từ Sheet cũ: đã học ${it.total - it.remaining}, còn ${it.remaining}${it.promo ? `, gồm ${it.promo} buổi khuyến mãi` : ''}`;
    await prisma.$transaction(async (tx) => {
      const code = await nextContractCode(tx, true);
      await tx.contract.create({
        data: {
          code,
          memberId: member.id,
          packageId: pkg.id,
          branchId,
          status: it.status ?? 'expired',
          totalAmount: 0,
          paidAmount: 0,
          startDate: it.start ? new Date(`${it.start}T00:00:00Z`) : null,
          endDate: it.end ? new Date(`${it.end}T00:00:00Z`) : null,
          sessionsTotal: it.total,
          sessionsLeft: it.remaining,
          packageName: it.promo ? `${pkg.name} + ${it.promo} buổi khuyến mãi` : pkg.name,
          activatedAt: it.status === 'active' ? new Date() : null,
          note,
          createdBy: opts.createdBy,
        },
      });
    });
    counts.contracts++;
  }
  return { dryRun: false, items, counts };
}
