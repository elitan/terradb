import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

async function getViewNames(client: Client): Promise<string[]> {
  const result = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
    ORDER BY c.relname
  `);
  return result.rows.map(function getName(row) {
    return row.relname;
  });
}

describe("PostgreSQL view dependency order", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client?.end();
  });

  test("creates views declared before the views they select from", async function () {
    const schema = `
      CREATE TABLE order_items (id integer PRIMARY KEY, total numeric NOT NULL);
      CREATE MATERIALIZED VIEW c_totals AS SELECT count(*) AS n FROM b_large_items;
      CREATE VIEW b_large_items AS SELECT id FROM a_priced_items WHERE total > 100;
      CREATE VIEW a_priced_items AS SELECT id, total FROM order_items;
    `;

    const plan = await service.plan(schema);
    const viewStatements = plan.transactional.filter(function isView(statement) {
      return /^CREATE (MATERIALIZED )?VIEW/.test(statement);
    });
    expect(viewStatements.map(function getName(statement) {
      return statement.match(/VIEW "?(?:public"?\."?)?(\w+)/)?.[1];
    })).toEqual(["a_priced_items", "b_large_items", "c_totals"]);

    await service.apply(schema, ["public"], true);
    expect(await getViewNames(client)).toEqual([
      "a_priced_items",
      "b_large_items",
      "c_totals",
    ]);
    expect((await service.plan(schema)).hasChanges).toBe(false);
  });

  test("removes dependent views before the views they select from", async function () {
    const table = "CREATE TABLE order_items (id integer PRIMARY KEY, total numeric NOT NULL);";
    await service.apply(
      `${table}
      CREATE VIEW a_priced_items AS SELECT id, total FROM order_items;
      CREATE VIEW b_large_items AS SELECT id FROM a_priced_items WHERE total > 100;`,
      ["public"],
      true
    );

    await service.apply(table, ["public"], true);
    expect(await getViewNames(client)).toEqual([]);
    expect((await service.plan(table)).hasChanges).toBe(false);
  });
});
