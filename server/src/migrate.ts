import { config as loadEnv } from 'dotenv';
import { closeDb, getConnection, initDb } from './db.js';
import { redact } from './log.js';
import { assertMigrationIsSafe, migrationStatements, readMigrationSql } from './migrationSql.js';

async function main(): Promise<void> {
  loadEnv();
  const sql = readMigrationSql();
  assertMigrationIsSafe(sql);
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('[migrate] DATABASE_URL is required');
    process.exit(1);
  }
  await initDb(process.env);
  try {
    const connection = getConnection();
    if (!connection) throw new Error('database is not configured');
    const statements = migrationStatements(sql);
    await connection.withTransaction(async (query) => {
      for (const statement of statements) await query(statement);
    });
    console.log('[migrate] bot notice tables are ready', { statements: statements.length });
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && process.argv[1].includes('migrate')) {
  void main().catch((error) => {
    console.error('[migrate] failed', redact(error));
    process.exit(1);
  });
}
