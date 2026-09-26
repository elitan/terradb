import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: explicit cast defaults replan without drift", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client, ["public", "cast_default_app"]);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client, ["public", "cast_default_app"]);
    await client?.end();
  });

  test("schema-qualified and multi-word cast defaults converge after apply", async function () {
    const schema = `
      CREATE SCHEMA cast_default_app;
      CREATE TYPE cast_default_app.priority AS ENUM ('low', 'medium', 'high');
      CREATE TABLE cast_default_app.tasks (
        id integer PRIMARY KEY,
        priority cast_default_app.priority NOT NULL DEFAULT 'medium'::cast_default_app.priority,
        weight double precision NOT NULL DEFAULT 1.5::double precision
      );
    `;
    const schemas = ["cast_default_app"];

    await service.apply(schema, schemas, true);
    expect((await service.plan(schema, schemas)).hasChanges).toBe(false);
  });
});
