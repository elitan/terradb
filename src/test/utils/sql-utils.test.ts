import { describe, test, expect } from "bun:test";
import {
  normalizeDefault,
  columnsAreDifferent,
  isPostgresSerialDefault,
  isPostgresSerialType,
  normalizeType,
  normalizePostgresSerialType,
  postgresTypesAreEquivalent,
} from "../../utils/sql";
import type { Column } from "../../types/schema";
import {
  parseTypeReference,
  qualifiedTypeReferenceMatchesCatalogIdentity,
} from "../../utils/postgres-type-reference";

describe("normalizeDefault", () => {
  test("should return undefined for null input", () => {
    expect(normalizeDefault(null)).toBeUndefined();
  });

  test("should return undefined for undefined input", () => {
    expect(normalizeDefault(undefined)).toBeUndefined();
  });

  test("should strip ::integer type cast", () => {
    expect(normalizeDefault("100::integer")).toBe("100");
  });

  test("should strip ::character varying type cast", () => {
    expect(normalizeDefault("'John'::character varying")).toBe("'John'");
  });

  test("should strip ::boolean type cast", () => {
    expect(normalizeDefault("true::boolean")).toBe("true");
  });

  test("should strip ::text type cast", () => {
    expect(normalizeDefault("'hello'::text")).toBe("'hello'");
  });

  test("should strip schema-qualified enum type casts", () => {
    expect(normalizeDefault("'can''t wait'::enum_lifecycle.priority")).toBe(
      "'can''t wait'"
    );
    expect(
      normalizeDefault("'can''t wait'::\"enum lifecycle\".\"priority type\"")
    ).toBe("'can''t wait'");
  });

  test("should strip CAST syntax with the same type forms as the suffix", () => {
    expect(normalizeDefault("CAST('medium' AS app.priority)")).toBe(
      normalizeDefault("'medium'::app.priority")
    );
    expect(
      normalizeDefault("CAST('can''t wait' AS \"enum lifecycle\".\"priority type\")")
    ).toBe("'can''t wait'");
    expect(normalizeDefault("CAST(1.5 AS double precision)")).toBe(
      normalizeDefault("1.5::double precision")
    );
    expect(normalizeDefault("CAST('x' AS varchar(10))")).toBe("'x'");
  });

  test("should strip ::numeric type cast with params", () => {
    expect(normalizeDefault("0.00::numeric(10,2)")).toBe("0.00");
  });

  test("should strip ::timestamp type cast", () => {
    expect(normalizeDefault("'2024-01-01'::timestamp")).toBe("'2024-01-01'");
  });

  test("should handle values without type casts", () => {
    expect(normalizeDefault("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
    expect(normalizeDefault("100")).toBe("100");
    expect(normalizeDefault("'hello'")).toBe("'hello'");
  });

  test("should strip ::timestamp without time zone", () => {
    expect(normalizeDefault("CURRENT_TIMESTAMP::timestamp without time zone")).toBe("CURRENT_TIMESTAMP");
  });

  test("should handle nextval function calls", () => {
    expect(normalizeDefault("nextval('users_id_seq'::regclass)")).toBe("nextval('users_id_seq'::regclass)");
  });

  test("should normalize nextval regclass cast syntax", function () {
    expect(
      normalizeDefault(
        `nextval(CAST('"OWNED BY"' AS regclass))`
      )
    ).toBe(`nextval('"OWNED BY"'::regclass)`);
    expect(
      normalizeDefault(
        `nextval(CAST('public.user_seq' AS pg_catalog.regclass))`
      )
    ).toBe("nextval('public.user_seq'::regclass)");
  });

  test("should trim whitespace", () => {
    expect(normalizeDefault("  100::integer  ")).toBe("100");
  });
});

describe("columnsAreDifferent - default value comparison", () => {
  test("should detect no difference when defaults match after normalization", () => {
    const desired: Column = {
      name: "name",
      type: "VARCHAR(255)",
      nullable: true,
      default: "'John'",
    };

    const current: Column = {
      name: "name",
      type: "character varying(255)",
      nullable: true,
      default: "'John'::character varying",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect no difference for integer defaults", () => {
    const desired: Column = {
      name: "age",
      type: "INTEGER",
      nullable: true,
      default: "0",
    };

    const current: Column = {
      name: "age",
      type: "integer",
      nullable: true,
      default: "0::integer",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect no difference for boolean defaults", () => {
    const desired: Column = {
      name: "active",
      type: "BOOLEAN",
      nullable: true,
      default: "true",
    };

    const current: Column = {
      name: "active",
      type: "boolean",
      nullable: true,
      default: "true::boolean",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect no difference when both defaults are null/undefined", () => {
    const desired: Column = {
      name: "col",
      type: "INTEGER",
      nullable: true,
      default: undefined,
    };

    const current: Column = {
      name: "col",
      type: "integer",
      nullable: true,
      default: null,
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect difference when defaults actually differ", () => {
    const desired: Column = {
      name: "status",
      type: "VARCHAR(50)",
      nullable: true,
      default: "'active'",
    };

    const current: Column = {
      name: "status",
      type: "character varying(50)",
      nullable: true,
      default: "'pending'::character varying",
    };

    expect(columnsAreDifferent(desired, current)).toBe(true);
  });

  test("should detect difference when one has default and other doesn't", () => {
    const desired: Column = {
      name: "count",
      type: "INTEGER",
      nullable: true,
      default: "0",
    };

    const current: Column = {
      name: "count",
      type: "integer",
      nullable: true,
      default: undefined,
    };

    expect(columnsAreDifferent(desired, current)).toBe(true);
  });

  test("should handle CURRENT_TIMESTAMP defaults", () => {
    const desired: Column = {
      name: "created_at",
      type: "TIMESTAMP",
      nullable: true,
      default: "CURRENT_TIMESTAMP",
    };

    const current: Column = {
      name: "created_at",
      type: "timestamp without time zone",
      nullable: true,
      default: "CURRENT_TIMESTAMP",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });
});

describe("PostgreSQL serial comparison", function () {
  test("recognizes only serial pseudo-type names", function () {
    expect(isPostgresSerialType("serial")).toBe(true);
    expect(isPostgresSerialType("SMALLSERIAL")).toBe(true);
    expect(isPostgresSerialType("BigSerial")).toBe(true);
    expect(isPostgresSerialType("serial2")).toBe(true);
    expect(isPostgresSerialType("SERIAL4")).toBe(true);
    expect(isPostgresSerialType("Serial8")).toBe(true);
    expect(isPostgresSerialType("integer")).toBe(false);
    expect(normalizePostgresSerialType("serial2")).toBe("SMALLSERIAL");
    expect(normalizePostgresSerialType("serial4")).toBe("SERIAL");
    expect(normalizePostgresSerialType("serial8")).toBe("BIGSERIAL");
  });

  test("recognizes only an exact nextval regclass default", function () {
    expect(
      isPostgresSerialDefault("nextval('users_id_seq'::regclass)")
    ).toBe(true);
    expect(
      isPostgresSerialDefault(
        "pg_catalog.nextval('public.users_id_seq'::pg_catalog.regclass)"
      )
    ).toBe(true);
    expect(isPostgresSerialDefault("length('nextval'::text)")).toBe(false);
    expect(
      isPostgresSerialDefault("nextval('users_id_seq'::regclass) + 10")
    ).toBe(false);
  });

  test("requires inspected serial ownership instead of nextval text", function () {
    const desired: Column = {
      name: "id",
      type: "SERIAL",
      nullable: false,
    };
    const misleading: Column = {
      name: "id",
      type: "integer",
      nullable: false,
      default: "length('nextval'::text)",
    };
    const unownedNextval: Column = {
      name: "id",
      type: "integer",
      nullable: false,
      default: "nextval('users_id_seq'::regclass)",
    };
    const serial: Column = {
      ...unownedNextval,
      serial: true,
    };
    const serialWithOptionDrift: Column = {
      ...serial,
      serialSequenceOptionsMatch: false,
    };

    expect(columnsAreDifferent(desired, misleading)).toBe(true);
    expect(columnsAreDifferent(desired, unownedNextval)).toBe(true);
    expect(columnsAreDifferent(desired, serial)).toBe(false);
    expect(columnsAreDifferent(desired, serialWithOptionDrift)).toBe(true);
  });
});

describe("PostgreSQL catalog type identity comparison", function () {
  test("parses qualified, quoted, modified, and array type references", function () {
    expect(parseTypeReference("public.status[]")).toEqual(["public", "status"]);
    expect(parseTypeReference('"Visible Schema"."Status.Type"(4)[][]')).toEqual([
      "Visible Schema",
      "Status.Type",
    ]);
    expect(parseTypeReference('"Escaped""Schema"."Escaped""Type"')).toEqual([
      'Escaped"Schema',
      'Escaped"Type',
    ]);
    expect(parseTypeReference("Status")).toEqual(["status"]);
    expect(parseTypeReference("public..status")).toBeUndefined();
    expect(parseTypeReference('"public.status')).toBeUndefined();
  });

  test("matches explicit qualification only to the inspected catalog namespace", function () {
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "public.status",
        "status",
        "public"
      )
    ).toBe(true);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        '"Visible Schema"."Status.Type"[][]',
        '"Status.Type"[]',
        "Visible Schema"
      )
    ).toBe(true);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        '"public"."status"',
        "status",
        "public"
      )
    ).toBe(true);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "public.status[]",
        "status",
        "public"
      )
    ).toBe(false);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "public.status(4)",
        "status(8)",
        "public"
      )
    ).toBe(false);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "public.status",
        "other.status",
        "public"
      )
    ).toBe(false);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "public.status",
        "status",
        "other"
      )
    ).toBe(false);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "status",
        "status",
        "public"
      )
    ).toBe(false);
    expect(
      qualifiedTypeReferenceMatchesCatalogIdentity(
        "public.status",
        "status",
        undefined
      )
    ).toBe(false);
  });

  test("uses catalog identity without weakening ordinary type comparison", function () {
    expect(normalizeType("integer[2][3]")).toBe("INT4[]");
    expect(normalizeType("public.status[4][]")).toBe("PUBLIC.STATUS[]");
    expect(postgresTypesAreEquivalent("integer", "int4", "pg_catalog")).toBe(
      true
    );
    expect(postgresTypesAreEquivalent("public.status", "status", "public")).toBe(
      true
    );
    expect(postgresTypesAreEquivalent("public.status[]", "status[]", "public")).toBe(
      true
    );
    expect(
      postgresTypesAreEquivalent("public.status[2][3]", "status[]", "public")
    ).toBe(true);
    expect(postgresTypesAreEquivalent("public.status", "status", "other")).toBe(
      false
    );
    expect(postgresTypesAreEquivalent("public.status", "status[]", "public")).toBe(
      false
    );
  });

  test("uses inspected column namespaces for explicitly qualified custom types", function () {
    const desired: Column = {
      name: "states",
      type: "public.status[]",
      nullable: true,
    };
    const current: Column = {
      name: "states",
      type: "status[]",
      typeSchema: "public",
      nullable: true,
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
    expect(
      columnsAreDifferent(desired, { ...current, typeSchema: "tenant" })
    ).toBe(true);
    expect(
      columnsAreDifferent(desired, { ...current, typeSchema: undefined })
    ).toBe(true);
    expect(columnsAreDifferent(desired, { ...current, type: "status" })).toBe(
      true
    );
  });
});
