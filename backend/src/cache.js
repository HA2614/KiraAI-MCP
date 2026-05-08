import Redis from "ioredis";
import { config } from "./config.js";
import { logWarn } from "./logger.js";

export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2
});

export async function connectRedis() {
  try {
    await redis.connect();
  } catch (error) {
    logWarn("cache_unavailable", { message: error.message });
  }
}
