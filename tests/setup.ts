import { vi } from 'vitest';

vi.mock('../src/lib/redis', async () => {
  const { default: RedisMock } = await import('ioredis-mock');
  const redis = new RedisMock();
  const hit = async (key: string, windowSec: number) => {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return { count, ttl: await redis.ttl(key) };
  };
  return { redis, hit };
});
