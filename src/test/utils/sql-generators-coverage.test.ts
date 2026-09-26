import { describe, expect, test } from "bun:test";
import {
  columnsAreDifferent,
  generateAddCheckConstraintSQL,
  generateAddForeignKeySQL,
  generateAddPrimaryKeySQL,
  generateAddUniqueConstraintSQL,
  generateCreateFunctionSQL,
  generateCreateOrReplaceFunctionSQL,
  generateCreateOrReplaceViewSQL,
  generateCreateProcedureSQL,
  generateCreateOrReplaceProcedureSQL,
  generateCreateSequenceSQL,
  generateCreateTriggerSQL,
  generateCreateTypeSQL,
  generateCreateViewSQL,
  generateDropCheckConstraintSQL,
  generateDropFunctionSQL,
  generateDropForeignKeySQL,
  generateValidateForeignKeySQL,
  generateDropPrimaryKeySQL,
  generateDropProcedureSQL,
  generateDropSequenceSQL,
  generateDropTriggerSQL,
  generateDropTypeSQL,
  generateDropUniqueConstraintSQL,
  generateDropViewSQL,
  getForeignKeyConstraintName,
  generatePrimaryKeyClause,
  generateRefreshMaterializedViewSQL,
  getQualifiedTableName,
  normalizeDefault,
  normalizeExpression,
  normalizeType,
  splitSchemaTable,
} from "../../utils/sql";
import type {
  Function,
  Procedure,
  Sequence,
  Table,
  Trigger,
  View,
} from "../../types/schema";

