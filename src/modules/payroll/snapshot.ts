import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { computePtStats } from './ptstats';
import { computePreview } from './service';

const VN_MS = 7 * 3600_000;
const TTL_SEC = 45 * 86400;
const SLOT_HOURS = [12, 18];

export type SnapKind = 'preview' | 'ptstats';

export const currentMonthVN = () => new Date(Date.now() + VN_MS).toISOString().slice(0, 7);

const key = (kind: SnapKind, month: string, branchId?: string) => `payroll:snap:${kind}:${month}:${branchId ?? 'all'}`;

const compute = (kind: SnapKind, month: string, branchId?: string) => (kind === 'preview' ? computePreview(month, branchId) : computePtStats(month, branchId));

async function write(kind: SnapKind, month: string, branchId?: string) {
  const data = await compute(kind, month, branchId);
  const v = { data, updated_at: new Date().toISOString() };
  await redis.set(key(kind, month, branchId), JSON.stringify(v), 'EX', TTL_SEC);
  return v;
}

export async function readSnapshot(kind: SnapKind, month: string, branchId?: string): Promise<{ data: unknown; updated_at: string }> {
  const raw = await redis.get(key(kind, month, branchId));
  if (raw) return JSON.parse(raw) as { data: unknown; updated_at: string };
  return write(kind, month, branchId);
}

export async function refreshSnapshots(month: string) {
  const branches = await prisma.branch.findMany({ select: { id: true } });
  for (const b of [undefined, ...branches.map((x) => x.id)]) {
    await write('preview', month, b);
    await write('ptstats', month, b);
  }
}

export function startPayrollSnapshotJob() {
  const tick = async () => {
    const vn = new Date(Date.now() + VN_MS);
    const hour = vn.getUTCHours();
    const slot = [...SLOT_HOURS].reverse().find((h) => hour >= h);
    if (slot === undefined) return;
    const flag = `payroll:slot:${vn.toISOString().slice(0, 10)}:${slot}`;
    if ((await redis.set(flag, '1', 'EX', 2 * 86400, 'NX')) !== 'OK') return;
    try {
      await refreshSnapshots(currentMonthVN());
    } catch (e) {
      await redis.del(flag);
      throw e;
    }
  };
  const timer = setInterval(() => {
    tick().catch((e) => logger.error({ err: e }, 'payroll snapshot job failed'));
  }, 60_000);
  timer.unref();
  tick().catch((e) => logger.error({ err: e }, 'payroll snapshot job failed'));
  return () => clearInterval(timer);
}
