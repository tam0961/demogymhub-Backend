import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { startExpireJob } from './modules/contracts/service';
import { startPayrollSnapshotJob } from './modules/payroll/snapshot';
import { startMarketingJob } from './modules/marketing/auto';
import { startSheetPullJob } from './modules/sheetsync/pull';
import { startSheetRetryJob } from './modules/sheetsync/write';
import { startZnsJob } from './modules/zalo/service';
import { startZaloBot } from './modules/zalobot/service';

if (!config.isProd) logger.warn('APP_ENV is not production; refresh cookie is still Secure, so use HTTPS or localhost');

createApp().listen(config.PORT, () => logger.info({ port: config.PORT, env: config.APP_ENV }, 'api listening'));

if (config.APP_ENV !== 'test') {
  startExpireJob();
  startZnsJob();
  startSheetPullJob();
  startSheetRetryJob();
  startMarketingJob();
  startPayrollSnapshotJob();
  startZaloBot();
}
