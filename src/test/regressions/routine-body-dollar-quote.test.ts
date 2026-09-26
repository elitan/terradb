import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: routine bodies containing dollar quotes", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    await client.query("DROP PROCEDURE IF EXISTS record_dollar_marker(text)");
    await client.query("DROP TABLE IF EXISTS dollar_markers");
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await client.query("DROP PROCEDURE IF EXISTS record_dollar_marker(text)");
    await cleanDatabase(client);
    await client?.end();
  });

  test("creates, replaces, and replans functions and procedures whose bodies contain $$", async function () {
    const schema = function (marker: string): string {
      return `
        CREATE TABLE dollar_markers (marker text NOT NULL);

        CREATE FUNCTION dollar_text() RETURNS text LANGUAGE sql AS $fn$
          SELECT '${marker}'::text
        $fn$;

        CREATE PROCEDURE record_dollar_marker(value text) LANGUAGE plpgsql AS $proc$
        BEGIN
          INSERT INTO dollar_markers (marker) VALUES (value || '$$' || '$terradb$');
        END
        $proc$;
      `;
    };

    await service.apply(schema("$$ first $$"), ["public"], true);
    const created = await client.query("SELECT dollar_text() AS value");
    expect(created.rows[0].value).toBe("$$ first $$");
    await client.query("CALL record_dollar_marker('x')");
    const recorded = await client.query("SELECT marker FROM dollar_markers");
    expect(recorded.rows[0].marker).toBe("x$$$terradb$");
    expect((await service.plan(schema("$$ first $$"))).hasChanges).toBe(false);

    await service.apply(schema("$terradb$ second $$"), ["public"], true);
    const replaced = await client.query("SELECT dollar_text() AS value");
    expect(replaced.rows[0].value).toBe("$terradb$ second $$");
    expect((await service.plan(schema("$terradb$ second $$"))).hasChanges).toBe(false);
  });

  test("stores routine bodies exactly as declared", async function () {
    const body = "\n  SELECT 'unpadded'::text\n";
    const schema = `CREATE FUNCTION exact_body() RETURNS text LANGUAGE sql AS $$${body}$$;`;

    await service.apply(schema, ["public"], true);
    const stored = await client.query(
      "SELECT prosrc FROM pg_proc WHERE proname = 'exact_body'"
    );
    expect(stored.rows[0].prosrc).toBe(body);

    const replacement = schema.replace("unpadded", "replaced");
    await service.apply(replacement, ["public"], true);
    const replaced = await client.query(
      "SELECT prosrc FROM pg_proc WHERE proname = 'exact_body'"
    );
    expect(replaced.rows[0].prosrc).toBe(body.replace("unpadded", "replaced"));
    await client.query("DROP FUNCTION exact_body()");
  });
});
