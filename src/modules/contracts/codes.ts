import { prisma } from '../../lib/prisma';
import type { Tx } from './service';

const CONTRACT_PREFIX: Record<string, string> = { member: 'GHD', pt_1on1: 'GPT', pt_1on2: 'GPT', pt_group: 'GLH' };

/** Contract code rule of the old app: GHD member, GPT PT, GLH group class (GCB combo) + 5 digits, next number = highest + 1.
 * Contracts imported from GymMaster keep their own HD/HP codes and never collide with these prefixes. */
export async function nextContractCode(tx: Tx, category: string): Promise<string> {
  const prefix = CONTRACT_PREFIX[category] ?? 'GHD';
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('contract-code'))`;
  const r = await tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COALESCE(MAX(SUBSTRING(code FROM ${prefix.length + 1})::int), 0) AS n FROM contracts WHERE code ~ '^${prefix}[0-9]+$'`,
  );
  return `${prefix}${String(Number(r[0].n) + 1).padStart(5, '0')}`;
}

/** Member code rule of the old system: HV + 4 digits (HV1457), continuing from the highest existing HV number. */
export async function nextMemberCode(): Promise<string> {
  const r = await prisma.$queryRaw<{ n: number }[]>`SELECT COALESCE(MAX(SUBSTRING(code FROM 3)::int), 0) AS n FROM members WHERE code ~ '^HV[0-9]+$'`;
  return `HV${String(Number(r[0].n) + 1).padStart(4, '0')}`;
}