describe("SQL generators coverage", () => {
  test("split and qualify table names", () => {
    expect(splitSchemaTable("public.users")).toEqual(["users", "public"]);
    expect(splitSchemaTable("users")).toEqual(["users", undefined]);
    expect(getQualifiedTableName("users", "public")).toBe("public.users");
    expect(getQualifiedTableName("users")).toBe("users");

    const table: Table = {
      name: "orders",
      schema: "audit",
      columns: [],
    };
    expect(getQualifiedTableName(table)).toBe("audit.orders");
  });

  test("normalizes type aliases and precision formats", () => {
    expect(normalizeType("varbit(12)")).toBe("BIT VARYING(12)");
    expect(normalizeType("decimal(10)")).toBe("NUMERIC(10,0)");
    expect(normalizeType("timestamp(4) without time zone")).toBe("TIMESTAMP(4)");
    expect(normalizeType("time(2) with time zone")).toBe("TIMETZ(2)");
    expect(normalizeType("integer[][]")).toBe("INT4[]");
  });

  test("normalizes defaults and expressions", () => {
    expect(normalizeDefault("((42::integer))")).toBe("42::integer");
    expect(normalizeDefault("pg_catalog.now()")).toBe("CURRENT_TIMESTAMP");
    expect(normalizeDefault("NULL")).toBeUndefined();
    expect(normalizeExpression("id = ANY ((ARRAY[1,2,3]))")).toBe("id IN (1, 2, 3)");
    expect(normalizeExpression("a ~~ 'x%'")).toBe("a LIKE 'x%'");
    expect(normalizeExpression("(age >= 1) AND (age <= 10)")).toBe("age BETWEEN 1 AND 10");
  });

  test("compares generated columns correctly", () => {
    const desired = {
      name: "full_name",
      type: "TEXT",
      nullable: false,
      generated: {
        always: true,
        stored: true,
        expression: "first || ' ' || last",
      },
    };
    const current = {
      name: "full_name",
      type: "TEXT",
      nullable: false,
      generated: {
        always: false,
        stored: true,
        expression: "first || ' ' || last",
      },
    };

    expect(columnsAreDifferent(desired, current)).toBe(true);
  });

  test("builds key and constraint SQL", () => {
    expect(generatePrimaryKeyClause({ columns: ["id"] })).toBe("PRIMARY KEY (\"id\")");
    const primaryKeySQL = generateAddPrimaryKeySQL("public.users", {
      columns: ["id"],
      include: ["display_name"],
      storageParameters: { fillfactor: "75" },
      tablespace: "Fast Indexes",
      deferrable: true,
      initiallyDeferred: true,
    });
    expect(primaryKeySQL).toContain("ADD CONSTRAINT");
    expect(primaryKeySQL).toContain('INCLUDE ("display_name")');
    expect(primaryKeySQL).toContain("WITH (fillfactor=75)");
    expect(primaryKeySQL).toContain('USING INDEX TABLESPACE "Fast Indexes"');
    expect(primaryKeySQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(generateDropPrimaryKeySQL("public.users", "users_pkey")).toContain("DROP CONSTRAINT \"users_pkey\"");

    const fkSQL = generateAddForeignKeySQL("orders", {
      columns: ["user_id"],
      referencedTable: "public.users",
      referencedColumns: ["id"],
      matchType: "FULL",
      onDelete: "CASCADE",
      onUpdate: "SET NULL",
      deferrable: true,
      initiallyDeferred: true,
      notValid: true,
    });
    expect(fkSQL).toContain("FOREIGN KEY");
    expect(fkSQL).toContain('"fk_orders_user_id_users"');
    expect(fkSQL).toContain("MATCH FULL");
    expect(fkSQL).toContain("ON DELETE CASCADE");
    expect(fkSQL).toContain("ON UPDATE SET NULL");
    expect(fkSQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(fkSQL).toContain("NOT VALID");
    const subsetForeignKeySQL = generateAddForeignKeySQL("orders", {
      columns: ["tenant_id", "user_id"],
      referencedTable: "users",
      referencedColumns: ["tenant_id", "id"],
      onDelete: "SET NULL",
      onDeleteColumns: ["user_id"],
    });
    expect(subsetForeignKeySQL).toContain('ON DELETE SET NULL ("user_id")');
    expect(generateDropForeignKeySQL("orders", "fk_orders_users")).toContain("DROP CONSTRAINT");
    expect(
      generateValidateForeignKeySQL("public.orders", "fk_orders_users")
    ).toContain('VALIDATE CONSTRAINT "fk_orders_users"');

    expect(generateAddCheckConstraintSQL("users", { expression: "age > 0" })).toContain("CHECK (age > 0)");
    expect(
      generateAddCheckConstraintSQL("public.users", {
        name: "users_age_check",
        expression: "age > 0",
        noInherit: true,
        notValid: true,
      })
    ).toContain(
      'ADD CONSTRAINT "users_age_check" CHECK (age > 0) NO INHERIT NOT VALID'
    );
    expect(generateDropCheckConstraintSQL("users", "users_check")).toContain("DROP CONSTRAINT");
    const uniqueSQL = generateAddUniqueConstraintSQL("users", {
      columns: ["email"],
      include: ["display_name", "updated_at"],
      storageParameters: { fillfactor: "75" },
      tablespace: "Fast Indexes",
      nullsNotDistinct: true,
      deferrable: true,
      initiallyDeferred: true,
    });
    expect(uniqueSQL).toContain("UNIQUE NULLS NOT DISTINCT (\"email\")");
    expect(uniqueSQL).toContain('INCLUDE ("display_name", "updated_at")');
    expect(uniqueSQL).toContain("WITH (fillfactor=75)");
    expect(uniqueSQL).toContain('USING INDEX TABLESPACE "Fast Indexes"');
    expect(uniqueSQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(generateDropUniqueConstraintSQL("users", "users_email_unique")).toContain("DROP CONSTRAINT");
  });

  test("builds distinct generated foreign key names", () => {
    expect(
      getForeignKeyConstraintName("application_replies", {
        columns: ["created_by_user_id"],
        referencedTable: "users",
        referencedColumns: ["id"],
      })
    ).toBe("fk_application_replies_created_by_user_id_users");

    expect(
      getForeignKeyConstraintName("application_replies", {
        columns: ["deleted_by_user_id"],
        referencedTable: "users",
        referencedColumns: ["id"],
      })
    ).toBe("fk_application_replies_deleted_by_user_id_users");
  });

  test("uses schema-qualified table targets in alter statements", () => {
    expect(
      generateAddForeignKeySQL("ai_token_manager.ai_models", {
        columns: ["provider_id"],
        referencedTable: "ai_token_manager.ai_providers",
        referencedColumns: ["id"],
      })
    ).toContain('ALTER TABLE "ai_token_manager"."ai_models"');
  });

  test("builds view SQL variations", () => {
    const view: View = {
      name: "active_users",
      schema: "audit",
      definition: "SELECT * FROM users WHERE active = true",
      securityBarrier: true,
      checkOption: "LOCAL",
    };

    const createView = generateCreateViewSQL(view);
    expect(createView).toContain("CREATE VIEW");
    expect(createView).toContain('"audit"."active_users"');
    expect(createView).toContain("security_barrier = true");
    expect(createView).toContain("WITH LOCAL CHECK OPTION");

    const materialized: View = {
      name: "mv_users",
      materialized: true,
      definition: "SELECT id FROM users",
    };
    expect(generateCreateOrReplaceViewSQL(materialized)).toContain("DROP MATERIALIZED VIEW IF EXISTS");
    expect(generateCreateOrReplaceViewSQL(view)).toContain("CREATE OR REPLACE VIEW");
    expect(generateDropViewSQL("v_users", false, "audit")).toContain('DROP VIEW IF EXISTS "audit"."v_users"');
    expect(generateDropViewSQL("mv_users", true, "audit")).toContain('DROP MATERIALIZED VIEW IF EXISTS "audit"."mv_users"');
    expect(generateRefreshMaterializedViewSQL("mv_users", true)).toContain("CONCURRENTLY");
  });

  test("builds function and procedure SQL variations", () => {
    const fn: Function = {
      name: "compute",
      schema: "audit",
      parameters: [
        { mode: "IN", name: "a", type: "integer" },
        { name: "b", type: "text", default: "'x'" },
      ],
      returnType: "integer",
      language: "plpgsql",
      body: "BEGIN RETURN 1; END",
      volatility: "STABLE",
      parallel: "SAFE",
      leakproof: true,
      securityDefiner: true,
      strict: true,
      cost: 3,
      rows: 5,
      configuration: {
        application_name: "routine's app",
        search_path: 'pg_catalog, "Case Schema"',
      },
    };
    const fnSQL = generateCreateFunctionSQL(fn);
    expect(fnSQL).toContain('CREATE FUNCTION "audit"."compute"');
    expect(fnSQL).toContain("STABLE");
    expect(fnSQL).toContain("PARALLEL SAFE");
    expect(fnSQL).toContain("LEAKPROOF");
    expect(fnSQL).toContain("SECURITY DEFINER");
    expect(fnSQL).toContain("STRICT");
    expect(fnSQL).toContain("COST 3");
    expect(fnSQL).toContain("ROWS 5");
    expect(fnSQL).toContain("SET application_name TO 'routine''s app'");
    expect(fnSQL).toContain("SET search_path TO 'pg_catalog', 'Case Schema'");
    expect(fnSQL).toContain("AS $$BEGIN RETURN 1; END$$ LANGUAGE plpgsql");
    expect(
      generateCreateFunctionSQL({ ...fn, body: "SELECT value$" })
    ).toContain("AS $$SELECT value$ $$ LANGUAGE plpgsql");
    expect(
      generateCreateFunctionSQL({ ...fn, body: "SELECT '$$' || x$terradb" })
    ).toContain("AS $terradb$SELECT '$$' || x$terradb $terradb$ LANGUAGE plpgsql");
    expect(generateCreateOrReplaceFunctionSQL(fn)).toStartWith(
      'CREATE OR REPLACE FUNCTION "audit"."compute"'
    );
    expect(generateDropFunctionSQL(fn)).toContain('DROP FUNCTION IF EXISTS "audit"."compute"');
    expect(generateDropFunctionSQL(fn)).not.toContain("CASCADE");

    expect(generateDropForeignKeySQL("x", "y")).toContain("ALTER TABLE");

    const proc: Procedure = {
      name: "sync_users",
      schema: "audit",
      parameters: [{ mode: "INOUT", name: "p", type: "integer", default: "0" }],
      language: "sql",
      body: "SELECT 1",
      securityDefiner: true,
      configuration: { application_name: "procedure app" },
    };
    const procSQL = generateCreateProcedureSQL(proc);
    expect(procSQL).toContain('CREATE PROCEDURE "audit"."sync_users"');
    expect(procSQL).toContain("INOUT");
    expect(procSQL).toContain("DEFAULT 0");
    expect(procSQL).toContain("SECURITY DEFINER");
    expect(procSQL).toContain("SET application_name TO 'procedure app'");
    expect(generateCreateOrReplaceProcedureSQL(proc)).toStartWith(
      'CREATE OR REPLACE PROCEDURE "audit"."sync_users"'
    );
    expect(function invalidConfigurationName() {
      return generateCreateProcedureSQL({
        ...proc,
        configuration: { "invalid-name": "value" },
      });
    }).toThrow('Invalid PostgreSQL routine configuration name "invalid-name"');
    expect(generateDropProcedureSQL(proc)).toContain('DROP PROCEDURE IF EXISTS "audit"."sync_users"');
  });

  test("builds trigger, sequence, and enum SQL", () => {
    const trigger: Trigger = {
      name: "trg_users",
      tableName: "users",
      timing: "BEFORE",
      events: ["INSERT", "UPDATE"],
      forEach: "ROW",
      when: "NEW.id IS NOT NULL",
      functionName: "audit_users",
      functionArgs: ["'x'", "1"],
    };
    const triggerSQL = generateCreateTriggerSQL(trigger);
    expect(triggerSQL).toContain("FOR EACH ROW");
    expect(triggerSQL).toContain("WHEN (NEW.id IS NOT NULL)");
    expect(triggerSQL).toContain("'x', 1");
    expect(triggerSQL).toContain("EXECUTE FUNCTION \"audit_users\"('x', 1);");
    expect(triggerSQL).not.toContain("'x', 1 )");
    expect(generateDropTriggerSQL(trigger)).toContain("DROP TRIGGER IF EXISTS");

    const noArgsTrigger: Trigger = {
      ...trigger,
      functionArgs: undefined,
    };
    expect(generateCreateTriggerSQL(noArgsTrigger)).toContain("EXECUTE FUNCTION \"audit_users\"();");

    const sequence: Sequence = {
      name: "user_seq",
      schema: "audit",
      dataType: "BIGINT",
      increment: 2,
      minValue: 1,
      maxValue: 100,
      start: 10,
      cache: 5,
      cycle: false,
      ownedBy: "public.users.id",
    };
    const seqSQL = generateCreateSequenceSQL(sequence);
    expect(seqSQL).toContain('CREATE SEQUENCE "audit"."user_seq"');
    expect(seqSQL).toContain("AS BIGINT");
    expect(seqSQL).toContain("NO CYCLE");
    expect(seqSQL).toContain("OWNED BY public.users.id");
    expect(generateDropSequenceSQL("user_seq", "audit")).toContain('DROP SEQUENCE IF EXISTS "audit"."user_seq"');

    const enumSQL = generateCreateTypeSQL({
      name: "status",
      schema: "public",
      values: ["new", "done"],
    });
    expect(enumSQL).toContain("CREATE TYPE \"public\".\"status\"");
    expect(generateDropTypeSQL("status", "public")).toContain("DROP TYPE \"public\".\"status\"");
  });
});
