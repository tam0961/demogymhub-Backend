import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let pg: { stop(): Promise<void> } | undefined;
let pgDir = '';

export async function setup() {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // EMBEDDED_PG_MODULE: path to an ASCII-only install of embedded-postgres (its binaries break on non-ASCII paths)
    const mod = process.env.EMBEDDED_PG_MODULE ?? 'embedded-postgres';
    const { default: EmbeddedPostgres } = await import(mod);
    pgDir = path.join(os.tmpdir(), `gymhub-pgtest-${process.pid}`);
    fs.rmSync(pgDir, { recursive: true, force: true });
    const port = 54329;
    const server = new EmbeddedPostgres({ databaseDir: pgDir, user: 'gymhub', password: 'gymhub', port, persistent: false });
    await server.initialise();
    await server.start();
    await server.createDatabase('gymhub_test');
    pg = server;
    url = `postgresql://gymhub:gymhub@localhost:${port}/gymhub_test`;
  }
  process.env.DATABASE_URL = url;
  const env = {
    ...process.env,
    APP_ENV: 'test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
    SEED_ADMIN_EMAIL: 'admin@test.local',
    SEED_ADMIN_PASSWORD: 'AdminPass!2345',
    SEED_DEMO: 'false',
  };
  execSync('npx prisma migrate deploy', { env, stdio: 'inherit' });
  execSync('npx tsx src/seed.ts', { env, stdio: 'inherit' });
}

export async function teardown() {
  await pg?.stop();
  if (pgDir) fs.rmSync(pgDir, { recursive: true, force: true });
}
