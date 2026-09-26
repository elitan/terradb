import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { cleanDatabase, createTestClient, createTestSchemaService } from "./utils";

const BOOTSTRAP_COMMENT = "standard public schema";
const READER_ROLE = "public_bootstrap_reader";

type PublicSchemaState = {
  publicUsage: boolean;
  publicCreate: boolean;
  comment: string | null;
};

async function getPublicSchemaState(client: Client): Promise<PublicSchemaState> {
  const result = await client.query<{
    public_usage: boolean;
    public_create: boolean;
    comment: string | null;
  }>(`
    SELECT
      EXISTS (
        SELECT 1 FROM aclexplode(n.nspacl) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'USAGE'
      ) AS public_usage,
      EXISTS (
        SELECT 1 FROM aclexplode(n.nspacl) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'CREATE'
      ) AS public_create,
      obj_description(n.oid, 'pg_namespace') AS comment
    FROM pg_namespace n
    WHERE n.nspname = 'public'
  `);
  const row = result.rows[0]!;
  return {
    publicUsage: row.public_usage,
    publicCreate: row.public_create,
    comment: row.comment,
  };
}

async function setPublicSchemaState(
  client: Client,
  state: PublicSchemaState
): Promise<void> {
  await client.query(
    state.publicUsage
      ? "GRANT USAGE ON SCHEMA public TO PUBLIC"
      : "REVOKE USAGE ON SCHEMA public FROM PUBLIC"
  );
  await client.query(
    state.publicCreate
      ? "GRANT CREATE ON SCHEMA public TO PUBLIC"
      : "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
  );
  await client.query(
    state.comment === null
      ? "COMMENT ON SCHEMA public IS NULL"
      : `COMMENT ON SCHEMA public IS ${client.escapeLiteral(state.comment)}`
  );
}

async function getServerVersion(client: Client): Promise<number> {
  const result = await client.query<{ version: string }>(
    "SELECT current_setting('server_version_num') AS version"
  );
  return Number(result.rows[0]!.version);
}

async function dropReaderRole(client: Client): Promise<void> {
  const result = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [READER_ROLE]
  );
  if (result.rows.length === 0) {
    return;
  }
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${READER_ROLE}`);
  await client.query(`DROP ROLE ${READER_ROLE}`);
}

describe("PostgreSQL public schema bootstrap state", function () {
  let client!: Client;
  let originalState!: PublicSchemaState;
  let bootstrapState!: PublicSchemaState;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    await dropReaderRole(client);
    originalState = await getPublicSchemaState(client);
    bootstrapState = {
      publicUsage: true,
      publicCreate: (await getServerVersion(client)) < 150000,
      comment: BOOTSTRAP_COMMENT,
    };
    await setPublicSchemaState(client, bootstrapState);
  });

  afterEach(async function () {
    if (!client) {
      return;
    }
    try {
      await cleanDatabase(client);
      await dropReaderRole(client);
      await setPublicSchemaState(client, originalState);
    } finally {
      await client.end();
    }
  });

  test("first apply on a fresh database keeps initdb grants and comment", async function () {
    const service = createTestSchemaService();
    const desired = "CREATE TABLE bootstrap_items (id integer PRIMARY KEY);";

    const plan = await service.plan(desired);
    expect(plan.transactional).toHaveLength(1);
    expect(plan.transactional[0]).toStartWith('CREATE TABLE "bootstrap_items"');

    await service.apply(desired, ["public"], true, undefined, false, true);

    expect(await getPublicSchemaState(client)).toEqual(bootstrapState);
    expect((await service.plan(desired)).hasChanges).toBe(false);
  });

  test("a declared public schema comment remains fully managed", async function () {
    const service = createTestSchemaService();
    const table = "CREATE TABLE bootstrap_items (id integer PRIMARY KEY);";
    const declared = `${table}\nCOMMENT ON SCHEMA public IS 'application schema';`;

    await service.apply(declared, ["public"], true);
    expect((await getPublicSchemaState(client)).comment).toBe("application schema");
    expect((await service.plan(declared)).hasChanges).toBe(false);

    const removal = await service.plan(table);
    expect(removal.transactional).toEqual(['COMMENT ON SCHEMA "public" IS NULL;']);

    const restoreBootstrap = `${table}\nCOMMENT ON SCHEMA public IS '${BOOTSTRAP_COMMENT}';`;
    await service.apply(restoreBootstrap, ["public"], true);
    expect((await service.plan(table)).hasChanges).toBe(false);
  });

  test("non-bootstrap public schema grants remain managed", async function () {
    const service = createTestSchemaService();
    await client.query(`CREATE ROLE ${READER_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${READER_ROLE}`);

    const plan = await service.plan("");
    expect(plan.transactional).toEqual([
      `REVOKE USAGE ON SCHEMA "public" FROM "${READER_ROLE}" RESTRICT;`,
    ]);

    if (!bootstrapState.publicCreate) {
      await client.query(`REVOKE USAGE ON SCHEMA public FROM ${READER_ROLE}`);
      await client.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
      const createPlan = await service.plan("");
      expect(createPlan.transactional).toEqual([
        'REVOKE CREATE ON SCHEMA "public" FROM PUBLIC RESTRICT;',
      ]);
    }
  });
});
