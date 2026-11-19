import { todayVN } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import type { Tx } from './service';

/** Contract code rule of the old system: HD + yy + 4 digits for member packages, HP + yy + 4 digits for PT packages (HD250492, HP250036). */
export async function nextContractCode(tx: Tx, pt: boolean): Promise<string> {
  const prefix = `${pt ? 'HP' : 'HD'}${todayVN().slice(2, 4)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('contract-code'))`;
  const r = await tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COALESCE(MAX(SUBSTRING(code FROM ${prefix.length + 1})::int), 0) AS n FROM contracts WHERE code ~ '^${prefix}[0-9]+$'`,
  );
  return `${prefix}${String(Number(r[0].n) + 1).padStart(4, '0')}`;
}

/** Member code rule of the old system: HV + 4 digits (HV1457), continuing from the highest existing HV number. */
export async function nextMemberCode(): Promise<string> {
  const r = await prisma.$queryRaw<{ n: number }[]>`SELECT COALESCE(MAX(SUBSTRING(code FROM 3)::int), 0) AS n FROM members WHERE code ~ '^HV[0-9]+$'`;
  return `HV${String(Number(r[0].n) + 1).padStart(4, '0')}`;
}
