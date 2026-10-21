import pg, { type Pool, type QueryResult } from 'pg';
import { resolvePgPoolConfig } from './dbTls.js';
import { redact } from './log.js';
import type { SqlConnection, SqlQuery, SqlResult } from './premiumReader.js';

let pool: Pool | null = null;

function toResult<T>(result: QueryResult): SqlResult<T> {
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount ?? result.rows.length,
  };
}

export function getConnection(): SqlConnection | null {
  if (!pool) return null;
  const current = pool;
  const query: SqlQuery = async (sql, params) => toResult(await current.query(sql, params));
  return {
    query,
    async withTransaction(fn) {
      const client = await current.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(async (sql, params) => toResult(await client.query(sql, params)));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function initDb(env: NodeJS.ProcessEnv): Promise<void> {
  if (pool) return;
  const resolved = resolvePgPoolConfig(env);
  console.log('[db] tls', {
    host: resolved.summary.host,
    port: resolved.summary.port,
    database: resolved.summary.database,
    user: resolved.summary.user,
    rejectUnauthorized: resolved.summary.rejectUnauthorized,
    minVersion: resolved.summary.minVersion,
    servername: resolved.summary.servername,
    caSource: resolved.summary.caSource,
    checkServerIdentity: resolved.summary.checkServerIdentity,
  });
  const next = new pg.Pool({
    connectionString: resolved.connectionString,
    ssl: resolved.ssl,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    application_name: 'gamenight-bot',
    options: '-c timezone=UTC',
  });
  next.on('error', (error) => {
    console.error('[db] unexpected error', redact(error));
  });
  pool = next;
}

export async function pingDb(): Promise<void> {
  if (!pool) throw new Error('database is not configured');
  await pool.query('SELECT 1 AS ok');
}

export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  if (!current) return;
  await current.end();
}

