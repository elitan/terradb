import { Client } from "pg";

/**
 * CI databases are disposable, so durability only costs time: every DDL
 * statement the suite runs otherwise waits for an fsync. These settings are
 * reloadable, so the service container keeps running with them applied.
 */
const SETTINGS: Record<string, string> = {
  fsync: "off",
  synchronous_commit: "off",
  full_page_writes: "off",
};

async function tune(url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    for (const [name, value] of Object.entries(SETTINGS)) {
      await client.query(`ALTER SYSTEM SET ${name} = '${value}'`);
    }
    await client.query("SELECT pg_reload_conf()");
    const { host, port } = new URL(url);
    console.log(`tuned ${host}:${port} (${Object.keys(SETTINGS).join(", ")} off)`);
  } finally {
    await client.end();
  }
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  throw new Error("Usage: tune-ci-postgres.ts <database url>...");
}
for (const url of urls) {
  await tune(url);
}
