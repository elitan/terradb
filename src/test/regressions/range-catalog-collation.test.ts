import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: pg_catalog-qualified range options keep their quoting", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    await client.query("DROP TYPE IF EXISTS catalog_collated_window");
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await client.query("DROP TYPE IF EXISTS catalog_collated_window");
    await cleanDatabase(client);
    await client?.end();
  });

  test("creates a range whose collation is pg_catalog.\"C\" and replans empty", async function () {
    const schema = `
      CREATE TYPE catalog_collated_window AS RANGE (
        subtype = text,
        collation = pg_catalog."C"
      );
    `;

    const plan = await service.plan(schema);
    expect(plan.transactional).toEqual([
      'CREATE TYPE catalog_collated_window AS RANGE (subtype = text, collation = pg_catalog."C");',
    ]);

    await service.apply(schema, ["public"], true);
    const result = await client.query(`
      SELECT rngcollation::regcollation::text AS collation
      FROM pg_range
      JOIN pg_type ON pg_type.oid = pg_range.rngtypid
      WHERE pg_type.typname = 'catalog_collated_window'
    `);
    expect(result.rows[0].collation).toBe('"C"');
    expect((await service.plan(schema)).hasChanges).toBe(false);
  });
});
