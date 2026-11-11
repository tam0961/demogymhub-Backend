import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.APP_ENV === 'test' ? 'silent' : config.isProd ? 'info' : 'debug',
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
});
