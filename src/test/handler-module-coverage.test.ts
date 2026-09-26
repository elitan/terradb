import { beforeAll, describe, expect, test } from "bun:test";
import { loadModule } from "pgsql-parser";
import { CommentHandler } from "../core/schema/handlers/comment-handler";
import { ExtensionHandler } from "../core/schema/handlers/extension-handler";
import { ProcedureHandler } from "../core/schema/handlers/procedure-handler";
import { SequenceHandler } from "../core/schema/handlers/sequence-handler";
import { SchemaHandler } from "../core/schema/handlers/schema-handler";
import { TriggerHandler } from "../core/schema/handlers/trigger-handler";
import type { Comment, Extension, Procedure, SchemaDefinition, Sequence, Trigger } from "../types/schema";

beforeAll(async function () {
  await loadModule();
});

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    name: "invoice_seq",
    increment: 1,
    minValue: 1,
    maxValue: 1000,
    start: 1,
    cache: 10,
    cycle: false,
    ...overrides,
  };
}

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    name: "refresh_stats",
    parameters: [],
    language: "sql",
    body: "BEGIN SELECT 1; END",
    ...overrides,
  };
}

function makeExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    name: "pgcrypto",
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    objectType: "TABLE",
    objectName: "users",
    schemaName: "public",
    comment: "table comment",
    ...overrides,
  };
}

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    name: "trg_orders",
    tableName: "orders",
    schema: "public",
    timing: "BEFORE",
    events: ["INSERT"],
    forEach: "ROW",
    functionName: "sync_order",
    functionSchema: "public",
    ...overrides,
  };
}

