import { config } from '../config';
import { logger } from './logger';

export const outbox: { to: string; kind: string; token: string }[] = [];

export async function sendMail(to: string, kind: 'email_verify' | 'password_reset', token: string) {
  if (config.APP_ENV === 'test') outbox.push({ to, kind, token });
  if (config.isProd) logger.info({ to, kind }, 'mail stub (token not logged in production)');
  else logger.info({ to, kind, token }, 'mail stub');
}
