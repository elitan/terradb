import { beforeAll, describe, expect, test } from "bun:test";
import { loadModule } from "pgsql-parser";
import { SchemaDiffer } from "../core/schema/differ";
import type {
  CheckConstraint,
  Column,
  ExclusionConstraint,
  ForeignKeyConstraint,
  PrimaryKeyConstraint,
  Table,
} from "../types/schema";

function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    name: "id",
    type: "INTEGER",
    nullable: false,
    ...overrides,
  };
}

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    name: "users",
    schema: "public",
    columns: [makeColumn()],
    ...overrides,
  };
}

function makePrimaryKey(columns: string[], name?: string): PrimaryKeyConstraint {
  return { columns, name };
}

function makeExclusion(
  overrides: Partial<ExclusionConstraint> = {}
): ExclusionConstraint {
  return {
    name: "users_no_overlap",
    method: "gist",
    elements: [{ definition: "during", operator: { name: "&&" } }],
    where: "id > 0",
    ...overrides,
  };
}

function reverseCopy<T>(items: T[]): T[] {
  return [...items].reverse();
}

describe("SchemaDiffer private coverage", () => {
  beforeAll(async function () {
    await loadModule();
  });

  test("checks constraint-backed index helper", () => {
    const differ = new SchemaDiffer();
    expect(
      (differ as any).isConstraintBackedIndex({
        name: "users_email_key",
        tableName: "users",
        columns: ["email"],
        type: "btree",
        constraint: "users_email_key",
      })
    ).toBe(true);
    expect(
      (differ as any).isConstraintBackedIndex({
        name: "idx_users_email",
        tableName: "users",
        columns: ["email"],
        type: "btree",
      })
    ).toBe(false);
  });

  test("treats an omitted effective default opclass symmetrically", function () {
    const differ = new SchemaDiffer() as any;
    const omitted = {
      name: "users_id_idx",
      tableName: "users",
      columns: ["id"],
      terms: [{ column: "id" }],
      type: "btree",
      unique: false,
    };
    const explicitDefault = {
      ...omitted,
      terms: [{
        column: "id",
        opclass: { name: "int4_ops", schema: "pg_catalog" },
        opclassDefault: true,
      }],
    };

    expect(differ.indexesAreEqual(explicitDefault, omitted)).toBe(true);
    expect(differ.indexesAreEqual(omitted, explicitDefault)).toBe(true);
  });

  test("generateColumnStatements handles add modify and drop", () => {
    const differ = new SchemaDiffer();
    const desired = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "name", type: "INTEGER", nullable: false, default: "1" }),
        makeColumn({
          name: "created_at",
          type: "TIMESTAMP",
          nullable: false,
          default: "CURRENT_TIMESTAMP",
        }),
      ],
    });
    const current = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "name", type: "TEXT", nullable: true, default: "'old'" }),
        makeColumn({ name: "old_col", type: "TEXT", nullable: true }),
      ],
    });

    const statements = (differ as any).generateColumnStatements(desired, current) as string[];
    const sql = statements.join("\n");

    expect(sql).toContain("ADD COLUMN");
    expect(sql).toContain("\"created_at\"");
    expect(sql).toContain("DROP DEFAULT");
    expect(sql).toContain("TYPE INTEGER");
    expect(sql).toContain("TRUNC(\"name\"::DECIMAL)::integer");
    expect(sql).toContain("SET DEFAULT 1");
    expect(sql).toContain("SET NOT NULL");
    expect(sql).toContain("DROP COLUMN");
    expect(sql).toContain("\"old_col\"");
  });

  test("generateColumnModificationStatements handles generated columns", () => {
    const differ = new SchemaDiffer();
    const desired = makeColumn({
      name: "full_name",
      type: "TEXT",
      nullable: false,
      generated: {
        always: true,
        expression: "first_name || ' ' || last_name",
        stored: true,
      },
    });
    const current = makeColumn({
      name: "full_name",
      type: "TEXT",
      nullable: false,
    });

    const statements = (differ as any).generateColumnModificationStatements(
      makeTable(),
      desired,
      current
    ) as string[];

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DROP COLUMN");
    expect(statements[1]).toContain("ADD COLUMN");
    expect(statements[1]).toContain("GENERATED ALWAYS AS");
    expect(statements[1]).toContain("STORED");
  });

  test("compares local generated expressions and detects expression-only changes in both paths", function () {
    const differ = new SchemaDiffer() as any;
    const desired = makeColumn({
      name: "normalized",
      type: "TEXT",
      nullable: true,
      generated: {
        always: true,
        expression: "public.normalize_value(source)",
        stored: true,
      },
    });
    const equivalent = makeColumn({
      name: "normalized",
      type: "TEXT",
      nullable: true,
      generated: {
        always: true,
        expression: "normalize_value(source)",
        stored: true,
      },
    });
    const changed = makeColumn({
      name: "normalized",
      type: "TEXT",
      nullable: true,
      generated: {
        always: true,
        expression: "other_value(source)",
        stored: true,
      },
    });
    const table = makeTable({
      schema: undefined,
      columns: [makeColumn({ name: "source", type: "TEXT", nullable: true })],
    });

    expect(
      differ.generateColumnModificationStatements(table, desired, equivalent)
    ).toEqual([]);
    expect(
      differ.generateColumnModificationStatements(table, desired, changed)
    ).toHaveLength(2);

    const equivalentAlterations: unknown[] = [];
    differ.collectColumnModificationAlterations(
      table,
      desired,
      equivalent,
      equivalentAlterations
    );
    expect(equivalentAlterations).toEqual([]);

    const changedAlterations: Array<{ type: string }> = [];
    differ.collectColumnModificationAlterations(
      table,
      desired,
      changed,
      changedAlterations
    );
    expect(changedAlterations.map(function getType(alteration) {
      return alteration.type;
    })).toEqual(["drop_column", "add_column"]);
  });

  test("validates PostgreSQL 18 virtual generated column support", function () {
    const differ = new SchemaDiffer();
    const virtualTable = makeTable({
      columns: [
        makeColumn({ name: "source", type: "TEXT", nullable: true }),
        makeColumn({
          name: "derived",
          type: "TEXT",
          nullable: true,
          generated: {
            always: true,
            expression: "lower(source)",
            stored: false,
          },
        }),
      ],
    });

    expect(function rejectUnknownVersion() {
      differ.generateMigrationPlan([virtualTable], []);
    }).toThrow("without the PostgreSQL server version");
    expect(function rejectPostgres17() {
      differ.generateMigrationPlan([virtualTable], [], {
        postgresVersionNum: 170000,
      });
    }).toThrow("PostgreSQL 18 or newer is required");

    const postgres18Plan = differ.generateMigrationPlan([virtualTable], [], {
      postgresVersionNum: 180000,
    });
    expect(postgres18Plan.transactional.join("\n")).toContain(
      '"derived" TEXT GENERATED ALWAYS AS (lower(source)) VIRTUAL'
    );
  });

  test("validates and repairs identity-sequence persistence", function () {
    const differ = new SchemaDiffer();
    const desired = makeTable({
      columns: [
        makeColumn({
          identity: {
            generation: "ALWAYS",
            sequencePersistence: "unlogged",
          },
        }),
      ],
    });
    const current = makeTable({
      columns: [
        makeColumn({
          identity: {
            generation: "ALWAYS",
            sequenceName: { schema: "public", name: "users_id_seq" },
            sequencePersistence: "logged",
          },
        }),
      ],
    });

    expect(function rejectUnknownVersion() {
      differ.generateMigrationPlan([desired], [current]);
    }).toThrow("without the PostgreSQL server version");
    expect(function rejectPostgres14() {
      differ.generateMigrationPlan([desired], [current], {
        postgresVersionNum: 140000,
      });
    }).toThrow("PostgreSQL 15 or newer is required");
    expect(
      differ
        .generateMigrationPlan([desired], [current], {
          postgresVersionNum: 150000,
        })
        .transactional.join("\n")
    ).toContain(
      'ALTER SEQUENCE "public"."users_id_seq" SET UNLOGGED;'
    );

    const implicitDesired = makeTable({
      unlogged: true,
      columns: [
        makeColumn({
          identity: { generation: "ALWAYS" },
        }),
      ],
    });
    const implicitCurrent = makeTable({
      unlogged: true,
      columns: [
        makeColumn({
          identity: {
            generation: "ALWAYS",
            sequenceName: { schema: "public", name: "users_id_seq" },
            sequencePersistence: "unlogged",
          },
        }),
      ],
    });
    expect(
      differ.generateMigrationPlan([implicitDesired], [implicitCurrent])
        .hasChanges
    ).toBe(false);
  });

  test("type conversion helpers cover serial and boolean branches", () => {
    const differ = new SchemaDiffer();

    const serialSQL = (differ as any).generateTypeConversionSQL(
      "\"public\".\"users\"",
      "order_id",
      "SERIAL",
      "TEXT"
    ) as string;
    expect(serialSQL).toContain("TYPE INTEGER");
    expect(serialSQL).toContain("USING TRUNC(\"order_id\"::DECIMAL)::integer");

    const boolSQL = (differ as any).generateTypeConversionSQL(
      "\"public\".\"users\"",
      "is_active",
      "BOOLEAN",
      "TEXT"
    ) as string;
    expect(boolSQL).toContain("TYPE BOOLEAN");
    expect(boolSQL).toContain("USING TRIM(\"is_active\")::boolean");

    expect((differ as any).requiresUsingClause("INTEGER", "BIGINT")).toBe(false);
    expect((differ as any).requiresUsingClause("TEXT", "INTEGER")).toBe(true);
  });

  test("type conversion helpers handle bigint and interval without integer fallback", () => {
    const differ = new SchemaDiffer();

    const bigintSQL = (differ as any).generateTypeConversionSQL(
      "\"public\".\"metrics\"",
      "counter",
      "BIGINT",
      "TEXT"
    ) as string;
    expect(bigintSQL).toContain("TYPE BIGINT");
    expect(bigintSQL).toContain("USING TRUNC(\"counter\"::DECIMAL)::bigint");
    expect(bigintSQL).not.toContain("::integer");

    expect((differ as any).requiresUsingClause("TEXT", "INTERVAL")).toBe(false);
    const intervalExpr = (differ as any).generateUsingExpression(
      "elapsed",
      "TEXT",
      "INTERVAL"
    ) as string;
    expect(intervalExpr).toBe("\"elapsed\"::INTERVAL");
  });

  test("type conversion helpers cover widen and narrow matrix decisions", () => {
    const differ = new SchemaDiffer();

    expect((differ as any).requiresUsingClause("INT4", "INT8")).toBe(false);
    expect((differ as any).requiresUsingClause("VARCHAR(100)", "TEXT")).toBe(false);
    expect((differ as any).requiresUsingClause("TEXT", "NUMERIC(12,2)")).toBe(true);
    expect((differ as any).requiresUsingClause("TEXT", "SMALLINT")).toBe(true);
    expect((differ as any).requiresUsingClause("TEXT", "BOOLEAN")).toBe(true);

    const textToSmallintExpr = (differ as any).generateUsingExpression(
      "score",
      "TEXT",
      "SMALLINT"
    ) as string;
    expect(textToSmallintExpr).toBe("TRUNC(\"score\"::DECIMAL)::smallint");

    const textToNumericExpr = (differ as any).generateUsingExpression(
      "amount",
      "TEXT",
      "NUMERIC(12,2)"
    ) as string;
    expect(textToNumericExpr).toBe("\"amount\"::NUMERIC(12,2)");
  });

  test("generateMigrationPlan treats equivalent default expressions as no-op", () => {
    const differ = new SchemaDiffer();
    const desired = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INTEGER", nullable: false }),
          makeColumn({
            name: "created_at",
            type: "TIMESTAMP",
            nullable: false,
            default: "CURRENT_TIMESTAMP",
          }),
        ],
      }),
    ];
    const current = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INT4", nullable: false }),
          makeColumn({
            name: "created_at",
            type: "timestamp without time zone",
            nullable: false,
            default: "now()",
          }),
        ],
      }),
    ];

    const plan = differ.generateMigrationPlan(desired, current);
    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
    expect(plan.deferred).toHaveLength(0);
  });

  test("generateMigrationPlan treats equivalent generated expressions as no-op", () => {
    const differ = new SchemaDiffer();
    const desired = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INTEGER", nullable: false }),
          makeColumn({ name: "first_name", type: "TEXT", nullable: true }),
          makeColumn({ name: "last_name", type: "TEXT", nullable: true }),
          makeColumn({
            name: "full_name",
            type: "TEXT",
            nullable: true,
            generated: {
              always: true,
              expression: "lower(first_name) || ' ' || lower(last_name)",
              stored: true,
            },
          }),
        ],
      }),
    ];
    const current = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INT4", nullable: false }),
          makeColumn({ name: "first_name", type: "TEXT", nullable: true }),
          makeColumn({ name: "last_name", type: "TEXT", nullable: true }),
          makeColumn({
            name: "full_name",
            type: "TEXT",
            nullable: true,
            generated: {
              always: true,
              expression: "lower(first_name) || ' '::text || lower(last_name)",
              stored: true,
            },
          }),
        ],
      }),
    ];

    const plan = differ.generateMigrationPlan(desired, current);
    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
    expect(plan.deferred).toHaveLength(0);
  });

  test("generateMigrationPlan preserves table persistence direction", function () {
    const differ = new SchemaDiffer();
    const logged = makeTable({ unlogged: undefined });
    const unlogged = makeTable({ unlogged: true });

    expect(
      differ.generateMigrationPlan([unlogged], [logged]).transactional.join("\n")
    ).toContain("SET UNLOGGED");
    expect(
      differ.generateMigrationPlan([logged], [unlogged]).transactional.join("\n")
    ).toContain("SET LOGGED");
  });

  test("generateMigrationPlan preserves table tablespace direction", function () {
    const differ = new SchemaDiffer();
    const defaultTable = makeTable();
    const customTable = makeTable({ tablespace: "Fast Space" });
    const explicitDefault = makeTable({ tablespace: "pg_default" });

    expect(
      differ
        .generateMigrationPlan([customTable], [defaultTable])
        .transactional.join("\n")
    ).toContain('SET TABLESPACE "Fast Space"');
    expect(
      differ
        .generateMigrationPlan([defaultTable], [customTable])
        .transactional.join("\n")
    ).toContain('SET TABLESPACE "pg_default"');
    expect(
      differ.generateMigrationPlan([explicitDefault], [defaultTable]).hasChanges
    ).toBe(false);
  });

  test("generateMigrationPlan handles versioned table access methods", function () {
    const differ = new SchemaDiffer();
    const heap = makeTable({ accessMethod: "heap" });
    const custom = makeTable({ accessMethod: "custom_heap" });
    const postgres15 = {
      postgresVersionNum: 150000,
      defaultTableAccessMethod: "heap",
    };

    expect(
      differ
        .generateMigrationPlan([custom], [heap], postgres15)
        .transactional.join("\n")
    ).toContain('SET ACCESS METHOD "custom_heap"');
    expect(
      differ
        .generateMigrationPlan([makeTable()], [heap], postgres15)
        .hasChanges
    ).toBe(false);
    expect(
      differ
        .generateMigrationPlan([makeTable()], [heap], {
          ...postgres15,
          defaultTableAccessMethod: "custom_heap",
        })
        .transactional.join("\n")
    ).toContain('SET ACCESS METHOD "custom_heap"');
    expect(function rejectPostgres14Change() {
      differ.generateMigrationPlan([custom], [heap], {
        postgresVersionNum: 140000,
        defaultTableAccessMethod: "heap",
      });
    }).toThrow("PostgreSQL 14 cannot change the access method");
    expect(function rejectUnknownVersionChange() {
      differ.generateMigrationPlan([custom], [heap]);
    }).toThrow("without the PostgreSQL server version");
  });

  test("isolates storage resets without splitting safe table alterations", function () {
    const differ = new SchemaDiffer();
    const desiredColumns = [
      makeColumn(),
      makeColumn({ name: "payload", type: "TEXT", nullable: true }),
    ];
    const mixedPlan = differ.generateMigrationPlan(
      [makeTable({
        columns: desiredColumns,
        storageParameters: { fillfactor: "80" },
      })],
      [makeTable({
        storageParameters: {
          fillfactor: "70",
          autovacuum_enabled: "false",
        },
      })]
    );

    expect(mixedPlan.transactional).toHaveLength(3);
    expect(mixedPlan.transactional[0]).toContain('ADD COLUMN "payload" TEXT');
    expect(mixedPlan.transactional[1]).toContain(
      "RESET (autovacuum_enabled)"
    );
    expect(mixedPlan.transactional[2]).toContain("SET (fillfactor=80)");

    const safePlan = differ.generateMigrationPlan(
      [makeTable({
        columns: desiredColumns,
        storageParameters: { fillfactor: "80" },
      })],
      [makeTable()]
    );
    expect(safePlan.transactional).toHaveLength(1);
    expect(safePlan.transactional[0]).toContain('ADD COLUMN "payload" TEXT');
    expect(safePlan.transactional[0]).toContain("SET (fillfactor=80)");
  });

  test("renders new-table column storage inline for desired schemas", function () {
    const differ = new SchemaDiffer();
    const table = makeTable({
      columns: [
        makeColumn(),
        makeColumn({
          name: "payload",
          type: "TEXT",
          nullable: true,
          storage: "EXTERNAL",
          compression: "lz4",
        }),
      ],
    });

    const migration = differ.generateMigrationPlan([table], []);
    expect(migration.transactional).toHaveLength(2);
    expect(migration.transactional[0]).toContain('"payload" TEXT\n');
    expect(migration.transactional[1]).toContain('SET STORAGE EXTERNAL');
    expect(migration.transactional[1]).toContain('SET COMPRESSION lz4');

    const desired = differ.generateMigrationPlan([table], [], {
      renderDesiredSchema: true,
    });
    expect(desired.transactional).toHaveLength(1);
    expect(desired.transactional[0]).toContain(
      '"payload" TEXT STORAGE EXTERNAL COMPRESSION lz4'
    );
  });

  test("isolates identity CYCLE without splitting NO CYCLE changes", function () {
    const differ = new SchemaDiffer();
    const baseIdentity = {
      generation: "ALWAYS" as const,
      increment: "1",
      cache: "1",
      cycle: false,
    };
    const noCycleTable = makeTable({
      columns: [makeColumn({ identity: baseIdentity })],
    });
    const cycleTable = makeTable({
      columns: [makeColumn({
        identity: { ...baseIdentity, cache: "2", cycle: true },
      })],
    });
    const cyclePlan = differ.generateMigrationPlan(
      [cycleTable],
      [noCycleTable]
    );
    expect(cyclePlan.transactional).toHaveLength(2);
    expect(cyclePlan.transactional[0]).toContain(
      'ALTER COLUMN "id" SET CACHE 2'
    );
    expect(cyclePlan.transactional[1]).toContain(
      'ALTER COLUMN "id" SET CYCLE'
    );

    const noCyclePlan = differ.generateMigrationPlan(
      [noCycleTable],
      [cycleTable]
    );
    expect(noCyclePlan.transactional).toHaveLength(1);
    expect(noCyclePlan.transactional[0]).toContain(
      'ALTER COLUMN "id" SET CACHE 1'
    );
    expect(noCyclePlan.transactional[0]).toContain(
      'ALTER COLUMN "id" SET NO CYCLE'
    );
  });

  test("isolates identity enforcement weakening without splitting strengthening", function () {
    const differ = new SchemaDiffer();
    const alwaysTable = makeTable({
      columns: [makeColumn({
        identity: {
          generation: "ALWAYS",
          cache: "1",
          cycle: false,
        },
      })],
    });
    const byDefaultTable = makeTable({
      columns: [makeColumn({
        identity: {
          generation: "BY DEFAULT",
          cache: "2",
          cycle: false,
        },
      })],
    });

    const weakeningPlan = differ.generateMigrationPlan(
      [byDefaultTable],
      [alwaysTable]
    );
    expect(weakeningPlan.transactional).toHaveLength(2);
    expect(weakeningPlan.transactional[0]).toContain(
      'ALTER COLUMN "id" SET GENERATED BY DEFAULT'
    );
    expect(weakeningPlan.transactional[0]).not.toContain("SET CACHE");
    expect(weakeningPlan.transactional[1]).toContain(
      'ALTER COLUMN "id" SET CACHE 2'
    );

    const strengtheningPlan = differ.generateMigrationPlan(
      [alwaysTable],
      [byDefaultTable]
    );
    expect(strengtheningPlan.transactional).toHaveLength(1);
    expect(strengtheningPlan.transactional[0]).toContain(
      'ALTER COLUMN "id" SET GENERATED ALWAYS'
    );
    expect(strengtheningPlan.transactional[0]).toContain(
      'ALTER COLUMN "id" SET CACHE 1'
    );
  });

  test("generateMigrationPlan preserves null uniqueness semantics", function () {
    const differ = new SchemaDiffer();
    const columns = [
      makeColumn(),
      makeColumn({ name: "email", type: "TEXT", nullable: true }),
    ];
    const ordinaryConstraint = makeTable({
      columns,
      uniqueConstraints: [{ name: "users_email_key", columns: ["email"] }],
    });
    const strictConstraint = makeTable({
      columns,
      uniqueConstraints: [
        {
          name: "users_email_key",
          columns: ["email"],
          include: ["id"],
          storageParameters: { fillfactor: "75" },
          tablespace: "fastspace",
          nullsNotDistinct: true,
        },
      ],
    });
    const postgres15 = { postgresVersionNum: 150000 };

    const constraintSql = differ
      .generateMigrationPlan(
        [strictConstraint],
        [ordinaryConstraint],
        postgres15
      )
      .transactional.join("\n");
    expect(constraintSql).toContain('DROP CONSTRAINT "users_email_key"');
    expect(constraintSql).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(constraintSql).toContain('INCLUDE ("id")');
    expect(constraintSql).toContain("WITH (fillfactor=75)");
    expect(constraintSql).toContain('USING INDEX TABLESPACE "fastspace"');
    expect(function rejectPostgres14() {
      differ.generateMigrationPlan([strictConstraint], [ordinaryConstraint], {
        postgresVersionNum: 140000,
      });
    }).toThrow("PostgreSQL 15 or newer is required");
    expect(function rejectUnknownVersion() {
      differ.generateMigrationPlan([strictConstraint], [ordinaryConstraint]);
    }).toThrow("without the PostgreSQL server version");
    expect(function rejectNonUniqueIndex() {
      differ.generateMigrationPlan(
        [
          makeTable({
            indexes: [
              {
                name: "users_email_idx",
                tableName: "users",
                columns: ["email"],
                nullsNotDistinct: true,
              },
            ],
          }),
        ],
        [makeTable()],
        postgres15
      );
    }).toThrow("requires a UNIQUE index");

    const ordinaryIndex = makeTable({
      columns,
      indexes: [
        {
          name: "users_email_idx",
          tableName: "users",
          columns: ["email"],
          unique: true,
          type: "btree",
        },
      ],
    });
    const strictIndex = makeTable({
      columns,
      indexes: [
        {
          name: "users_email_idx",
          tableName: "users",
          columns: ["email"],
          unique: true,
          nullsNotDistinct: true,
          type: "btree",
        },
      ],
    });
    const indexPlan = differ.generateMigrationPlan(
      [strictIndex],
      [ordinaryIndex],
      postgres15
    );
    expect([...indexPlan.transactional, ...indexPlan.concurrent].join("\n"))
      .toContain("NULLS NOT DISTINCT");
    expect(
      differ.generateMigrationPlan(
        [ordinaryIndex],
        [strictIndex],
        postgres15
      ).hasChanges
    ).toBe(true);
  });

  test("validates versioned foreign key delete action column subsets", function () {
    const differ = new SchemaDiffer();
    const baseForeignKey: ForeignKeyConstraint = {
      name: "users_profile_fkey",
      columns: ["tenant_id", "profile_id"],
      referencedTable: "profiles",
      referencedColumns: ["tenant_id", "id"],
      onDelete: "SET NULL",
    };
    const current = makeTable({ foreignKeys: [baseForeignKey] });
    const desired = makeTable({
      foreignKeys: [
        {
          ...baseForeignKey,
          onDeleteColumns: ["profile_id", "tenant_id"],
        },
      ],
    });

    const sql = differ
      .generateMigrationPlan([desired], [current], {
        postgresVersionNum: 150000,
      })
      .transactional.join("\n");
    expect(sql).toContain('SET NULL ("profile_id", "tenant_id")');

    const reorderedCurrent = makeTable({
      foreignKeys: [
        {
          ...baseForeignKey,
          onDeleteColumns: ["tenant_id", "profile_id"],
        },
      ],
    });
    expect(
      differ.generateMigrationPlan([desired], [reorderedCurrent], {
        postgresVersionNum: 150000,
      }).hasChanges
    ).toBe(false);

    expect(function rejectUnknownVersion() {
      differ.generateMigrationPlan([desired], [current]);
    }).toThrow("without the PostgreSQL server version");
    expect(function rejectPostgres14() {
      differ.generateMigrationPlan([desired], [current], {
        postgresVersionNum: 140000,
      });
    }).toThrow("PostgreSQL 15 or newer is required");
    expect(function rejectInvalidAction() {
      differ.generateMigrationPlan(
        [
          makeTable({
            foreignKeys: [
              {
                ...baseForeignKey,
                onDelete: "CASCADE",
                onDeleteColumns: ["profile_id"],
              },
            ],
          }),
        ],
        [current],
        { postgresVersionNum: 150000 }
      );
    }).toThrow("require SET NULL or SET DEFAULT");
    expect(function rejectDuplicateColumn() {
      differ.generateMigrationPlan(
        [
          makeTable({
            foreignKeys: [
              {
                ...baseForeignKey,
                onDeleteColumns: ["profile_id", "profile_id"],
              },
            ],
          }),
        ],
        [current],
        { postgresVersionNum: 150000 }
      );
    }).toThrow("cannot contain duplicate columns");
    expect(function rejectUnknownColumn() {
      differ.generateMigrationPlan(
        [
          makeTable({
            foreignKeys: [
              {
                ...baseForeignKey,
                onDeleteColumns: ["missing"],
              },
            ],
          }),
        ],
        [current],
        { postgresVersionNum: 150000 }
      );
    }).toThrow("must be one of the referencing columns");
  });

  test("generateMigrationPlan preserves covering index payload columns", function () {
    const differ = new SchemaDiffer();
    const columns = [
      makeColumn(),
      makeColumn({ name: "email", type: "TEXT", nullable: true }),
      makeColumn({ name: "display_name", type: "TEXT", nullable: true }),
      makeColumn({ name: "updated_at", type: "TIMESTAMP", nullable: true }),
    ];
    const ordinary = makeTable({
      columns,
      indexes: [
        {
          name: "users_email_idx",
          tableName: "users",
          columns: ["email"],
          type: "btree",
        },
      ],
    });
    const covering = makeTable({
      columns,
      indexes: [
        {
          name: "users_email_idx",
          tableName: "users",
          columns: ["email"],
          include: ["display_name", "updated_at"],
          type: "btree",
        },
      ],
    });

    const addPlan = differ.generateMigrationPlan([covering], [ordinary]);
    expect([...addPlan.transactional, ...addPlan.concurrent].join("\n"))
      .toContain('INCLUDE ("display_name", "updated_at")');
    expect(
      differ.generateMigrationPlan([ordinary], [covering]).hasChanges
    ).toBe(true);
    expect(
      differ.generateMigrationPlan(
        [covering],
        [
          makeTable({
            columns,
            indexes: [
              {
                ...covering.indexes![0]!,
                include: ["updated_at", "display_name"],
              },
            ],
          }),
        ]
      ).hasChanges
    ).toBe(true);
  });

  test("generateMigrationPlan preserves non-default index null ordering", function () {
    const differ = new SchemaDiffer();
    const columns = [
      makeColumn(),
      makeColumn({ name: "starts_at", type: "TIMESTAMP", nullable: true }),
      makeColumn({ name: "ends_at", type: "TIMESTAMP", nullable: true }),
    ];
    const defaultIndex = {
      name: "users_time_idx",
      tableName: "users",
      columns: ["starts_at", "ends_at"],
      sortOrders: ["ASC", "DESC"] as ("ASC" | "DESC")[],
      type: "btree" as const,
    };
    const current = makeTable({ columns, indexes: [defaultIndex] });
    const explicitDefaults = makeTable({
      columns,
      indexes: [
        {
          ...defaultIndex,
          nullsOrders: ["LAST", "FIRST"],
        },
      ],
    });
    const reversed = makeTable({
      columns,
      indexes: [
        {
          ...defaultIndex,
          nullsOrders: ["FIRST", "LAST"],
        },
      ],
    });

    expect(differ.generateMigrationPlan([explicitDefaults], [current]).hasChanges)
      .toBe(false);
    const plan = differ.generateMigrationPlan([reversed], [current]);
    const sql = [...plan.transactional, ...plan.concurrent].join("\n");
    expect(sql).toContain('"starts_at" NULLS FIRST');
    expect(sql).toContain('"ends_at" DESC NULLS LAST');
    expect(differ.generateMigrationPlan([current], [reversed]).hasChanges)
      .toBe(true);
  });

  test("generateMigrationPlan handles inheritance transitions", function () {
    const differ = new SchemaDiffer();
    const parent = { name: "parent", schema: "public" };
    const standalone = makeTable();
    const inherited = makeTable({ inherits: [parent] });

    expect(
      differ.generateMigrationPlan([inherited], [standalone]).transactional.join("\n")
    ).toContain('INHERIT "public"."parent"');
    expect(
      differ.generateMigrationPlan([standalone], [
        makeTable({
          inherits: [parent],
          inheritedColumns: [makeColumn({ name: "parent_id" })],
        }),
      ]).transactional.join("\n")
    ).toContain('NO INHERIT "public"."parent"');
    expect(function rejectParentReplacement() {
      differ.generateMigrationPlan(
        [makeTable({ inherits: [{ name: "new_parent", schema: "public" }] })],
        [inherited]
      );
    }).toThrow("separate detach and attach migrations");
  });

  test("generateMigrationPlan handles exclusion constraint equivalence and replacement", function () {
    const differ = new SchemaDiffer();
    const current = makeExclusion();
    const equivalentUnnamed = makeExclusion({
      name: undefined,
      elements: [
        {
          definition: "(during)",
          operator: { name: "&&", schema: "pg_catalog" },
        },
      ],
      where: "(id > 0)",
    });
    expect(
      differ.generateMigrationPlan(
        [makeTable({ exclusionConstraints: [equivalentUnnamed] })],
        [makeTable({ exclusionConstraints: [current] })]
      ).hasChanges
    ).toBe(false);

    const expressionCurrent = makeExclusion({
      elements: [
        {
          definition: "int4range(lower(during), upper(during))",
          operator: { name: "&&" },
        },
      ],
    });
    const expressionDesired = makeExclusion({
      elements: [
        {
          definition: "(int4range(lower(during), upper(during)))",
          operator: { name: "&&" },
        },
      ],
    });
    expect(
      differ.generateMigrationPlan(
        [makeTable({ exclusionConstraints: [expressionDesired] })],
        [makeTable({ exclusionConstraints: [expressionCurrent] })]
      ).hasChanges
    ).toBe(false);

    const unnamedAddSql = differ
      .generateMigrationPlan(
        [
          makeTable({
            exclusionConstraints: [
              makeExclusion({ name: undefined }),
              makeExclusion({
                name: undefined,
                elements: [
                  {
                    definition: "other_range",
                    operator: { name: "&&" },
                  },
                ],
              }),
            ],
          }),
        ],
        [makeTable()]
      )
      .transactional.join("\n");
    expect(unnamedAddSql).toContain("ADD EXCLUDE");

    const replacements: ExclusionConstraint[] = [
      makeExclusion({ method: "spgist" }),
      makeExclusion({
        elements: [
          { definition: "during", operator: { name: "&&" } },
          { definition: "other_range", operator: { name: "&&" } },
        ],
      }),
      makeExclusion({
        elements: [{ definition: "other_range", operator: { name: "&&" } }],
      }),
      makeExclusion({
        elements: [{ definition: "during", operator: { name: "-|-" } }],
      }),
      makeExclusion({
        elements: [
          {
            definition: "during",
            operator: { name: "&&", schema: "custom_ops" },
          },
        ],
      }),
      makeExclusion({ include: ["id"] }),
      makeExclusion({ storageParameters: { fillfactor: "80" } }),
      makeExclusion({ tablespace: "fast_indexes" }),
      makeExclusion({ deferrable: true }),
      makeExclusion({ deferrable: true, initiallyDeferred: true }),
      makeExclusion({ where: undefined }),
      makeExclusion({ where: "id >= 0" }),
    ];

    for (const replacement of replacements) {
      const sql = differ
        .generateMigrationPlan(
          [makeTable({ exclusionConstraints: [replacement] })],
          [makeTable({ exclusionConstraints: [current] })]
        )
        .transactional.join("\n");
      expect(sql).toContain('DROP CONSTRAINT "users_no_overlap"');
      expect(sql).toContain("ADD CONSTRAINT \"users_no_overlap\" EXCLUDE");
    }
  });

  test("primary key helpers cover add drop modify and none", () => {
    const differ = new SchemaDiffer();
    const add = (differ as any).comparePrimaryKeys(makePrimaryKey(["id"]), undefined);
    const drop = (differ as any).comparePrimaryKeys(undefined, makePrimaryKey(["id"], "users_pkey"));
    const modify = (differ as any).comparePrimaryKeys(
      makePrimaryKey(["id", "tenant_id"], "users_pkey"),
      makePrimaryKey(["id"], "users_pkey")
    );
    const none = (differ as any).comparePrimaryKeys(
      makePrimaryKey(["id"]),
      makePrimaryKey(["id"], "other_name")
    );

    expect(add.type).toBe("add");
    expect(drop.type).toBe("drop");
    expect(modify.type).toBe("modify");
    expect(none.type).toBe("none");

    const desired = makeTable({ primaryKey: makePrimaryKey(["id", "tenant_id"], "users_pkey") });
    const current = makeTable({ primaryKey: makePrimaryKey(["id"], "users_pkey") });

    const full = (differ as any).generatePrimaryKeyStatements(desired, current) as string[];
    expect(full).toHaveLength(2);
    expect(full[0]).toContain("DROP CONSTRAINT");
    expect(full[1]).toContain("ADD CONSTRAINT");

    const dropOnly = (differ as any).generatePrimaryKeyDropStatements(
      desired,
      current,
      "\"public\".\"users\""
    ) as string[];
    const addOnly = (differ as any).generatePrimaryKeyAddStatements(
      desired,
      current,
      "\"public\".\"users\""
    ) as string[];

    expect(dropOnly).toHaveLength(1);
    expect(addOnly).toHaveLength(1);
  });

  test("generateConstraintStatementsWithColumnContext covers check foreign key and unique branches", () => {
    const differ = new SchemaDiffer();
    const desired = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "email", type: "TEXT", nullable: false }),
      ],
      checkConstraints: [
        { name: "users_email_check", expression: "email <> ''" },
        { name: "users_id_check", expression: "id > 0" },
      ],
      foreignKeys: [
        {
          name: "fk_profile",
          columns: ["id"],
          referencedTable: "profiles",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
        },
        {
          columns: ["email"],
          referencedTable: "contacts",
          referencedColumns: ["email"],
          onDelete: "SET NULL",
        },
        {
          name: "fk_new_named",
          columns: ["id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
        },
        {
          columns: ["id"],
          referencedTable: "teams",
          referencedColumns: ["id"],
        },
      ],
      uniqueConstraints: [{ name: "uq_email", columns: ["email"] }],
    });
    const current = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "old_email", type: "TEXT", nullable: true }),
      ],
      checkConstraints: [
        { name: "users_old_check", expression: "email <> ''" },
        { name: "users_age_check", expression: "age > 0" },
      ],
      foreignKeys: [
        {
          name: "fk_profile",
          columns: ["id"],
          referencedTable: "profiles",
          referencedColumns: ["id"],
          onDelete: "RESTRICT",
        },
        {
          name: "fk_email_old",
          columns: ["email"],
          referencedTable: "contacts",
          referencedColumns: ["email"],
          onDelete: "NO ACTION",
        },
        {
          name: "fk_old_email",
          columns: ["old_email"],
          referencedTable: "contacts",
          referencedColumns: ["email"],
        },
        {
          name: "fk_unused",
          columns: ["id"],
          referencedTable: "departments",
          referencedColumns: ["id"],
        },
      ],
      uniqueConstraints: [{ name: "uq_old_email", columns: ["old_email"] }],
    });

    const statements = (differ as any).generateConstraintStatementsWithColumnContext(
      desired,
      current,
      "\"public\".\"users\""
    ) as string[];

    const sql = statements.join("\n");
    expect(sql).toContain("DROP CONSTRAINT \"users_old_check\"");
    expect(sql).toContain("ADD CONSTRAINT \"users_email_check\" CHECK");
    expect(sql).toContain("ADD CONSTRAINT \"users_id_check\" CHECK");
    expect(sql).toContain("DROP CONSTRAINT \"users_age_check\"");
    expect(sql).toContain("DROP CONSTRAINT \"fk_profile\"");
    expect(sql).toContain("DROP CONSTRAINT \"fk_email_old\"");
    expect(sql).toContain("DROP CONSTRAINT \"fk_unused\"");
    expect(sql).not.toContain("DROP CONSTRAINT \"fk_old_email\"");
    expect(sql).toContain("ADD CONSTRAINT \"fk_profile\" FOREIGN KEY");
    expect(sql).toContain("ADD CONSTRAINT \"fk_new_named\" FOREIGN KEY");
    expect(sql).toContain("REFERENCES \"teams\" (\"id\")");
    expect(sql).toContain("DROP CONSTRAINT \"uq_old_email\"");
    expect(sql).toContain("ADD CONSTRAINT \"uq_email\" UNIQUE");
  });

  test("foreign key validation state chooses validate, replace, and no-op transitions", function () {
    const differ = new SchemaDiffer();
    const valid: ForeignKeyConstraint = {
      name: "users_profile_fkey",
      columns: ["id"],
      referencedTable: "profiles",
      referencedColumns: ["id"],
    };
    const notValid = { ...valid, notValid: true };

    const validateSql = differ
      .generateMigrationPlan(
        [makeTable({ foreignKeys: [valid] })],
        [makeTable({ foreignKeys: [notValid] })]
      )
      .transactional.join("\n");
    expect(validateSql).toContain(
      'VALIDATE CONSTRAINT "users_profile_fkey"'
    );
    expect(validateSql).not.toContain("DROP CONSTRAINT");

    const replaceSql = differ
      .generateMigrationPlan(
        [makeTable({ foreignKeys: [notValid] })],
        [makeTable({ foreignKeys: [valid] })]
      )
      .transactional.join("\n");
    expect(replaceSql).toContain('DROP CONSTRAINT "users_profile_fkey"');
    expect(replaceSql).toContain("NOT VALID");

    expect(
      differ.generateMigrationPlan(
        [makeTable({ foreignKeys: [notValid] })],
        [makeTable({ foreignKeys: [notValid] })]
      ).hasChanges
    ).toBe(false);

    const unnamedDesired = { ...valid, name: undefined };
    const legacyStatements = (differ as any).generateForeignKeyStatements(
      '"public"."users"',
      [unnamedDesired],
      [notValid]
    ) as string[];
    expect(legacyStatements).toHaveLength(1);
    expect(legacyStatements[0]).toContain(
      'VALIDATE CONSTRAINT "users_profile_fkey"'
    );

    expect(
      differ.generateMigrationPlan(
        [makeTable({ foreignKeys: [valid] })],
        [makeTable({ foreignKeys: [notValid] })],
        { constraintValidationManaged: false }
      ).hasChanges
    ).toBe(false);
  });

  test("matches unnamed foreign keys across public qualification and server names", function () {
    const differ = new SchemaDiffer();
    const desired: ForeignKeyConstraint = {
      columns: ["id"],
      referencedTable: "public.profiles",
      referencedColumns: ["id"],
    };
    const current: ForeignKeyConstraint = {
      ...desired,
      name: "users_id_fkey",
      referencedTable: "profiles",
    };

    const plan = differ.generateMigrationPlan(
      [makeTable({ foreignKeys: [desired] })],
      [makeTable({ foreignKeys: [current] })]
    );

    expect(plan.hasChanges).toBe(false);
  });

  test("check metadata chooses validate, replace, and post-create add transitions", function () {
    const differ = new SchemaDiffer();
    const valid: CheckConstraint = {
      name: "users_id_check",
      expression: "id > 0",
      noInherit: true,
    };
    const notValid = { ...valid, notValid: true };

    const validatePlan = differ.generateMigrationPlan(
      [makeTable({ checkConstraints: [valid] })],
      [makeTable({ checkConstraints: [notValid] })]
    );
    expect(validatePlan.transactional.join("\n")).toContain(
      'VALIDATE CONSTRAINT "users_id_check"'
    );
    expect(validatePlan.transactional.join("\n")).not.toContain(
      "DROP CONSTRAINT"
    );

    const replaceSql = differ
      .generateMigrationPlan(
        [makeTable({ checkConstraints: [notValid] })],
        [makeTable({ checkConstraints: [valid] })]
      )
      .transactional.join("\n");
    expect(replaceSql).toContain('DROP CONSTRAINT "users_id_check"');
    expect(replaceSql).toContain("NO INHERIT NOT VALID");

    const inheritanceSql = differ
      .generateMigrationPlan(
        [makeTable({ checkConstraints: [valid] })],
        [
          makeTable({
            checkConstraints: [
              { ...valid, noInherit: undefined },
            ],
          }),
        ]
      )
      .transactional.join("\n");
    expect(inheritanceSql).toContain("DROP CONSTRAINT");
    expect(inheritanceSql).toContain("NO INHERIT");

    const createPlan = differ.generateMigrationPlan(
      [makeTable({ checkConstraints: [notValid] })],
      []
    );
    expect(createPlan.transactional).toHaveLength(2);
    expect(createPlan.transactional[0]).not.toContain("CHECK");
    expect(createPlan.transactional[1]).toContain("NOT VALID");

    expect(
      differ.generateMigrationPlan(
        [makeTable({ checkConstraints: [notValid] })],
        [makeTable({ checkConstraints: [notValid] })]
      ).hasChanges
    ).toBe(false);

    const legacyStatements = (differ as any).generateCheckConstraintStatements(
      "public.users",
      [{ ...valid, name: undefined }],
      [notValid]
    ) as string[];
    expect(legacyStatements).toEqual([
      'ALTER TABLE "public"."users" VALIDATE CONSTRAINT "users_id_check";',
    ]);

    expect(
      differ.generateMigrationPlan(
        [makeTable({ checkConstraints: [valid] })],
        [makeTable({ checkConstraints: [notValid] })],
        { constraintValidationManaged: false }
      ).hasChanges
    ).toBe(false);

    const duplicateExpressionCurrent: CheckConstraint[] = [
      { name: "users_id_local", expression: "id > 0", noInherit: true },
      { name: "users_id_inherited", expression: "id > 0" },
    ];
    expect(
      differ.generateMigrationPlan(
        [
          makeTable({
            checkConstraints: [...duplicateExpressionCurrent].reverse(),
          }),
        ],
        [makeTable({ checkConstraints: duplicateExpressionCurrent })]
      ).hasChanges
    ).toBe(false);

    expect(
      differ.generateMigrationPlan(
        [
          makeTable({
            checkConstraints: [
              { expression: "id > 0" },
              { expression: "id > 0", noInherit: true },
            ],
          }),
        ],
        [makeTable({ checkConstraints: duplicateExpressionCurrent })]
      ).hasChanges
    ).toBe(false);

    const duplicateChangeSql = differ
      .generateMigrationPlan(
        [
          makeTable({
            checkConstraints: [
              duplicateExpressionCurrent[0]!,
              {
                ...duplicateExpressionCurrent[1]!,
                noInherit: true,
              },
            ],
          }),
        ],
        [makeTable({ checkConstraints: duplicateExpressionCurrent })]
      )
      .transactional.join("\n");
    expect(duplicateChangeSql).toContain(
      'DROP CONSTRAINT "users_id_inherited"'
    );
    expect(duplicateChangeSql).not.toContain(
      'DROP CONSTRAINT "users_id_local"'
    );
  });

  test("generateMigrationPlan keeps stable order for mixed object kinds", () => {
    const differ = new SchemaDiffer();

    const current = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "legacy", type: "TEXT", nullable: true }),
        makeColumn({ name: "account_id", type: "INTEGER", nullable: true }),
        makeColumn({ name: "status", type: "TEXT", nullable: true, default: "'new'" }),
      ],
      primaryKey: makePrimaryKey(["id"], "users_pkey"),
      checkConstraints: [
        { name: "users_status_check", expression: "status <> ''" },
        { name: "users_legacy_check", expression: "legacy <> ''" },
      ],
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "SET NULL",
        },
        {
          name: "fk_users_legacy_owner",
          columns: ["legacy"],
          referencedTable: "owners",
          referencedColumns: ["code"],
        },
      ],
      uniqueConstraints: [
        { name: "uq_users_legacy", columns: ["legacy"] },
        { name: "uq_users_status_account", columns: ["status", "account_id"] },
      ],
      indexes: [
        {
          name: "idx_users_legacy",
          tableName: "users",
          schema: "public",
          columns: ["legacy"],
          type: "btree",
        },
        {
          name: "idx_users_status",
          tableName: "users",
          schema: "public",
          columns: ["status"],
          where: "status <> 'archived'",
          type: "btree",
        },
        {
          name: "idx_users_account",
          tableName: "users",
          schema: "public",
          columns: ["account_id"],
          type: "btree",
        },
      ],
    });

    const desired = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "account_id", type: "BIGINT", nullable: false }),
        makeColumn({ name: "status", type: "TEXT", nullable: false, default: "'active'" }),
        makeColumn({ name: "email", type: "TEXT", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id", "account_id"], "users_pkey"),
      checkConstraints: [
        {
          name: "users_status_check_v2",
          expression: "status IN ('active', 'paused')",
        },
      ],
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "RESTRICT",
        },
        {
          name: "fk_users_manager",
          columns: ["id"],
          referencedTable: "managers",
          referencedColumns: ["user_id"],
        },
      ],
      uniqueConstraints: [{ name: "uq_users_email", columns: ["email"] }],
      indexes: [
        {
          name: "idx_users_status",
          tableName: "users",
          schema: "public",
          columns: ["status"],
          where: "status IN ('active', 'paused')",
          type: "btree",
        },
        {
          name: "idx_users_email",
          tableName: "users",
          schema: "public",
          columns: ["email"],
          type: "btree",
        },
      ],
    });

    const currentReordered = makeTable({
      ...current,
      checkConstraints: reverseCopy(current.checkConstraints || []),
      foreignKeys: reverseCopy(current.foreignKeys || []),
      uniqueConstraints: reverseCopy(current.uniqueConstraints || []),
      indexes: reverseCopy(current.indexes || []),
    });

    const desiredReordered = makeTable({
      ...desired,
      checkConstraints: reverseCopy(desired.checkConstraints || []),
      foreignKeys: reverseCopy(desired.foreignKeys || []),
      uniqueConstraints: reverseCopy(desired.uniqueConstraints || []),
      indexes: reverseCopy(desired.indexes || []),
    });

    const plan1 = differ.generateMigrationPlan([desired], [current]);
    const plan2 = differ.generateMigrationPlan([desiredReordered], [currentReordered]);

    expect(plan1.transactional).toEqual(plan2.transactional);
    expect(plan1.concurrent).toEqual(plan2.concurrent);
    expect(plan1.deferred).toEqual(plan2.deferred);
  });

  test("generateMigrationPlan keeps stable order for mixed multi-table operations", () => {
    const differ = new SchemaDiffer();

    const currentAccounts = makeTable({
      name: "accounts",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "legacy", type: "TEXT", nullable: true }),
      ],
      primaryKey: makePrimaryKey(["id"], "accounts_pkey"),
      indexes: [
        {
          name: "idx_accounts_legacy",
          tableName: "accounts",
          schema: "public",
          columns: ["legacy"],
          type: "btree",
        },
      ],
    });
    const currentUsers = makeTable({
      name: "users",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "account_id", type: "INTEGER", nullable: true }),
        makeColumn({ name: "status", type: "TEXT", nullable: true, default: "'new'" }),
        makeColumn({ name: "old_col", type: "TEXT", nullable: true }),
      ],
      primaryKey: makePrimaryKey(["id"], "users_pkey"),
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "SET NULL",
        },
      ],
      uniqueConstraints: [{ name: "uq_users_old_col", columns: ["old_col"] }],
      indexes: [
        {
          name: "idx_users_status",
          tableName: "users",
          schema: "public",
          columns: ["status"],
          type: "btree",
        },
      ],
    });
    const currentAuditLogs = makeTable({
      name: "audit_logs",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "message", type: "TEXT", nullable: true }),
      ],
      primaryKey: makePrimaryKey(["id"], "audit_logs_pkey"),
    });

    const desiredAccounts = makeTable({
      name: "accounts",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "status", type: "TEXT", nullable: false, default: "'active'" }),
      ],
      primaryKey: makePrimaryKey(["id"], "accounts_pkey"),
      indexes: [
        {
          name: "idx_accounts_status",
          tableName: "accounts",
          schema: "public",
          columns: ["status"],
          type: "btree",
        },
      ],
    });
    const desiredUsers = makeTable({
      name: "users",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "account_id", type: "BIGINT", nullable: false }),
        makeColumn({ name: "status", type: "TEXT", nullable: false, default: "'active'" }),
        makeColumn({ name: "email", type: "TEXT", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id"], "users_pkey"),
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
        },
      ],
      uniqueConstraints: [{ name: "uq_users_email", columns: ["email"] }],
      indexes: [
        {
          name: "idx_users_email",
          tableName: "users",
          schema: "public",
          columns: ["email"],
          type: "btree",
        },
      ],
    });
    const desiredTeams = makeTable({
      name: "teams",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "name", type: "TEXT", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id"], "teams_pkey"),
      uniqueConstraints: [{ name: "uq_teams_name", columns: ["name"] }],
    });
    const desiredProfiles = makeTable({
      name: "profiles",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "user_id", type: "INTEGER", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id"], "profiles_pkey"),
      foreignKeys: [
        {
          name: "fk_profiles_user",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
        },
      ],
    });

    const current = [currentAuditLogs, currentUsers, currentAccounts];
    const desired = [desiredProfiles, desiredTeams, desiredUsers, desiredAccounts];

    const plan1 = differ.generateMigrationPlan(desired, current);
    const plan2 = differ.generateMigrationPlan(reverseCopy(desired), reverseCopy(current));

    expect(plan1.transactional).toEqual(plan2.transactional);
    expect(plan1.concurrent).toEqual(plan2.concurrent);
    expect(plan1.deferred).toEqual(plan2.deferred);
  });

  test("generateMigrationPlan handles same table name across schemas without collisions", () => {
    const differ = new SchemaDiffer();

    const currentPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const currentTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const desiredPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const desiredTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "email", type: "TEXT", nullable: true }),
      ],
    });

    const plan = differ.generateMigrationPlan(
      [desiredPublic, desiredTenant],
      [currentPublic, currentTenant]
    );

    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER TABLE "tenant_a"."users"');
    expect(sql).toContain('ADD COLUMN "email" TEXT');
    expect(sql).not.toContain('ALTER TABLE "public"."users"');
  });

  test("generateMigrationPlan drops only removed schema table when names match", () => {
    const differ = new SchemaDiffer();

    const currentPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const currentTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const desiredPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const plan = differ.generateMigrationPlan([desiredPublic], [currentPublic, currentTenant]);
    const sql = plan.transactional.join("\n");

    expect(sql).toContain('DROP TABLE "tenant_a"."users" RESTRICT;');
    expect(sql).not.toContain('DROP TABLE "public"."users" RESTRICT;');
  });

  test("generateMigrationPlan drops all removed same-name tables across schemas", () => {
    const differ = new SchemaDiffer();

    const currentPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const currentTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const plan = differ.generateMigrationPlan([], [currentPublic, currentTenant]);
    const sql = plan.transactional.join("\n");

    expect(sql).toContain('DROP TABLE "public"."users" RESTRICT;');
    expect(sql).toContain('DROP TABLE "tenant_a"."users" RESTRICT;');
  });
});