describe("Handler module coverage", () => {
  describe("extension handler", () => {
    test("creates and drops extensions with full options", () => {
      const handler = new ExtensionHandler();
      const result = handler.generateStatements(
        [
          makeExtension({
            name: "vector",
            schema: "public",
            version: "0.8.0",
            cascade: true,
          }),
        ],
        [makeExtension({ name: "old_ext" })]
      );

      expect(result).toEqual({
        create: [
          'CREATE EXTENSION "vector" SCHEMA "public" VERSION \'0.8.0\' CASCADE;',
        ],
        drop: ['DROP EXTENSION "old_ext" RESTRICT;'],
      });
    });

    test("skips existing extension and handles version drift path", () => {
      const handler = new ExtensionHandler();

      const unchanged = handler.generateStatements(
        [makeExtension({ name: "pgcrypto", version: "1.3" })],
        [makeExtension({ name: "pgcrypto", version: "1.3" })]
      );
      expect(unchanged).toEqual({ create: [], drop: [] });

      const drift = handler.generateStatements(
        [makeExtension({ name: "pgcrypto", version: "1.4" })],
        [makeExtension({ name: "pgcrypto", version: "1.3" })]
      );
      expect(drift).toEqual({
        create: [`ALTER EXTENSION "pgcrypto" UPDATE TO '1.4';`],
        drop: [],
      });

      const quotedVersion = handler.generateStatements(
        [{ name: "pgcrypto", version: "1.4'; DROP TABLE accounts; --" }],
        [{ name: "pgcrypto", version: "1.3" }]
      );
      expect(quotedVersion.create).toEqual([
        `ALTER EXTENSION "pgcrypto" UPDATE TO '1.4''; DROP TABLE accounts; --';`,
      ]);
    });

    test("retains requirements and orders protected extension drops", function () {
      const handler = new ExtensionHandler();
      const current = [
        makeExtension({ name: "cube" }),
        makeExtension({ name: "earthdistance", dependencies: ["cube"] }),
      ];

      expect(handler.generateStatements(
        [makeExtension({ name: "earthdistance" })],
        current
      )).toEqual({ create: [], drop: [] });
      expect(handler.generateStatements([], current).drop).toEqual([
        'DROP EXTENSION "earthdistance" RESTRICT;',
        'DROP EXTENSION "cube" RESTRICT;',
      ]);
      expect(function orderCycle() {
        return handler.generateStatements([], [
          makeExtension({ name: "first", dependencies: ["second"] }),
          makeExtension({ name: "second", dependencies: ["first"] }),
        ]);
      }).toThrow("dependency cycle");
    });
  });

  describe("schema handler", () => {
    test("constructor instantiates", () => {
      const handler = new (SchemaHandler as any)();
      expect(handler).toBeInstanceOf(SchemaHandler);
    });

    test("creates owned schemas and skips existing schemas", () => {
      const handler = new SchemaHandler();
      const desired: SchemaDefinition[] = [
        { name: "analytics", owner: "reporter" },
        { name: "public" },
      ];
      const current: SchemaDefinition[] = [{ name: "public" }];

      const statements = handler.generateStatements(desired, current);
      expect(statements).toEqual([
        'CREATE SCHEMA "analytics" AUTHORIZATION "reporter";',
      ]);
    });
  });

  describe("comment handler", () => {
    test("skips unchanged comments and updates changed comments", () => {
      const handler = new CommentHandler();
      const desired = [
        makeComment({ objectName: "users", comment: "same" }),
        makeComment({ objectName: "orders", comment: "new value" }),
      ];
      const current = [
        makeComment({ objectName: "users", comment: "same" }),
        makeComment({ objectName: "orders", comment: "old value" }),
      ];

      const statements = handler.generateStatements(desired, current);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("COMMENT ON TABLE");
      expect(statements[0]).toContain("\"orders\"");
      expect(statements[0]).toContain("new value");
    });

    test("creates schema and column comment SQL with escaping", () => {
      const handler = new CommentHandler();
      const statements = handler.generateStatements(
        [
          makeComment({ objectType: "SCHEMA", objectName: "analytics", schemaName: undefined, comment: "owner's schema" }),
          makeComment({
            objectType: "COLUMN",
            objectName: "events",
            schemaName: "public",
            columnName: "metadata",
            comment: "column's note",
          }),
        ],
        []
      );

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("COMMENT ON SCHEMA");
      expect(statements[0]).toContain("\"analytics\"");
      expect(statements[0]).toContain("owner''s schema");
      expect(statements[1]).toContain("COMMENT ON COLUMN");
      expect(statements[1]).toContain("\"public\".\"events\".\"metadata\"");
      expect(statements[1]).toContain("column''s note");
    });

    test("creates materialized view sequence and type comment SQL", () => {
      const handler = new CommentHandler();
      const statements = handler.generateStatements(
        [
          makeComment({ objectType: "MATERIALIZED VIEW", objectName: "event_rollup" }),
          makeComment({ objectType: "SEQUENCE", objectName: "event_ids" }),
          makeComment({ objectType: "TYPE", objectName: "event_status" }),
        ],
        []
      );

      expect(statements).toEqual([
        `COMMENT ON MATERIALIZED VIEW "public"."event_rollup" IS 'table comment';`,
        `COMMENT ON SEQUENCE "public"."event_ids" IS 'table comment';`,
        `COMMENT ON TYPE "public"."event_status" IS 'table comment';`,
      ]);
    });
  });

  describe("sequence handler", () => {
    test("creates unmanaged sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements([makeSequence({ name: "orders_seq" })], []);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE SEQUENCE");
      expect(statements[0]).toContain("\"orders_seq\"");
    });

    test("creates explicitly declared owned sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ name: "owned_seq", ownedBy: "public.users.id" })],
        []
      );

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("CREATE SEQUENCE");
      expect(statements[0]).toContain("\"owned_seq\"");
      expect(statements[1]).toContain("ALTER SEQUENCE");
      expect(statements[1]).toContain("\"owned_seq\"");
      expect(statements[1]).toContain("OWNED BY public.users.id");
    });

    test("declares ownership inline when rendering a desired schema", () => {
      const handler = new SequenceHandler();
      const plan = handler.generateStatementPlan(
        [makeSequence({ name: "owned_seq", ownedBy: "public.users.id" })],
        [],
        { renderDesiredSchema: true }
      );

      expect(plan.afterTables).toEqual([]);
      expect(plan.beforeTables).toHaveLength(1);
      expect(plan.beforeTables[0]).toContain('CREATE SEQUENCE "owned_seq"');
      expect(plan.beforeTables[0]).toEndWith("OWNED BY public.users.id;");
    });

    test("structures sequence operations around table changes", function () {
      const handler = new SequenceHandler();
      const createAndDropPlan = handler.generateStatementPlan(
        [makeSequence({ name: "owned_seq", ownedBy: "public.users.id" })],
        [makeSequence({ name: "legacy_seq" })]
      );

      expect(createAndDropPlan.beforeTables).toHaveLength(1);
      expect(createAndDropPlan.beforeTables[0]).toContain(
        'CREATE SEQUENCE "owned_seq"'
      );
      expect(createAndDropPlan.afterTables).toEqual([
        'DROP SEQUENCE IF EXISTS "legacy_seq";',
        'ALTER SEQUENCE "owned_seq" OWNED BY public.users.id;',
      ]);

      const ownershipChangePlan = handler.generateStatementPlan(
        [makeSequence({ ownedBy: "public.accounts.id" })],
        [makeSequence({ ownedBy: "public.users.id" })]
      );

      expect(ownershipChangePlan.beforeTables).toEqual([
        'ALTER SEQUENCE "invoice_seq" OWNED BY NONE;',
      ]);
      expect(ownershipChangePlan.afterTables).toEqual([
        'ALTER SEQUENCE "invoice_seq" OWNED BY public.accounts.id;',
      ]);
    });

    test("qualifies shorthand ownership with the sequence schema", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [
          makeSequence({
            name: "owned_seq",
            schema: "tenant_a",
            ownedBy: "users.id",
          }),
        ],
        []
      );

      expect(statements[1]).toContain("OWNED BY tenant_a.users.id");
    });

    test("drops removed unmanaged sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements([], [makeSequence({ name: "legacy_seq" })]);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("DROP SEQUENCE IF EXISTS");
      expect(statements[0]).toContain("\"legacy_seq\"");
    });

    test("does not drop removed owned sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [],
        [makeSequence({ name: "owned_seq", ownedBy: "public.users.id" })]
      );

      expect(statements).toEqual([]);
    });

    test("alters sequence in place when managed attributes change", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ increment: 2 })],
        [makeSequence({ increment: 1 })]
      );

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("ALTER SEQUENCE");
      expect(statements[0]).toContain("INCREMENT BY 2");
      expect(statements[0]).not.toContain("DROP SEQUENCE");
    });

    test("preserves exact bigint increments while altering a sequence", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ increment: "9223372036854775807" })],
        [makeSequence({ increment: 1 })]
      );

      expect(statements[0]).toContain("INCREMENT BY 9223372036854775807");
      expect(statements[0]).not.toContain("9223372036854776000");
    });

    test("alters persistence and ownership without replacing the sequence", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ unlogged: true })],
        [makeSequence({ ownedBy: "public.users.id" })],
        { postgresVersionNum: 150000 }
      );

      expect(statements).toEqual([
        'ALTER SEQUENCE "invoice_seq" SET UNLOGGED;',
        'ALTER SEQUENCE "invoice_seq" OWNED BY NONE;',
      ]);
    });

    test("rejects unlogged sequences without a supported server version", () => {
      const handler = new SequenceHandler();
      let unknownVersionError: unknown;
      let postgres14Error: unknown;
      try {
        handler.generateStatements([makeSequence({ unlogged: true })], []);
      } catch (error) {
        unknownVersionError = error;
      }
      try {
        handler.generateStatements(
          [makeSequence({ unlogged: true })],
          [],
          { postgresVersionNum: 140000 }
        );
      } catch (error) {
        postgres14Error = error;
      }

      expect(unknownVersionError).toMatchObject({
        code: "VALIDATION_ERROR",
        entity: "public.invoice_seq",
        field: "unlogged",
        value: true,
      });
      expect(String(unknownVersionError)).toMatch(
        /without the PostgreSQL server version/i
      );
      expect(postgres14Error).toMatchObject({
        code: "VALIDATION_ERROR",
        entity: "public.invoice_seq",
        field: "unlogged",
        value: true,
      });
      expect(String(postgres14Error)).toMatch(
        /PostgreSQL 14 does not support unlogged sequences/i
      );
    });

    test("normalizes an omitted cycle option to no cycle", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ cycle: undefined })],
        [makeSequence({ cycle: false })]
      );

      expect(statements).toEqual([]);
    });

    test("keeps sequence when managed attributes match", () => {
      const handler = new SequenceHandler();
      const current = makeSequence();
      const desired = makeSequence();
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toEqual([]);
    });
  });

  describe("procedure handler", () => {
    test("creates procedures", () => {
      const handler = new ProcedureHandler();
      const statements = handler.generateStatements([makeProcedure({ name: "sync_data" })], []);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE PROCEDURE");
      expect(statements[0]).toContain("\"sync_data\"");
    });

    test("drops removed procedures", () => {
      const handler = new ProcedureHandler();
      const statements = handler.generateStatements([], [makeProcedure({ name: "old_proc" })]);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("DROP PROCEDURE IF EXISTS");
      expect(statements[0]).toContain("\"old_proc\"");
    });

    test("does not update for body whitespace only changes", () => {
      const handler = new ProcedureHandler();
      const current = makeProcedure({ body: "BEGIN\n  SELECT 1;\nEND" });
      const desired = makeProcedure({ body: "BEGIN SELECT 1; END" });
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toEqual([]);
    });

    test("updates when body changes", () => {
      const handler = new ProcedureHandler();
      const current = makeProcedure({ body: "BEGIN SELECT 1; END" });
      const desired = makeProcedure({ body: "BEGIN SELECT 2; END" });
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE OR REPLACE PROCEDURE");
    });

    test("updates when language changes", () => {
      const handler = new ProcedureHandler();
      const current = makeProcedure({ language: "sql" });
      const desired = makeProcedure({ language: "plpgsql" });
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE OR REPLACE PROCEDURE");
      expect(statements[0]).toContain("LANGUAGE plpgsql");
    });
  });

  describe("trigger handler", () => {
    test("creates and drops triggers", () => {
      const handler = new TriggerHandler();
      const statements = handler.generateStatements(
        [makeTrigger({ name: "trg_new" })],
        [makeTrigger({ name: "trg_old" })]
      );

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain('DROP TRIGGER IF EXISTS "trg_old"');
      expect(statements[1]).toContain('CREATE TRIGGER "trg_new"');
    });

    test("does not update for equivalent trigger arg forms", () => {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        when: "new.id > 0",
        functionArgs: ["1", "'it''s'"],
      });
      const current = makeTrigger({
        when: "(new.id > 0)",
        functionArgs: ["'1'", "'it''s'"],
      });

      const statements = handler.generateStatements([desired], [current]);
      expect(statements).toEqual([]);
    });

    test("does not update when PostgreSQL parenthesizes boolean trigger terms", function () {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        when: "old.topic IS DISTINCT FROM new.topic OR old.status IS DISTINCT FROM new.status",
      });
      const current = makeTrigger({
        when: "(old.topic IS DISTINCT FROM new.topic) OR (old.status IS DISTINCT FROM new.status)",
      });

      expect(handler.generateStatements([desired], [current])).toEqual([]);
    });

    test("does not update for equivalent trigger event order", () => {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        events: ["INSERT", "DELETE", "UPDATE"],
      });
      const current = makeTrigger({
        events: ["INSERT", "UPDATE", "DELETE"],
      });

      const statements = handler.generateStatements([desired], [current]);
      expect(statements).toEqual([]);
    });

    test("renders complete trigger definitions", function () {
      const handler = new TriggerHandler();
      const updateTrigger = makeTrigger({
        events: ["UPDATE"],
        updateColumns: ["name", 'Status"Text'],
      });
      const transitionTrigger = makeTrigger({
        timing: "AFTER",
        events: ["UPDATE"],
        forEach: "STATEMENT",
        oldTransitionTable: "old_rows",
        newTransitionTable: 'New "Rows"',
      });

      expect(handler.generateStatements([updateTrigger], [])[0]).toContain(
        'UPDATE OF "name", "Status""Text"'
      );
      expect(handler.generateStatements([transitionTrigger], [])[0]).toContain(
        'REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "New ""Rows"""'
      );
    });

    test("alters only the trigger firing mode when its definition is unchanged", function () {
      const handler = new TriggerHandler();
      const statements = handler.generateStatements(
        [makeTrigger({ enabled: "always" })],
        [makeTrigger({ enabled: "disabled" })]
      );

      expect(statements).toEqual([
        'ALTER TABLE "public"."orders" ENABLE ALWAYS TRIGGER "trg_orders";',
      ]);
    });

    test("sets non-default firing modes after trigger creation or replacement", function () {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        timing: "AFTER",
        enabled: "replica",
      });

      expect(handler.generateStatements([desired], [])).toEqual([
        expect.stringContaining('CREATE TRIGGER "trg_orders"'),
        'ALTER TABLE "public"."orders" ENABLE REPLICA TRIGGER "trg_orders";',
      ]);
      expect(
        handler.generateStatements(
          [desired],
          [makeTrigger({ timing: "BEFORE", enabled: "always" })]
        )
      ).toEqual([
        expect.stringContaining('DROP TRIGGER IF EXISTS "trg_orders"'),
        expect.stringContaining('CREATE TRIGGER "trg_orders"'),
        'ALTER TABLE "public"."orders" ENABLE REPLICA TRIGGER "trg_orders";',
      ]);
    });

    test("normalizes default statement firing and unordered update columns", function () {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        events: ["UPDATE"],
        forEach: undefined,
        updateColumns: ["status", "name"],
      });
      const current = makeTrigger({
        events: ["UPDATE"],
        forEach: "STATEMENT",
        updateColumns: ["name", "status"],
      });

      expect(handler.generateStatements([desired], [current])).toEqual([]);
    });

    test("uses sqlite trigger definition for create and drop statements", () => {
      const handler = new TriggerHandler();
      const sqliteTrigger = makeTrigger({
        name: "trg_users_insert",
        schema: undefined,
        tableName: "users",
        functionName: "",
        definition: "CREATE TRIGGER trg_users_insert AFTER INSERT ON users BEGIN INSERT INTO audit_log(user_id) VALUES (NEW.id); END",
      });

      const createStatements = handler.generateStatements([sqliteTrigger], []);
      expect(createStatements).toHaveLength(1);
      expect(createStatements[0]).toContain("CREATE TRIGGER trg_users_insert");
      expect(createStatements[0]).toContain("BEGIN INSERT INTO audit_log");

      const dropStatements = handler.generateStatements([], [sqliteTrigger]);
      expect(dropStatements).toHaveLength(1);
      expect(dropStatements[0]).toBe('DROP TRIGGER IF EXISTS "trg_users_insert";');
    });

    test("quotes sqlite trigger names when dropping", function () {
      const handler = new TriggerHandler();
      const trigger = makeTrigger({
        name: 'trg"users',
        schema: undefined,
        functionName: "",
        definition: 'CREATE TRIGGER "trg""users" AFTER INSERT ON users BEGIN SELECT 1; END',
      });

      expect(handler.generateStatements([], [trigger])).toEqual([
        'DROP TRIGGER IF EXISTS "trg""users";',
      ]);
    });

    test("does not update sqlite trigger for whitespace-only definition differences", () => {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        schema: undefined,
        tableName: "users",
        functionName: "",
        definition: "CREATE TRIGGER trg_users_insert AFTER INSERT ON users BEGIN INSERT INTO audit_log(user_id) VALUES (NEW.id); END",
      });
      const current = makeTrigger({
        schema: undefined,
        tableName: "users",
        functionName: "",
        definition: "CREATE  TRIGGER   trg_users_insert AFTER INSERT ON users BEGIN  INSERT INTO audit_log(user_id) VALUES (NEW.id);  END;",
      });

      const statements = handler.generateStatements([desired], [current]);
      expect(statements).toEqual([]);
    });

    test("preserves and compares whitespace inside sqlite trigger literals", function () {
      const handler = new TriggerHandler();
      const desired = makeTrigger({
        schema: undefined,
        tableName: "users",
        functionName: "",
        definition: "CREATE TRIGGER trg_users_insert AFTER INSERT ON users BEGIN INSERT INTO audit_log(action) VALUES ('a   b'); END",
      });
      const current = makeTrigger({
        schema: undefined,
        tableName: "users",
        functionName: "",
        definition: "CREATE TRIGGER trg_users_insert AFTER INSERT ON users BEGIN INSERT INTO audit_log(action) VALUES ('a b'); END",
      });

      const statements = handler.generateStatements([desired], [current]);
      expect(statements).toHaveLength(2);
      expect(statements[1]).toContain("VALUES ('a   b')");
    });
  });
});
