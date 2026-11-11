import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { startExpireJob } from './modules/contracts/service';

if (!config.isProd) logger.warn('APP_ENV is not production; refresh cookie is still Secure, so use HTTPS or localhost');

createApp().listen(config.PORT, () => logger.info({ port: config.PORT, env: config.APP_ENV }, 'api listening'));

if (config.APP_ENV !== 'test') startExpireJob();
