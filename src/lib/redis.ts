import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });

export async function hit(key: string, windowSec: number): Promise<{ count: number; ttl: number }> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  let ttl = await redis.ttl(key);
  if (ttl < 0) {
    await redis.expire(key, windowSec);
    ttl = windowSec;
  }
  return { count, ttl };
}
