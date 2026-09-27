import { Client } from "pg";

/**
 * `bun test --parallel` runs test files in several worker processes at once.
 * Every PostgreSQL test assumes it owns its database, so each worker gets
 * its own database on the same server: `<database>_w<worker id>`. Outside a
 * parallel run this preload does nothing.
 */
const workerId = process.env.BUN_TEST_WORKER_ID;

function isDatabaseUrlVariable(name: string): boolean {
  return /^DATABASE_URL(?:_[A-Z0-9]+)?$/.test(name) ||
    name === "REAL_WORLD_SCHEMA_DATABASE_URL";
}

function getWorkerUrl(value: string, id: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return undefined;
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || database.endsWith(`_w${id}`)) {
    return undefined;
  }
  url.pathname = `/${encodeURIComponent(`${database}_w${id}`)}`;
  return url.toString();
}

async function ensureDatabase(baseUrl: string, workerUrl: string): Promise<boolean> {
  const database = decodeURIComponent(new URL(workerUrl).pathname.slice(1));
  const client = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch {
    return false;
  }
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      database,
    ]);
    if (existing.rows.length === 0) {
      try {
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`);
      } catch (error) {
        // Another run may have created it between the check and the create.
        if ((error as { code?: string }).code !== "42P04") {
          throw error;
        }
      }
    }
    return true;
  } finally {
    await client.end();
  }
}

if (workerId) {
  const rewrites = new Map<string, string | null>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !isDatabaseUrlVariable(name)) {
      continue;
    }
    if (!rewrites.has(value)) {
      const workerUrl = getWorkerUrl(value, workerId);
      rewrites.set(
        value,
        workerUrl && (await ensureDatabase(value, workerUrl)) ? workerUrl : null
      );
    }
    const rewritten = rewrites.get(value);
    if (rewritten) {
      process.env[name] = rewritten;
    }
  }
}
