// Runs once before any test file (see bunfig.toml).
//
// Tests delete rows freely, so they must never touch the real database. `bun test`
// loads .env.test, which points at pottery_test; this guard stops everything if
// that file is missing and DATABASE_URL still points somewhere else.
import { afterAll } from 'bun:test';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const databaseName = new URL(process.env['DATABASE_URL'] ?? '').pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against "${databaseName}". Point DATABASE_URL in .env.test at a database whose name ends in _test.`,
  );
}

// Imported after the guard, so no connection is opened to the wrong database.
const { db } = await import('../src/db/client');

// The same migrations as production, so the test tables can't drift from the real ones.
await migrate(db, { migrationsFolder: './drizzle' });

// An open database connection keeps the process alive, so `bun test` would never exit.
afterAll(async () => {
  await db.$client.end();
});
