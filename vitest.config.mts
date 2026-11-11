import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
    env: {
      APP_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
      SEED_ADMIN_EMAIL: 'admin@test.local',
      SEED_ADMIN_PASSWORD: 'AdminPass!2345',
      LOGIN_EMAIL_LIMIT: '50',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
      VIETQR_BANK_ID: '970436',
      VIETQR_ACCOUNT_NO: '0123456789',
      VIETQR_ACCOUNT_NAME: 'TH GYM',
    },
  },
});
