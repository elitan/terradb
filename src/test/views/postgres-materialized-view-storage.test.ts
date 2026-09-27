import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Client } from "pg";
import type { View } from "../../types/schema";
import { DatabaseInspector } from "../../core/schema/inspector";
import { ViewHandler } from "../../core/schema/handlers/view-handler";
import { SchemaParser } from "../../core/schema/parser";
import { generateCreateViewSQL } from "../../utils/sql";
import { getStatementRisk } from "../../utils/statement-classifier";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

const TEST_ACCESS_METHOD = "terradb_matview_heap_test";
const TEST_TABLESPACE = "terradb_matview_tablespace_test";
const TEST_TABLESPACE_PATH = "/tmp/terradb_matview_tablespace_test";

describe("PostgreSQL materialized view physical storage", function () {
  let client: Client;

  beforeAll(async function () {
    const setupClient = await createTestClient();
    try {
      await cleanDatabase(setupClient);
      await setupClient.query(`DROP ACCESS METHOD IF EXISTS ${TEST_ACCESS_METHOD}`);
      await setupClient.query(`DROP TABLESPACE IF EXISTS ${TEST_TABLESPACE}`);
      await setupClient.query(
        `COPY (SELECT 1 WHERE false) TO PROGRAM 'rm -rf ${TEST_TABLESPACE_PATH}'`
      );
      await setupClient.query(
        `COPY (SELECT 1 WHERE false) TO PROGRAM 'mkdir -p ${TEST_TABLESPACE_PATH}'`
      );
      await setupClient.query(
        `CREATE TABLESPACE ${TEST_TABLESPACE} LOCATION '${TEST_TABLESPACE_PATH}'`
      );
      await setupClient.query(`
        CREATE ACCESS METHOD ${TEST_ACCESS_METHOD}
        TYPE TABLE HANDLER heap_tableam_handler
      `);
    } finally {
      await setupClient.end();
    }
  });

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  afterAll(async function () {
    const cleanupClient = await createTestClient();
    try {
      await cleanDatabase(cleanupClient);
      await cleanupClient.query(`DROP ACCESS METHOD IF EXISTS ${TEST_ACCESS_METHOD}`);
      await cleanupClient.query(`DROP TABLESPACE IF EXISTS ${TEST_TABLESPACE}`);
      await cleanupClient.query(
        `COPY (SELECT 1 WHERE false) TO PROGRAM 'rm -rf ${TEST_TABLESPACE_PATH}'`
      );
    } finally {
      await cleanupClient.end();
    }
  });

  async function inspectView(name: string): Promise<View> {
    const views = await new DatabaseInspector().getCurrentViews(client, ["public"]);
    const view = views.find(function findView(candidate) {
      return candidate.name === name;
    });
    if (!view) {
      throw new Error(`Missing materialized view public.${name}`);
    }
    return view;
  }

  async function getRelationOid(name: string): Promise<number> {
    const result = await client.query(
      "SELECT $1::regclass::oid::integer AS oid",
      [`public.${name}`]
    );
    return result.rows[0]?.oid;
  }

  async function getRelationFileNode(name: string): Promise<number> {
    const result = await client.query(
      "SELECT relfilenode::integer AS relfilenode FROM pg_class WHERE oid = $1::regclass",
      [`public.${name}`]
    );
    return result.rows[0]?.relfilenode;
  }

  async function getServerVersion(): Promise<number> {
    const result = await client.query(
      "SELECT current_setting('server_version_num')::integer AS version"
    );
    return result.rows[0]?.version;
  }

  test("parses and generates every physical CREATE clause", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE MATERIALIZED VIEW public.physical_summary (item_id)
      USING "Terra Heap"
      WITH (
        fillfactor=73,
        autovacuum_enabled=false,
        toast.autovacuum_enabled=false
      )
      TABLESPACE "Fast Space"
      AS SELECT 1 AS item_id
      WITH NO DATA;
    `);
    const view = parsed.views[0];

    expect(view).toMatchObject({
      accessMethod: "Terra Heap",
      storageParameters: {
        fillfactor: "73",
        autovacuum_enabled: "false",
        "toast.autovacuum_enabled": "false",
      },
      tablespace: "Fast Space",
    });
    expect(generateCreateViewSQL(view!)).toBe(
      'CREATE MATERIALIZED VIEW "public"."physical_summary" ("item_id") USING "Terra Heap" WITH (autovacuum_enabled=false, fillfactor=73, toast.autovacuum_enabled=false) TABLESPACE "Fast Space" AS SELECT 1 AS item_id WITH NO DATA;'
    );

    const defaultTablespace = await new SchemaParser().parseSchema(`
      CREATE MATERIALIZED VIEW public.default_summary
      TABLESPACE pg_default AS SELECT 1 AS id;
    `);
    expect(defaultTablespace.views[0]?.tablespace).toBeUndefined();
  });

  test("uses migration context for default access methods and stable errors", function () {
    const handler = new ViewHandler();
    const desired: View = {
      name: "physical_summary",
      schema: "public",
      materialized: true,
      populated: true,
      definition: "SELECT 1 AS id",
    };
    const customCurrent: View = {
      ...desired,
      accessMethod: TEST_ACCESS_METHOD,
    };
    const heapCurrent: View = {
      ...desired,
      accessMethod: "heap",
    };

    expect(
      handler.generateStatements([desired], [customCurrent], {
        postgresVersionNum: 170000,
        defaultTableAccessMethod: TEST_ACCESS_METHOD,
      })
    ).toEqual([]);
    expect(
      handler.generateStatements([desired], [heapCurrent], {
        postgresVersionNum: 170000,
        defaultTableAccessMethod: TEST_ACCESS_METHOD,
      })
    ).toEqual([
      `ALTER MATERIALIZED VIEW "public"."physical_summary" SET ACCESS METHOD "${TEST_ACCESS_METHOD}";`,
    ]);

    function planWithoutServerVersion(): string[] {
      return handler.generateStatements(
        [{ ...desired, accessMethod: TEST_ACCESS_METHOD }],
        [heapCurrent]
      );
    }
    expect(planWithoutServerVersion).toThrow(
      "without the PostgreSQL server version"
    );

    function planOnPostgres14(): string[] {
      return handler.generateStatements(
        [{ ...desired, accessMethod: TEST_ACCESS_METHOD }],
        [heapCurrent],
        { postgresVersionNum: 140000, defaultTableAccessMethod: "heap" }
      );
    }
    expect(planOnPostgres14).toThrow(
      "PostgreSQL 14 cannot change the access method of existing materialized view public.physical_summary"
    );
  });

  test("orders mixed storage parameter sets before resets", function () {
    const handler = new ViewHandler();
    const desired: View = {
      name: "physical_summary",
      schema: "public",
      materialized: true,
      populated: true,
      definition: "SELECT 1 AS id",
      storageParameters: { fillfactor: "80" },
    };
    const current: View = {
      ...desired,
      storageParameters: {
        fillfactor: "70",
        autovacuum_enabled: "false",
      },
      accessMethod: "heap",
    };

    expect(
      handler.generateStatements([desired], [current], {
        postgresVersionNum: 170000,
        defaultTableAccessMethod: "heap",
      })
    ).toEqual([
      'ALTER MATERIALIZED VIEW "public"."physical_summary" SET (fillfactor=80);',
      'ALTER MATERIALIZED VIEW "public"."physical_summary" RESET (autovacuum_enabled);',
    ]);
  });

  test("creates, inspects, and reapplies custom physical storage", async function () {
    const schema = `
      CREATE MATERIALIZED VIEW public.physical_summary
      USING ${TEST_ACCESS_METHOD}
      WITH (fillfactor=73, autovacuum_enabled=false)
      TABLESPACE ${TEST_TABLESPACE}
      AS SELECT 1 AS item_id;
    `;
    const service = createTestSchemaService();

    await service.apply(schema, ["public"], true);
    expect(await inspectView("physical_summary")).toMatchObject({
      accessMethod: TEST_ACCESS_METHOD,
      storageParameters: {
        fillfactor: "73",
        autovacuum_enabled: "false",
      },
      tablespace: TEST_TABLESPACE,
    });
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);

    const removePlan = await service.plan("", ["public"]);
    expect(removePlan.transactional).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "public"."physical_summary";'
    );
    await service.apply("", ["public"], true);
    expect(
      (await client.query("SELECT to_regclass('public.physical_summary') AS relation"))
        .rows[0]?.relation
    ).toBeNull();
  });

  test("converges with equivalent externally created physical storage", async function () {
    await client.query(`
      CREATE MATERIALIZED VIEW public."External Summary"
      USING ${TEST_ACCESS_METHOD}
      WITH (toast.autovacuum_enabled=false, fillfactor=74)
      TABLESPACE ${TEST_TABLESPACE}
      AS SELECT 'external'::text AS payload
      WITH DATA
    `);
    const schema = `
      CREATE MATERIALIZED VIEW public."External Summary"
      USING ${TEST_ACCESS_METHOD}
      WITH (fillfactor=74, toast.autovacuum_enabled=false)
      TABLESPACE ${TEST_TABLESPACE}
      AS SELECT 'external'::text AS payload;
    `;

    const service = createTestSchemaService();
    expect(await inspectView("External Summary")).toMatchObject({
      accessMethod: TEST_ACCESS_METHOD,
      storageParameters: {
        fillfactor: "74",
        "toast.autovacuum_enabled": "false",
      },
      tablespace: TEST_TABLESPACE,
    });
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("changes and resets storage parameters and tablespace in place", async function () {
    const initialSchema = `
      CREATE TABLE public.source_items (id integer PRIMARY KEY, label text);
      CREATE MATERIALIZED VIEW public.item_summary
      WITH (fillfactor=70, toast.autovacuum_enabled=true)
      AS SELECT id, label FROM public.source_items;
      CREATE UNIQUE INDEX item_summary_id_idx ON public.item_summary (id);
      CREATE VIEW public.item_summary_dependency AS
        SELECT id FROM public.item_summary;
    `;
    const changedSchema = initialSchema.replace(
      "WITH (fillfactor=70, toast.autovacuum_enabled=true)",
      `WITH (fillfactor=80, autovacuum_enabled=false, toast.autovacuum_enabled=false) TABLESPACE ${TEST_TABLESPACE}`
    );
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    await client.query(`
      INSERT INTO public.source_items VALUES (1, 'preserved');
      REFRESH MATERIALIZED VIEW public.item_summary;
    `);
    const originalOid = await getRelationOid("item_summary");
    const originalIndexOid = await getRelationOid("item_summary_id_idx");

    const plan = await service.plan(changedSchema, ["public"]);
    const changedTablespaceStatement =
      `ALTER MATERIALIZED VIEW "public"."item_summary" SET TABLESPACE "${TEST_TABLESPACE}";`;
    expect(plan.transactional).toEqual([
      'ALTER MATERIALIZED VIEW "public"."item_summary" SET (autovacuum_enabled=false, fillfactor=80, toast.autovacuum_enabled=false);',
      changedTablespaceStatement,
    ]);
    expect(getStatementRisk(plan.transactional[0]!, "transactional")).toBe(
      "safe"
    );
    expect(getStatementRisk(changedTablespaceStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(changedSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: [changedTablespaceStatement],
    });
    const strictView = await inspectView("item_summary");
    expect(strictView).toMatchObject({
      storageParameters: {
        fillfactor: "70",
        "toast.autovacuum_enabled": "true",
      },
    });
    expect(strictView.tablespace).toBeUndefined();
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect(await getRelationOid("item_summary_id_idx")).toBe(originalIndexOid);
    expect(await client.query("SELECT * FROM public.item_summary")).toMatchObject({
      rows: [{ id: 1, label: "preserved" }],
    });
    await service.apply(changedSchema, ["public"], true);

    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect(await getRelationOid("item_summary_id_idx")).toBe(originalIndexOid);
    expect(await client.query("SELECT * FROM public.item_summary")).toMatchObject({
      rows: [{ id: 1, label: "preserved" }],
    });
    expect(await client.query("SELECT * FROM public.item_summary_dependency")).toMatchObject({
      rows: [{ id: 1 }],
    });
    expect(await inspectView("item_summary")).toMatchObject({
      storageParameters: {
        fillfactor: "80",
        autovacuum_enabled: "false",
        "toast.autovacuum_enabled": "false",
      },
      tablespace: TEST_TABLESPACE,
    });
    expect((await service.plan(changedSchema, ["public"])).hasChanges).toBe(false);

    const resetSchema = initialSchema.replace(
      "WITH (fillfactor=70, toast.autovacuum_enabled=true)",
      "TABLESPACE pg_default"
    );
    const resetPlan = await service.plan(resetSchema, ["public"]);
    const resetStatement =
      'ALTER MATERIALIZED VIEW "public"."item_summary" RESET (autovacuum_enabled, fillfactor, toast.autovacuum_enabled);';
    const resetTablespaceStatement =
      'ALTER MATERIALIZED VIEW "public"."item_summary" SET TABLESPACE "pg_default";';
    expect(resetPlan.transactional).toEqual([
      resetStatement,
      resetTablespaceStatement,
    ]);
    expect(getStatementRisk(resetStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(resetSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: [resetStatement, resetTablespaceStatement],
    });
    expect(await inspectView("item_summary")).toMatchObject({
      storageParameters: {
        fillfactor: "80",
        autovacuum_enabled: "false",
        "toast.autovacuum_enabled": "false",
      },
      tablespace: TEST_TABLESPACE,
    });
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect(await getRelationOid("item_summary_id_idx")).toBe(originalIndexOid);
    expect(await client.query("SELECT * FROM public.item_summary")).toMatchObject({
      rows: [{ id: 1, label: "preserved" }],
    });
    expect(await client.query("SELECT * FROM public.item_summary_dependency"))
      .toMatchObject({ rows: [{ id: 1 }] });

    await service.apply(resetSchema, ["public"], true);
    const resetView = await inspectView("item_summary");
    expect(resetView.storageParameters).toBeUndefined();
    expect(resetView.tablespace).toBeUndefined();
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect((await service.plan(resetSchema, ["public"])).hasChanges).toBe(false);
  });

  test("changes access method in place where the server supports it", async function () {
    const initialSchema = `
      CREATE TABLE public.source_items (id integer PRIMARY KEY, label text);
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id, label FROM public.source_items;
      CREATE UNIQUE INDEX item_summary_id_idx ON public.item_summary (id);
      CREATE VIEW public.item_summary_dependency AS
        SELECT id FROM public.item_summary;
    `;
    const changedSchema = initialSchema.replace(
      "CREATE MATERIALIZED VIEW public.item_summary AS",
      `CREATE MATERIALIZED VIEW public.item_summary USING ${TEST_ACCESS_METHOD} AS`
    );
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    await client.query(`
      INSERT INTO public.source_items VALUES (1, 'preserved');
      REFRESH MATERIALIZED VIEW public.item_summary;
    `);
    const originalOid = await getRelationOid("item_summary");
    const originalFileNode = await getRelationFileNode("item_summary");

    if ((await getServerVersion()) < 150000) {
      await expect(service.plan(changedSchema, ["public"])).rejects.toThrow(
        "PostgreSQL 14 cannot change the access method of existing materialized view public.item_summary"
      );
      expect((await inspectView("item_summary")).accessMethod).toBe("heap");
      return;
    }

    const plan = await service.plan(changedSchema, ["public"]);
    expect(plan.transactional).toEqual([
      `ALTER MATERIALIZED VIEW "public"."item_summary" SET ACCESS METHOD "${TEST_ACCESS_METHOD}";`,
    ]);
    expect(getStatementRisk(plan.transactional[0]!, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(changedSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: plan.transactional,
    });
    expect((await inspectView("item_summary")).accessMethod).toBe("heap");
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect(await getRelationFileNode("item_summary")).toBe(originalFileNode);
    expect(await client.query("SELECT * FROM public.item_summary")).toMatchObject({
      rows: [{ id: 1, label: "preserved" }],
    });
    await service.apply(changedSchema, ["public"], true);
    expect((await inspectView("item_summary")).accessMethod).toBe(
      TEST_ACCESS_METHOD
    );
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    const changedFileNode = await getRelationFileNode("item_summary");
    expect(changedFileNode).not.toBe(originalFileNode);
    expect(await client.query("SELECT * FROM public.item_summary_dependency")).toMatchObject({
      rows: [{ id: 1 }],
    });
    expect((await service.plan(changedSchema, ["public"])).hasChanges).toBe(false);

    const resetPlan = await service.plan(initialSchema, ["public"]);
    expect(resetPlan.transactional).toEqual([
      'ALTER MATERIALIZED VIEW "public"."item_summary" SET ACCESS METHOD "heap";',
    ]);
    expect(
      getStatementRisk(resetPlan.transactional[0]!, "transactional")
    ).toBe("destructive");
    await expect(
      service.apply(initialSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: resetPlan.transactional,
    });
    expect((await inspectView("item_summary")).accessMethod).toBe(
      TEST_ACCESS_METHOD
    );
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect(await getRelationFileNode("item_summary")).toBe(changedFileNode);
    await service.apply(initialSchema, ["public"], true);
    expect((await inspectView("item_summary")).accessMethod).toBe("heap");
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect(await getRelationFileNode("item_summary")).not.toBe(changedFileNode);
    expect((await service.plan(initialSchema, ["public"])).hasChanges).toBe(false);
  });

  test("rolls back physical alterations when a later view fails", async function () {
    const initialSchema = `
      CREATE TABLE public.source_items (id integer PRIMARY KEY);
      CREATE MATERIALIZED VIEW public.item_summary
      WITH (fillfactor=67)
      AS SELECT id FROM public.source_items;
    `;
    const failingSchema = `${initialSchema.replace("fillfactor=67", "fillfactor=91")}
      CREATE VIEW public.invalid_view AS
        SELECT missing_column FROM public.source_items;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    const originalOid = await getRelationOid("item_summary");

    await expect(
      service.apply(failingSchema, ["public"], true)
    ).rejects.toThrow("column \"missing_column\" does not exist");
    expect(await getRelationOid("item_summary")).toBe(originalOid);
    expect((await inspectView("item_summary")).storageParameters).toEqual({
      fillfactor: "67",
    });
    expect((await service.plan(initialSchema, ["public"])).hasChanges).toBe(false);
  });
});
