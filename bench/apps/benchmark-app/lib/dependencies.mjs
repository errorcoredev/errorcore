export async function createDependencies(config, logger) {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  let pool = null;
  let redis = null;

  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    const pg = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (typeof Pool !== 'function') {
      throw new TypeError('pg Pool constructor could not be resolved');
    }
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1500
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bench_accounts (
        id integer PRIMARY KEY,
        email text NOT NULL,
        profile jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      INSERT INTO bench_accounts (id, email, profile)
      VALUES
        (42, 'casey@example.test', '{"limits":{"monthly":{"limitCents":"1200"}},"plan":"pro"}'::jsonb),
        (84, 'ren@example.test', '{"limits":{"monthly":{"limitCents":3400}},"plan":"team"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()
    `);
  }

  if (redisUrl !== undefined && redisUrl.length > 0) {
    const Redis = (await import('ioredis')).default;
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null
    });
    try {
      await redis.connect();
    } catch (error) {
      logger.dependency('redis:connect-failed', {
        dependency: 'redis',
        fault: 'connect',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function query(sql, params = [], meta = {}) {
    logger.dependency('dependency:pg-query', {
      dependency: 'postgres',
      fault: meta.fault ?? 'none',
      sql,
      params
    });
    if (pool === null) {
      return {
        rows: [
          {
            id: 42,
            email: 'casey@example.test',
            profile: { limits: { monthly: { limitCents: '1200' } }, plan: 'pro' }
          }
        ]
      };
    }
    return pool.query(sql, params);
  }

  async function redisSet(key, value) {
    logger.dependency('dependency:redis-set', { dependency: 'redis', key });
    if (redis === null || redis.status !== 'ready') return null;
    return redis.set(key, value);
  }

  async function redisGetRequired(key) {
    logger.dependency('dependency:redis-get', { dependency: 'redis', key, fault: 'missing-key' });
    if (redis === null || redis.status !== 'ready') {
      throw new Error(`redis dependency unavailable for ${key}`);
    }
    const value = await redis.get(key);
    if (value === null) {
      throw new Error(`redis key ${key} was required but missing`);
    }
    return value;
  }

  async function pushJob(queue, job) {
    logger.dependency('dependency:redis-rpush', { dependency: 'redis', queue });
    if (redis === null || redis.status !== 'ready') return null;
    return redis.rpush(queue, JSON.stringify(job));
  }

  async function popJob(queue) {
    logger.dependency('dependency:redis-lpop', { dependency: 'redis', queue });
    if (redis === null || redis.status !== 'ready') {
      return JSON.stringify({ malformed: true });
    }
    return redis.lpop(queue);
  }

  return {
    query,
    redisSet,
    redisGetRequired,
    pushJob,
    popJob,
    async close() {
      if (redis !== null) {
        redis.disconnect();
      }
      if (pool !== null) {
        await pool.end();
      }
    }
  };
}
