import { Client } from "pg";
import { parse } from "pgsql-parser";
import { toPgAstNode } from "./parser/pgsql-ast";
import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
  ExclusionConstraint,
  Index,
  EnumType,
  CompositeType,
  View,
  Schema,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
  SqlObject,
  PostgresPolicyDefinition,
  IdentityColumn,
  PostgresTriggerEnabledMode,
  PostgresReplicaIdentity,
  PostgresColumnStatistics,
  PostgresRoleDefinition,
  PostgresGrantDefinition,
  PostgresGrantObjectType,
  PostgresDefaultPrivilegeDefinition,
  IndexTerm,
} from "../../types/schema";
import { ValidationError } from "../../types/errors";
import { renderIdentityClause } from "../../utils/identity";
import { renderCollationName } from "../../utils/collation";
import {
  parsePostgresForeignServerCatalogOptions,
  renderPostgresForeignServerCreate,
} from "../../utils/postgres-foreign-server";
import { parseCreateIndex } from "./parser/index-parser";
import {
  columnCompressionFromCatalog,
  columnStorageFromCatalog,
} from "../../utils/column-physical";
import { getDefaultFunctionCost } from "../../utils/function-cost";
import { postgresTriggerModeFromCatalogCode } from "../../utils/postgres-trigger";
import {
  postgresColumnStatisticsFromCatalog,
  postgresStatisticsTargetFromCatalog,
} from "../../utils/postgres-statistics";
import {
  renderPostgresRoleCreate,
  renderPostgresRoleDrop,
} from "../../utils/postgres-role";
import { isPostgresSerialType } from "../../utils/sql";
import { parseTypeReference } from "../../utils/postgres-type-reference";
import {
  isSupportedPostgresGrantPrivilege,
  postgresGrantKey,
  renderPostgresGrant,
  renderPostgresGrantRevoke,
} from "../../utils/postgres-grant";
import {
  isSupportedPostgresDefaultPrivilege,
  postgresDefaultPrivilegeKey,
  postgresDefaultPrivilegeObjectTypeFromCatalog,
  renderPostgresDefaultPrivilegeRestore,
  renderPostgresDefaultPrivilegeState,
} from "../../utils/postgres-default-privilege";

const IDENTITY_SEQUENCE_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      sequence_namespace.nspname as sequence_schema,
      sequence_class.relname as sequence_name,
      sequence_class.relpersistence as sequence_persistence,
      sequence_catalog.seqstart,
      sequence_catalog.seqincrement,
      sequence_catalog.seqmin,
      sequence_catalog.seqmax,
      sequence_catalog.seqcache,
      sequence_catalog.seqcycle
    FROM pg_depend dependency
    JOIN pg_class sequence_class
      ON sequence_class.oid = dependency.objid
      AND sequence_class.relkind = 'S'
    JOIN pg_namespace sequence_namespace
      ON sequence_namespace.oid = sequence_class.relnamespace
    JOIN pg_sequence sequence_catalog
      ON sequence_catalog.seqrelid = sequence_class.oid
    WHERE dependency.refobjid = a.attrelid
      AND dependency.refobjsubid = a.attnum
      AND dependency.classid = 'pg_class'::regclass
      AND dependency.refclassid = 'pg_class'::regclass
      AND dependency.deptype = 'i'
    LIMIT 1
  ) identity_sequence ON a.attidentity != ''
`;

const SERIAL_SEQUENCE_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      TRUE as is_serial,
      serial_sequence_catalog.seqstart = 1
        AND serial_sequence_catalog.seqincrement = 1
        AND serial_sequence_catalog.seqmin = 1
        AND serial_sequence_catalog.seqmax = CASE serial_sequence_catalog.seqtypid
          WHEN 'smallint'::regtype THEN 32767
          WHEN 'integer'::regtype THEN 2147483647
          WHEN 'bigint'::regtype THEN 9223372036854775807
        END
        AND serial_sequence_catalog.seqcache = 1
        AND NOT serial_sequence_catalog.seqcycle
        AND serial_sequence.relpersistence = CASE
          WHEN current_setting('server_version_num')::integer >= 150000
            THEN cls.relpersistence
          ELSE 'p'
        END
        AS options_match
    FROM pg_depend sequence_ownership
    JOIN pg_class serial_sequence
      ON serial_sequence.oid = sequence_ownership.objid
      AND serial_sequence.relkind = 'S'
    JOIN pg_sequence serial_sequence_catalog
      ON serial_sequence_catalog.seqrelid = serial_sequence.oid
      AND serial_sequence_catalog.seqtypid = a.atttypid
    JOIN pg_depend default_dependency
      ON default_dependency.refobjid = serial_sequence.oid
      AND default_dependency.classid = 'pg_attrdef'::regclass
      AND default_dependency.objid = ad.oid
      AND default_dependency.refclassid = 'pg_class'::regclass
      AND default_dependency.deptype = 'n'
    WHERE sequence_ownership.refobjid = a.attrelid
      AND sequence_ownership.refobjsubid = a.attnum
      AND sequence_ownership.classid = 'pg_class'::regclass
      AND sequence_ownership.refclassid = 'pg_class'::regclass
      AND sequence_ownership.deptype = 'a'
    LIMIT 1
  ) serial_sequence ON a.attidentity = ''
`;

type PostgresGrantCatalogRow = {
  grantee_name: string;
  grantee_is_public?: boolean;
  privilege_type: string;
  is_grantable: boolean;
  grantor_name?: string;
  owner_name?: string;
  is_implicit_default?: boolean;
};

function getIdentitySequencePersistence(
  persistence: unknown
): IdentityColumn["sequencePersistence"] {
  if (persistence === "u") return "unlogged";
  if (persistence === "p") return "logged";
  return undefined;
}

function getPostgresTriggerMode(
  code: unknown,
  identity: string
): PostgresTriggerEnabledMode | undefined {
  if (code === undefined || code === null) {
    return undefined;
  }
  const mode = postgresTriggerModeFromCatalogCode(code);
  if (!mode) {
    throw new ValidationError(
      `Unsupported PostgreSQL trigger firing mode '${String(code)}' is present on ${identity}`,
      identity,
      "enabled",
      code
    );
  }
  return mode === "origin" ? undefined : mode;
}

function getPostgresReplicaIdentity(
  code: unknown,
  indexName: unknown,
  identity: string
): PostgresReplicaIdentity | undefined {
  switch (code) {
    case undefined:
    case null:
    case "d":
      return undefined;
    case "f":
      return { mode: "full" };
    case "n":
      return { mode: "nothing" };
    case "i":
      return typeof indexName === "string" && indexName.length > 0
        ? { mode: "index", indexName }
        : { mode: "index-missing" };
    default:
      throw new ValidationError(
        `Unsupported PostgreSQL replica identity mode '${String(code)}' is present on ${identity}`,
        identity,
        "replicaIdentity",
        code
      );
  }
}

const COLUMN_COLLATION_JOIN_SQL = `
  JOIN pg_type column_type ON column_type.oid = a.atttypid
  JOIN pg_namespace column_type_namespace
    ON column_type_namespace.oid = column_type.typnamespace
  LEFT JOIN pg_collation column_collation
    ON column_collation.oid = a.attcollation
    AND a.attcollation <> column_type.typcollation
  LEFT JOIN pg_namespace column_collation_namespace
    ON column_collation_namespace.oid = column_collation.collnamespace
`;

const UNSUPPORTED_CONSTRAINT_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT json_agg(
      json_build_object(
        'constraintName', constraint_catalog.conname,
        'constraintType', constraint_catalog.contype,
        'enforced', COALESCE(
          (to_jsonb(constraint_catalog) ->> 'conenforced')::boolean,
          true
        ),
        'period', COALESCE(
          (to_jsonb(constraint_catalog) ->> 'conperiod')::boolean,
          false
        ),
        'validated', constraint_catalog.convalidated,
        'noInherit', constraint_catalog.connoinherit
      )
      ORDER BY constraint_catalog.conname
    ) AS items
    FROM pg_constraint constraint_catalog
    WHERE constraint_catalog.conrelid = c.oid
      AND (
        NOT COALESCE(
          (to_jsonb(constraint_catalog) ->> 'conenforced')::boolean,
          true
        )
        OR COALESCE(
          (to_jsonb(constraint_catalog) ->> 'conperiod')::boolean,
          false
        )
        OR (
          constraint_catalog.contype = 'n'
          AND (
            constraint_catalog.connoinherit
            OR NOT constraint_catalog.convalidated
          )
        )
      )
  ) unsupported_constraint ON true
`;

const COMPOSITE_TYPE_DEPENDENCY_CTE_SQL = `
  WITH RECURSIVE target_types AS (
    SELECT
      target_type.oid,
      target_type.typrelid,
      target_type.typname,
      type_namespace.nspname
    FROM pg_type target_type
    JOIN pg_namespace type_namespace
      ON type_namespace.oid = target_type.typnamespace
    WHERE type_namespace.nspname = ANY($1::text[])
      AND target_type.typtype = 'c'
  ), dependent_types AS (
    SELECT
      target_type.oid as target_type_oid,
      target_type.oid as dependent_type_oid
    FROM target_types target_type

    UNION

    SELECT
      dependent_type.target_type_oid,
      containing_type.oid
    FROM dependent_types dependent_type
    JOIN LATERAL (
      SELECT candidate.oid
      FROM pg_type candidate
      WHERE candidate.typbasetype = dependent_type.dependent_type_oid
         OR candidate.typelem = dependent_type.dependent_type_oid

      UNION

      SELECT type_range.rngtypid
      FROM pg_range type_range
      WHERE type_range.rngsubtype = dependent_type.dependent_type_oid

      UNION

      SELECT type_range.rngmultitypid
      FROM pg_range type_range
      WHERE type_range.rngsubtype = dependent_type.dependent_type_oid
    ) containing_type ON true
  )
`;

function getPostgresTypeRoutineDependentsSql(referenceOids: string): string {
  return `
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'schema', routine_namespace.nspname,
          'name', routine.proname,
          'kind', CASE routine.prokind
            WHEN 'p' THEN 'procedure'
            ELSE 'function'
          END,
          'identityArguments', pg_get_function_identity_arguments(routine.oid)
        )
        ORDER BY routine_namespace.nspname, routine.proname,
          pg_get_function_identity_arguments(routine.oid)
      )
      FROM pg_depend dependency
      JOIN pg_proc routine
        ON dependency.classid = 'pg_proc'::regclass
        AND routine.oid = dependency.objid
      JOIN pg_namespace routine_namespace
        ON routine_namespace.oid = routine.pronamespace
      WHERE dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid IN (${referenceOids})
        AND dependency.deptype = 'n'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_depend internal_dependency
          WHERE internal_dependency.classid = 'pg_proc'::regclass
            AND internal_dependency.objid = routine.oid
            AND internal_dependency.deptype = 'i'
        )
    ), '[]'::jsonb)
  `;
}

function getPostgresTypeCatalogDependentsSql(referenceOids: string): string {
  return `
    COALESCE((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'type', identified.type,
          'schema', identified.schema,
          'name', COALESCE(
            identified.name,
            dependent_constraint.conname,
            dependent_policy.polname,
            dependent_trigger.tgname
          ),
          'identity', identified.identity,
          'ownerSchema', owner_relation.owner_schema,
          'ownerRelation', owner_relation.owner_relation,
          'ownerRelationKind', owner_relation.owner_relation_kind,
          'ownerAttributes', owner_relation.owner_attributes
        ))
        ORDER BY identified.type, identified.identity
      )
      FROM pg_depend dependency
      CROSS JOIN LATERAL pg_identify_object(
        dependency.classid,
        dependency.objid,
        dependency.objsubid
      ) identified
      LEFT JOIN pg_constraint dependent_constraint
        ON dependency.classid = 'pg_constraint'::regclass
        AND dependent_constraint.oid = dependency.objid
      LEFT JOIN pg_policy dependent_policy
        ON dependency.classid = 'pg_policy'::regclass
        AND dependent_policy.oid = dependency.objid
      LEFT JOIN pg_trigger dependent_trigger
        ON dependency.classid = 'pg_trigger'::regclass
        AND dependent_trigger.oid = dependency.objid
      LEFT JOIN LATERAL (
        SELECT
          owner_namespace.nspname as owner_schema,
          owner_class.relname as owner_relation,
          owner_class.relkind as owner_relation_kind,
          array_agg(DISTINCT owner_attribute.attname ORDER BY owner_attribute.attname)
            FILTER (WHERE owner_attribute.attname IS NOT NULL)
            as owner_attributes
        FROM pg_depend owner_dependency
        JOIN pg_class owner_class
          ON owner_dependency.refclassid = 'pg_class'::regclass
          AND owner_class.oid = owner_dependency.refobjid
        JOIN pg_namespace owner_namespace
          ON owner_namespace.oid = owner_class.relnamespace
        LEFT JOIN pg_attribute owner_attribute
          ON owner_attribute.attrelid = owner_class.oid
          AND owner_attribute.attnum = owner_dependency.refobjsubid
        WHERE owner_dependency.classid = dependency.classid
          AND owner_dependency.objid = dependency.objid
          AND owner_dependency.deptype IN ('a', 'i', 'P', 'S')
        GROUP BY
          owner_namespace.nspname,
          owner_class.relname,
          owner_class.relkind
        ORDER BY owner_namespace.nspname, owner_class.relname
        LIMIT 1
      ) owner_relation ON true
      WHERE dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid IN (${referenceOids})
        AND dependency.deptype = 'n'
        AND NOT (
          dependency.classid = 'pg_class'::regclass
          AND dependency.objsubid > 0
        )
        AND dependency.classid <> 'pg_proc'::regclass
        AND NOT (
          dependency.classid = 'pg_type'::regclass
          AND EXISTS (
            SELECT 1
            FROM pg_type dependent_type
            LEFT JOIN pg_range dependent_range
              ON dependent_range.rngtypid = dependent_type.oid
            WHERE dependent_type.oid = dependency.objid
              AND (
                dependent_type.typtype = 'd'
                OR dependent_range.rngtypid IS NOT NULL
              )
          )
        )
    ), '[]'::jsonb)
  `;
}

function parseBooleanRelationOption(
  options: string[] | null,
  name: string
): boolean | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const option = options.find(function findOption(candidate) {
    return candidate.startsWith(`${name}=`);
  });
  if (!option) {
    return undefined;
  }
  return option.slice(name.length + 1) === "true";
}

function parseRoutineConfiguration(
  settings: string[] | null
): Record<string, string> | undefined {
  if (!Array.isArray(settings)) {
    return undefined;
  }

  const configuration: Record<string, string> = {};
  for (const setting of settings) {
    const separator = setting.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    configuration[setting.slice(0, separator)] = setting.slice(separator + 1);
  }
  return Object.keys(configuration).length > 0 ? configuration : undefined;
}

const ROUTINE_DEPENDENT_OBJECTS_SQL = `
  ARRAY(
    SELECT dependent_object.description
    FROM (
      SELECT DISTINCT
        pg_describe_object(
          dependency.classid,
          dependency.objid,
          dependency.objsubid
        ) AS description
      FROM pg_depend dependency
      WHERE dependency.refclassid = 'pg_proc'::regclass
        AND dependency.refobjid = p.oid
    ) dependent_object
    WHERE dependent_object.description IS NOT NULL
    ORDER BY dependent_object.description
  )
`;

const ROUTINE_ARGUMENT_TYPES_SQL = `
  ARRAY(
    SELECT
      CASE
        WHEN argument_namespace.nspname = 'pg_catalog'
          THEN pg_catalog.format_type(argument_type.oid, NULL)
        WHEN element_type.oid IS NOT NULL
          THEN pg_catalog.format(
            '%I.%I[]',
            element_namespace.nspname,
            element_type.typname
          )
        ELSE pg_catalog.format(
          '%I.%I',
          argument_namespace.nspname,
          argument_type.typname
        )
      END
    FROM unnest(
      COALESCE(p.proallargtypes, p.proargtypes::oid[])
    ) WITH ORDINALITY AS routine_argument(type_oid, position)
    JOIN pg_type argument_type ON argument_type.oid = routine_argument.type_oid
    JOIN pg_namespace argument_namespace
      ON argument_namespace.oid = argument_type.typnamespace
    LEFT JOIN pg_type element_type
      ON element_type.oid = argument_type.typelem
      AND element_type.typarray = argument_type.oid
    LEFT JOIN pg_namespace element_namespace
      ON element_namespace.oid = element_type.typnamespace
    ORDER BY routine_argument.position
  )
`;

const ROUTINE_RETURN_TYPE_SQL = `
  CASE
    WHEN p.proretset THEN 'SETOF ' ELSE ''
  END ||
  CASE
    WHEN return_namespace.nspname = 'pg_catalog'
      THEN pg_catalog.format_type(return_type.oid, NULL)
    WHEN return_element_type.oid IS NOT NULL
      THEN pg_catalog.format(
        '%I.%I[]',
        return_element_namespace.nspname,
        return_element_type.typname
      )
    ELSE pg_catalog.format(
      '%I.%I',
      return_namespace.nspname,
      return_type.typname
    )
  END
`;

type RoutineParameter = Function["parameters"][number];

function catalogRoutineMode(value: unknown): RoutineParameter["mode"] {
  if (value === "i") return "IN";
  if (value === "o" || value === "t") return "OUT";
  if (value === "b") return "INOUT";
  if (value === "v") return "VARIADIC";
  return undefined;
}

function canonicalRoutineParameters(
  row: {
    argument_types?: unknown;
    argument_modes?: unknown;
    argument_names?: unknown;
  },
  parsedParameters: RoutineParameter[]
): RoutineParameter[] {
  if (!Array.isArray(row.argument_types)) {
    return parsedParameters;
  }

  const argumentTypes = row.argument_types;
  const argumentModes = Array.isArray(row.argument_modes)
    ? row.argument_modes
    : [];
  const argumentNames = Array.isArray(row.argument_names)
    ? row.argument_names
    : [];
  let displayedPosition = 0;

  return argumentTypes.map(function canonicalizeParameter(type, position) {
    const modeCode = argumentModes[position];
    const displayed = modeCode === "t"
      ? undefined
      : parsedParameters[displayedPosition++];
    const catalogName = argumentNames[position];
    const name = typeof catalogName === "string" && catalogName.length > 0
      ? catalogName
      : displayed?.name;

    return {
      name,
      type: typeof type === "string" ? type : displayed?.type || "unknown",
      mode: catalogRoutineMode(modeCode) || displayed?.mode,
      default: displayed?.default,
    };
  });
}

function parseRoutineDependentObjects(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const objects = value
    .filter(function isDescription(item): item is string {
      return typeof item === "string" && item.length > 0;
    })
    .sort();
  return objects.length > 0 ? objects : undefined;
}

interface RoutineFeatureCatalogRow {
  routine_kind?: string;
  has_sql_body?: boolean;
  object_file?: unknown;
  transform_types?: unknown;
  has_support?: boolean;
  routine_identity?: string;
  function_name?: string;
  procedure_name?: string;
}

function getUnsupportedRoutineFeatures(
  row: RoutineFeatureCatalogRow
): string[] {
  const features: string[] = [];
  if (row.routine_kind === "w") {
    features.push("WINDOW");
  } else if (row.routine_kind === "a") {
    features.push("aggregate");
  }
  if (row.has_sql_body === true) {
    features.push("SQL-standard body");
  }
  if (row.object_file !== null && row.object_file !== undefined) {
    features.push("linked-object AS");
  }
  if (Array.isArray(row.transform_types) && row.transform_types.length > 0) {
    features.push("TRANSFORM");
  }
  if (row.has_support === true) {
    features.push("SUPPORT");
  }
  return features;
}

function assertRoutineRowsAreSupported(rows: RoutineFeatureCatalogRow[]): void {
  for (const row of rows) {
    const features = getUnsupportedRoutineFeatures(row);
    if (features.length === 0) {
      continue;
    }

    const identity = row.routine_identity || row.function_name ||
      row.procedure_name || "unknown routine";
    throw new ValidationError(
      `Unsupported PostgreSQL routine ${identity} is present in a managed schema: ${features.join(", ")}. TerraDB cannot inspect this routine losslessly; remove it from the managed schema or replace it with a fully supported routine definition before planning`,
      `routine ${identity}`,
      "definition",
      features
    );
  }
}

interface UnsupportedConstraintCatalogRow {
  constraintName?: string;
  constraintType?: string;
  enforced?: boolean;
  period?: boolean;
  validated?: boolean;
  noInherit?: boolean;
}

interface TableConstraintCatalogRow {
  table_name?: string;
  table_schema?: string;
  schema_name?: string;
  relation_persistence?: string;
  relation_kind?: string;
  is_partition?: boolean;
  relation_options?: string[] | null;
  relation_tablespace?: string;
  relation_access_method?: string;
  unsupported_partition_features?: string[];
  unsupported_constraints?: UnsupportedConstraintCatalogRow[];
}

function getCatalogRelationIdentity(row: TableConstraintCatalogRow): string {
  const schemaName = row.table_schema || row.schema_name || "public";
  return `${schemaName}.${row.table_name || "unknown table"}`;
}

function getUnsupportedConstraintFeatures(
  constraint: UnsupportedConstraintCatalogRow
): string[] {
  const features: string[] = [];
  if (constraint.enforced === false) {
    features.push("NOT ENFORCED");
  }
  if (constraint.period === true) {
    features.push("WITHOUT OVERLAPS or PERIOD");
  }
  if (
    constraint.constraintType === "n" &&
    (constraint.noInherit === true || constraint.validated === false)
  ) {
    features.push("NOT NULL NO INHERIT or NOT VALID");
  }
  return features;
}

function assertConstraintRowsAreSupported(
  rows: TableConstraintCatalogRow[]
): void {
  for (const row of rows) {
    if (!Array.isArray(row.unsupported_constraints)) {
      continue;
    }

    for (const constraint of row.unsupported_constraints) {
      const features = getUnsupportedConstraintFeatures(constraint);
      if (features.length === 0) {
        continue;
      }

      const identity = `${getCatalogRelationIdentity(row)}.${
        constraint.constraintName || "unknown constraint"
      }`;
      throw new ValidationError(
        `Unsupported PostgreSQL constraint ${identity} is present in a managed schema: ${features.join(", ")}. TerraDB cannot inspect this constraint losslessly; replace it with a supported constraint or manage the table outside TerraDB before planning`,
        `constraint ${identity}`,
        "definition",
        features
      );
    }
  }
}

function assertPartitionRowsAreSupported(
  rows: TableConstraintCatalogRow[]
): void {
  for (const row of rows) {
    const identity = getCatalogRelationIdentity(row);
    if (row.relation_persistence === "u") {
      throw new ValidationError(
        `Unsupported PostgreSQL UNLOGGED partition hierarchy relation ${identity} is present in a managed schema. PostgreSQL 18 rejects unlogged partitioned parents and earlier releases do not propagate persistence consistently to children; use a logged partition hierarchy or manage it outside TerraDB before planning`,
        `relation ${identity}`,
        "persistence",
        "UNLOGGED"
      );
    }

    const features = Array.isArray(row.unsupported_partition_features)
      ? [...row.unsupported_partition_features]
      : [];
    if (row.relation_kind === "p" && row.is_partition === true) {
      features.push("subpartitioning");
    }
    if (row.relation_kind === "f" && row.is_partition === true) {
      features.push("foreign-table partition");
    }
    if (Array.isArray(row.relation_options) && row.relation_options.length > 0) {
      features.push("storage parameters");
    }
    if (row.relation_tablespace) {
      features.push(`tablespace ${row.relation_tablespace}`);
    }
    if (
      row.relation_access_method &&
      (row.relation_kind === "p" || row.relation_access_method !== "heap")
    ) {
      features.push(`access method ${row.relation_access_method}`);
    }
    const uniqueFeatures = [...new Set(features)];
    if (uniqueFeatures.length === 0) {
      continue;
    }

    throw new ValidationError(
      `Unsupported PostgreSQL partition relation ${identity} is present in a managed schema: ${uniqueFeatures.join(", ")}. TerraDB cannot inspect this partition relation losslessly; replace it with a basic partitioned parent and direct leaf, or manage the hierarchy outside TerraDB before planning`,
      `relation ${identity}`,
      "definition",
      uniqueFeatures
    );
  }
}

export class DatabaseInspector {
  async getCurrentSchema(client: Client, schemas: string[] = ['public']): Promise<Table[]> {
    const tables: Table[] = [];

    // Get all tables from specified schemas (excluding extension-owned tables)
    const tablesResult = await client.query(`
      SELECT
        t.table_name,
        t.table_schema,
        c.relpersistence,
        c.reloptions as table_storage_options,
        toast_relation.reloptions as toast_storage_options,
        table_access_method.amname as table_access_method,
        table_tablespace.spcname as table_tablespace_name,
        inheritance.parents as inheritance_parents,
        c.relreplident as replica_identity_mode,
        replica_identity_index.index_name as replica_identity_index_name,
        cluster_index.index_name as cluster_index_name,
        unsupported_constraint.items as unsupported_constraints
      FROM information_schema.tables t
      JOIN pg_class c ON c.relname = t.table_name
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = t.table_schema
      LEFT JOIN pg_class toast_relation ON toast_relation.oid = c.reltoastrelid
      JOIN pg_am table_access_method ON table_access_method.oid = c.relam
      LEFT JOIN pg_tablespace table_tablespace ON table_tablespace.oid = c.reltablespace
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'name', parent.relname,
            'schema', parent_namespace.nspname
          )
          ORDER BY inherited.inhseqno
        ) as parents
        FROM pg_inherits inherited
        JOIN pg_class parent ON parent.oid = inherited.inhparent
        JOIN pg_namespace parent_namespace
          ON parent_namespace.oid = parent.relnamespace
        WHERE inherited.inhrelid = c.oid
      ) inheritance ON true
      LEFT JOIN LATERAL (
        SELECT index_relation.relname AS index_name
        FROM pg_index index_catalog
        JOIN pg_class index_relation
          ON index_relation.oid = index_catalog.indexrelid
        WHERE index_catalog.indrelid = c.oid
          AND index_catalog.indisreplident
        ORDER BY index_relation.relname
        LIMIT 1
      ) replica_identity_index ON true
      LEFT JOIN LATERAL (
        SELECT index_relation.relname AS index_name
        FROM pg_index index_catalog
        JOIN pg_class index_relation
          ON index_relation.oid = index_catalog.indexrelid
        WHERE index_catalog.indrelid = c.oid
          AND index_catalog.indisclustered
        ORDER BY index_relation.relname
        LIMIT 1
      ) cluster_index ON true
      ${UNSUPPORTED_CONSTRAINT_JOIN_SQL}
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE t.table_schema = ANY($1::text[])
        AND t.table_type = 'BASE TABLE'
        AND c.relkind = 'r'
        AND NOT c.relispartition
        AND d.objid IS NULL
      ORDER BY t.table_schema, t.table_name
    `, [schemas]);

    assertConstraintRowsAreSupported(tablesResult.rows);

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      const tableSchema = row.table_schema;
      const inherits = this.parseInheritanceParents(row.inheritance_parents);

      // Get columns for each table
      const columnsResult = await client.query(
        `
        SELECT
          a.attname as column_name,
          format_type(a.atttypid, a.atttypmod) as data_type,
          format_type(a.atttypid, a.atttypmod) as pg_type,
          column_type_namespace.nspname as column_type_schema,
          CASE
            WHEN a.atttypmod > 0 AND format_type(a.atttypid, a.atttypmod) LIKE '%(%'
            THEN substring(format_type(a.atttypid, a.atttypmod) FROM '\\((\\d+)')::int
            ELSE NULL
          END as character_maximum_length,
          NOT a.attnotnull as is_nullable,
          pg_get_expr(ad.adbin, ad.adrelid) as column_default,
          a.attgenerated,
          a.attidentity,
          COALESCE(serial_sequence.is_serial, FALSE) as is_serial,
          serial_sequence.options_match as serial_sequence_options_match,
          CASE
            WHEN a.attgenerated != '' THEN pg_get_expr(ad.adbin, ad.adrelid)
            ELSE NULL
          END as generation_expression,
          identity_sequence.sequence_schema as identity_sequence_schema,
          identity_sequence.sequence_name as identity_sequence_name,
          identity_sequence.sequence_persistence as identity_sequence_persistence,
          identity_sequence.seqstart as identity_start,
          identity_sequence.seqincrement as identity_increment,
          identity_sequence.seqmin as identity_min_value,
          identity_sequence.seqmax as identity_max_value,
          identity_sequence.seqcache as identity_cache,
          identity_sequence.seqcycle as identity_cycle,
          column_collation_namespace.nspname as column_collation_schema,
          column_collation.collname as column_collation_name,
          CASE
            WHEN a.attstorage <> column_type.typstorage THEN a.attstorage
            ELSE NULL
          END as column_storage,
          column_type.typstorage as column_default_storage,
          a.attcompression as column_compression,
          a.attstattarget as column_statistics_target,
          a.attoptions as column_attribute_options,
          a.attinhcount as inheritance_count
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        JOIN pg_class cls ON cls.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        ${IDENTITY_SEQUENCE_JOIN_SQL}
        ${SERIAL_SEQUENCE_JOIN_SQL}
        ${COLUMN_COLLATION_JOIN_SQL}
        WHERE cls.relname = $1 AND n.nspname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
        [tableName, tableSchema]
      );

      const inspectedColumns = columnsResult.rows.map((col: any) => {
        const type = this.qualifySerialNamedCustomType(
          col.pg_type,
          col.column_type_schema,
          Boolean(col.is_serial)
        );
        const typeSchema = this.getUnqualifiedCatalogTypeSchema(
          type,
          col.column_type_schema
        );

        // Parse generated column info
        let generated: Column['generated'] | undefined = undefined;
        const identity = this.buildIdentityColumn(col);
        const collation = this.buildColumnCollation(col);
        const storage = columnStorageFromCatalog(col.column_storage);
        const storageDefault = columnStorageFromCatalog(
          col.column_default_storage
        );
        const compression = columnCompressionFromCatalog(
          col.column_compression
        );
        let defaultValue = col.column_default;

        if (col.attgenerated && col.attgenerated !== '') {
          const stored = col.attgenerated === 's';
          const expression = col.generation_expression || '';

          generated = {
            always: true,
            expression,
            stored,
          };

          // Generated columns don't have defaults in the traditional sense
          defaultValue = undefined;
        }

        if (identity) {
          defaultValue = undefined;
        }

        return {
          column: {
            name: col.column_name,
            type: type,
            ...(typeSchema ? { typeSchema } : {}),
            nullable: col.is_nullable,
            default: defaultValue,
            serial: col.is_serial || undefined,
            serialSequenceOptionsMatch: col.is_serial
              ? Boolean(col.serial_sequence_options_match)
              : undefined,
            collation,
            storage,
            storageDefault,
            compression,
            identity,
            generated,
          } satisfies Column,
          isLocal: Number(col.inheritance_count || 0) === 0,
        };
      });
      const columns = inspectedColumns
        .filter(function filterLocal(item) {
          return item.isLocal;
        })
        .map(function getColumn(item) {
          return item.column;
        });
      const inheritedColumns = inspectedColumns
        .filter(function filterInherited(item) {
          return !item.isLocal;
        })
        .map(function getColumn(item) {
          return item.column;
        });
      const columnStatistics = this.parsePostgresColumnStatisticsRows(
        columnsResult.rows,
        `${tableSchema}.${tableName}`
      );

      // Get primary key constraint for this table
      const primaryKey = await this.getPrimaryKeyConstraint(client, tableName, tableSchema);

      // Get foreign key constraints for this table
      const foreignKeys = await this.getForeignKeyConstraints(client, tableName, tableSchema);

      // Get check constraints for this table
      const checkConstraints = await this.getCheckConstraints(client, tableName, tableSchema);
      const inheritedCheckConstraints = inherits
        ? await this.getInheritedCheckConstraints(client, tableName, tableSchema)
        : [];

      // Get unique constraints for this table
      const uniqueConstraints = await this.getUniqueConstraints(client, tableName, tableSchema);

      // Get exclusion constraints and their supporting-index properties
      const exclusionConstraints = await this.getExclusionConstraints(
        client,
        tableName,
        tableSchema
      );

      // Get indexes for this table
      const indexes = await this.getTableIndexes(client, tableName, tableSchema);
      const replicaIdentity = getPostgresReplicaIdentity(
        row.replica_identity_mode,
        row.replica_identity_index_name,
        `table ${tableSchema}.${tableName}`
      );

      tables.push({
        name: tableName,
        schema: tableSchema,
        columns,
        inherits,
        inheritedColumns:
          inheritedColumns.length > 0 ? inheritedColumns : undefined,
        inheritedCheckConstraints:
          inheritedCheckConstraints.length > 0
            ? inheritedCheckConstraints
            : undefined,
        unlogged: row.relpersistence === "u" ? true : undefined,
        storageParameters: this.parseTableStorageOptions(row),
        accessMethod: row.table_access_method,
        tablespace: row.table_tablespace_name || undefined,
        primaryKey,
        foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
        checkConstraints: checkConstraints.length > 0 ? checkConstraints : undefined,
        uniqueConstraints: uniqueConstraints.length > 0 ? uniqueConstraints : undefined,
        exclusionConstraints:
          exclusionConstraints.length > 0 ? exclusionConstraints : undefined,
        indexes,
        ...(replicaIdentity ? { replicaIdentity } : {}),
        ...(typeof row.cluster_index_name === "string"
          ? { clusterIndex: row.cluster_index_name }
          : {}),
        ...(columnStatistics.length > 0 ? { columnStatistics } : {}),
      });
    }

    return tables;
  }

  private async getPrimaryKeyConstraint(
    client: Client,
    tableName: string,
    tableSchema: string
  ): Promise<PrimaryKeyConstraint | undefined> {
    const result = await client.query(
      `
      SELECT
        constraint_catalog.conname AS constraint_name,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_catalog.conkey) WITH ORDINALITY
            AS key_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_catalog.conrelid
            AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) AS columns,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(index_catalog.indkey) WITH ORDINALITY
            AS included_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = index_catalog.indrelid
            AND attribute.attnum = included_column.attnum
          WHERE included_column.position > index_catalog.indnkeyatts
          ORDER BY included_column.position
        ) AS included_columns,
        index_relation.reloptions AS storage_options,
        tablespace.spcname AS tablespace_name,
        constraint_catalog.condeferrable AS deferrable,
        constraint_catalog.condeferred AS initially_deferred
      FROM pg_constraint constraint_catalog
      JOIN pg_class table_relation
        ON table_relation.oid = constraint_catalog.conrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      JOIN pg_index index_catalog
        ON index_catalog.indexrelid = constraint_catalog.conindid
      JOIN pg_class index_relation
        ON index_relation.oid = constraint_catalog.conindid
      LEFT JOIN pg_tablespace tablespace
        ON tablespace.oid = index_relation.reltablespace
      WHERE constraint_catalog.contype = 'p'
        AND table_relation.relname = $1
        AND table_namespace.nspname = $2
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    const row = result.rows[0];

    return {
      name: row.constraint_name,
      columns: row.columns || [],
      ...(row.included_columns?.length > 0
        ? { include: row.included_columns }
        : {}),
      ...(row.storage_options
        ? { storageParameters: this.parseStorageOptions(row.storage_options) }
        : {}),
      ...(row.tablespace_name ? { tablespace: row.tablespace_name } : {}),
      ...(row.deferrable ? { deferrable: true } : {}),
      ...(row.initially_deferred ? { initiallyDeferred: true } : {}),
    };
  }

  async getTableIndexes(client: Client, tableName: string, tableSchema: string): Promise<Index[]> {
    const result = await client.query(
      `
      SELECT
        i.indexname as index_name,
        i.tablename as table_name,
        i.schemaname as table_schema,
        i.indexdef as index_definition,
        ix.indisunique as is_unique,
        COALESCE(
          (to_jsonb(ix) ->> 'indnullsnotdistinct')::boolean,
          false
        ) as nulls_not_distinct,
        am.amname as access_method,
        ix.indnkeyatts as index_key_count,
        -- Extract tablespace information
        ts.spcname as tablespace_name,
        -- Extract storage parameters (reloptions)
        ic.reloptions as storage_options,
        ARRAY(
          SELECT DISTINCT attribute.attname::text
          FROM pg_depend dependency
          JOIN pg_attribute attribute
            ON dependency.refclassid = 'pg_class'::regclass
            AND attribute.attrelid = dependency.refobjid
            AND attribute.attnum = dependency.refobjsubid
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = ix.indexrelid
            AND dependency.refobjid = ix.indrelid
            AND dependency.refobjsubid > 0
            AND dependency.deptype = 'a'
          ORDER BY attribute.attname::text
        ) as dependent_columns,
        CASE
          WHEN ix.indpred IS NOT NULL THEN
            regexp_replace(
              pg_get_expr(ix.indpred, ix.indrelid),
              '^\\((.*)\\)$', '\\1'  -- Remove outer parentheses
            )
          ELSE NULL
        END as where_clause,
        ARRAY(
          SELECT attribute.attstattarget
          FROM pg_attribute attribute
          WHERE attribute.attrelid = ix.indexrelid
            AND attribute.attnum > 0
            AND attribute.attnum <= ix.indnkeyatts
          ORDER BY attribute.attnum
        ) as key_statistics_targets,
        ARRAY(
          SELECT key_column.position::integer
          FROM unnest(ix.indkey) WITH ORDINALITY
            AS key_column(attnum, position)
          WHERE key_column.position <= ix.indnkeyatts
            AND key_column.attnum = 0
          ORDER BY key_column.position
        ) as expression_positions,
        (
          SELECT json_agg(
            json_build_object(
              'name', operator_class.opcname,
              'schema', operator_namespace.nspname,
              'default', operator_class.opcdefault
            )
            ORDER BY operator_key.position
          )
          FROM unnest(ix.indclass) WITH ORDINALITY
            AS operator_key(opclass_oid, position)
          JOIN pg_opclass operator_class
            ON operator_class.oid = operator_key.opclass_oid
          JOIN pg_namespace operator_namespace
            ON operator_namespace.oid = operator_class.opcnamespace
        ) as key_opclasses
      FROM pg_indexes i
      JOIN pg_namespace n ON n.nspname = i.schemaname
      JOIN pg_class c ON c.relname = i.tablename AND c.relnamespace = n.oid
      JOIN pg_class ic ON ic.relname = i.indexname AND ic.relnamespace = n.oid
      JOIN pg_index ix ON ix.indexrelid = ic.oid
      JOIN pg_am am ON am.oid = ic.relam
      LEFT JOIN pg_tablespace ts ON ts.oid = ic.reltablespace
      WHERE i.tablename = $1
        AND i.schemaname = $2
        AND NOT ix.indisprimary  -- Exclude primary key indexes
        -- Exclude constraint-owned indexes - these are handled as constraints
        -- This ensures proper distinction: constraints use ALTER TABLE ADD CONSTRAINT,
        -- while indexes use CREATE INDEX CONCURRENTLY for production safety
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con
          WHERE con.conindid = ix.indexrelid
          AND con.contype IN ('u', 'x')
        )
      ORDER BY i.indexname
      `,
      [tableName, tableSchema]
    );

    const indexes: Index[] = [];
    for (const row of result.rows) {
      const parsed = await this.parseIndexDefinition(row.index_definition);
      this.enrichIndexTermsFromCatalog(parsed.terms || [], row);
      if (parsed.terms?.length === 1 && parsed.terms[0]?.expression) {
        parsed.expressionStatisticsTarget = parsed.terms[0].statisticsTarget;
      }
      indexes.push({
        ...parsed,
        name: row.index_name,
        tableName: row.table_name,
        schema: row.table_schema,
        type: this.mapPostgreSQLIndexType(row.access_method),
        unique: row.is_unique,
        ...(row.nulls_not_distinct ? { nullsNotDistinct: true } : {}),
        concurrent: false,
        where: row.where_clause || undefined,
        ...(row.dependent_columns?.length > 0
          ? { dependentColumns: row.dependent_columns }
          : {}),
        storageParameters: this.parseStorageOptions(row.storage_options),
        tablespace: row.tablespace_name || undefined,
      });
    }
    return indexes;
  }

  private enrichIndexTermsFromCatalog(terms: IndexTerm[], row: any): void {
    const identity = `${row.table_schema}.${row.index_name}`;
    const keyCount = Number(row.index_key_count);
    if (terms.length !== keyCount) {
      throw new ValidationError(
        `PostgreSQL reconstructed ${terms.length} keys for ${identity}, but its catalog reports ${keyCount}`,
        `index ${identity}`,
        "terms",
        terms
      );
    }

    const opclasses: Array<{
      name?: string;
      schema?: string;
      default?: boolean;
    }> = row.key_opclasses || [];
    if (opclasses.length !== keyCount) {
      throw new ValidationError(
        `PostgreSQL returned incomplete operator-class metadata for ${identity}`,
        `index ${identity}`,
        "terms",
        opclasses
      );
    }
    for (let position = 0; position < terms.length; position++) {
      const term = terms[position]!;
      const opclass = opclasses[position];
      if (!opclass?.name) {
        throw new ValidationError(
          `PostgreSQL returned an invalid operator class for ${identity} position ${position + 1}`,
          `index ${identity}`,
          "terms",
          opclass
        );
      }
      if (!term.opclass) {
        term.opclass = opclass.schema
          ? { name: opclass.name, schema: opclass.schema }
          : { name: opclass.name };
      }
      term.opclassDefault = Boolean(opclass.default);
    }

    const targets: Array<number | undefined> = (
      row.key_statistics_targets || []
    ).map(
      function parseTarget(target: unknown, position: number) {
        return postgresStatisticsTargetFromCatalog(
          target,
          `${identity} expression position ${position + 1}`
        );
      }
    );
    if (targets.length !== keyCount) {
      throw new ValidationError(
        `PostgreSQL returned incomplete statistics metadata for ${identity}`,
        `index ${identity}`,
        "terms",
        targets
      );
    }
    const expressionPositions: number[] = (
      row.expression_positions || []
    ).map(Number);
    const parsedExpressionPositions = terms.flatMap(function getPosition(
      term,
      position
    ) {
      return term.expression === undefined ? [] : [position + 1];
    });
    if (
      expressionPositions.length !== parsedExpressionPositions.length ||
      expressionPositions.some(function hasDifferentPosition(position, index) {
        return parsedExpressionPositions[index] !== position;
      })
    ) {
      throw new ValidationError(
        `PostgreSQL reconstructed expression positions for ${identity} that do not match its catalog`,
        `index ${identity}`,
        "terms",
        expressionPositions
      );
    }
    for (let position = 0; position < targets.length; position++) {
      const target = targets[position];
      if (target === undefined) {
        continue;
      }
      const term = terms[position];
      if (!term?.expression) {
        throw new ValidationError(
          `PostgreSQL statistics target on ${identity} position ${position + 1} does not belong to an expression key`,
          `index ${identity}`,
          "terms",
          target
        );
      }
      term.statisticsTarget = target;
    }
  }

  private async parseIndexDefinition(
    indexDefinition: string | undefined
  ): Promise<Index> {
    if (!indexDefinition) {
      throw new Error("PostgreSQL returned an index without a definition");
    }

    const ast = await parse(indexDefinition);
    const statement = toPgAstNode(ast.stmts?.[0]?.stmt);
    const parsed = statement?.IndexStmt
      ? parseCreateIndex(statement.IndexStmt)
      : undefined;
    if (!parsed) {
      throw new Error(
        `PostgreSQL returned an invalid index definition: ${indexDefinition}`
      );
    }
    return parsed;
  }

  private parsePostgresColumnStatisticsRows(
    rows: any[],
    relationIdentity: string
  ): PostgresColumnStatistics[] {
    return rows
      .flatMap(function parseStatistics(row: any) {
        const statistics = postgresColumnStatisticsFromCatalog(
          row.column_name,
          row.column_statistics_target,
          row.column_attribute_options,
          relationIdentity
        );
        return statistics ? [statistics] : [];
      })
      .sort(function compareStatistics(first, second) {
        return first.column.localeCompare(second.column);
      });
  }

  private async getPostgresColumnStatistics(
    client: Client,
    relationName: string,
    schemaName: string
  ): Promise<PostgresColumnStatistics[]> {
    const result = await client.query(
      `
        SELECT
          attribute.attname as column_name,
          attribute.attstattarget as column_statistics_target,
          attribute.attoptions as column_attribute_options
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relname = $1
          AND namespace.nspname = $2
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      `,
      [relationName, schemaName]
    );
    return this.parsePostgresColumnStatisticsRows(
      result.rows,
      `${schemaName}.${relationName}`
    );
  }

  private parseStorageOptions(
    reloptions: string[] | null
  ): Record<string, string> | undefined {
    if (!reloptions || !Array.isArray(reloptions) || reloptions.length === 0) {
      return undefined;
    }

    const parameters: Record<string, string> = {};

    for (const option of reloptions) {
      // PostgreSQL storage options are stored as "key=value" strings
      const match = option.match(/^([^=]+)=(.*)$/);
      if (match && match.length >= 3 && match[1] && match[2] !== undefined) {
        const key = match[1];
        const value = match[2];
        parameters[key] = value.replace(/^'(.*)'$/, '$1');
      }
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }

  private parseTableStorageOptions(
    row: any
  ): Record<string, string> | undefined {
    const tableOptions = this.parseStorageOptions(row.table_storage_options);
    const toastOptions = this.parseStorageOptions(row.toast_storage_options);
    const parameters: Record<string, string> = { ...(tableOptions || {}) };

    for (const [name, value] of Object.entries(toastOptions || {})) {
      parameters[`toast.${name}`] = value;
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }

  private parseInheritanceParents(
    parents: Array<{ name?: string; schema?: string }> | null
  ): Table["inherits"] {
    if (!Array.isArray(parents)) {
      return undefined;
    }

    const parsed = parents
      .filter(function hasName(parent) {
        return Boolean(parent?.name);
      })
      .map(function mapParent(parent) {
        return {
          name: parent.name!,
          schema: parent.schema || undefined,
        };
      });
    return parsed.length > 0 ? parsed : undefined;
  }

  private mapPostgreSQLIndexType(accessMethod: string): Index["type"] {
    switch (accessMethod.toLowerCase()) {
      case "btree":
        return "btree";
      case "hash":
        return "hash";
      case "gin":
        return "gin";
      case "gist":
        return "gist";
      case "spgist":
        return "spgist";
      case "brin":
        return "brin";
      default:
        return accessMethod.toLowerCase() as Index["type"];
    }
  }

  async getForeignKeyConstraints(client: Client, tableName: string, tableSchema: string): Promise<ForeignKeyConstraint[]> {
    const result = await client.query(
      `
      SELECT
        c.conname AS constraint_name,
        (SELECT array_agg(a.attname ORDER BY ord.n)
         FROM unnest(c.conkey) WITH ORDINALITY AS ord(col, n)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.col
        ) AS columns,
        ref_ns.nspname AS referenced_schema,
        ref_cl.relname AS referenced_table,
        (SELECT array_agg(a.attname ORDER BY ord.n)
         FROM unnest(c.confkey) WITH ORDINALITY AS ord(col, n)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ord.col
        ) AS referenced_columns,
        ARRAY(
          SELECT attribute.attname::text
          FROM jsonb_array_elements_text(
            COALESCE(
              NULLIF(to_jsonb(c) -> 'confdelsetcols', 'null'::jsonb),
              '[]'::jsonb
            )
          ) WITH ORDINALITY AS delete_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = c.conrelid
            AND attribute.attnum = delete_column.attnum::smallint
          ORDER BY delete_column.position
        ) AS delete_set_columns,
        c.confdeltype AS delete_rule,
        c.confupdtype AS update_rule,
        c.confmatchtype AS match_type,
        c.condeferrable AS deferrable,
        c.condeferred AS initially_deferred,
        c.convalidated AS validated
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class ref_cl ON ref_cl.oid = c.confrelid
      JOIN pg_namespace ref_ns ON ref_ns.oid = ref_cl.relnamespace
      WHERE c.contype = 'f'
        AND cl.relname = $1
        AND ns.nspname = $2
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const actionMap: Record<string, 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION'> = {
      'a': 'NO ACTION',
      'r': 'RESTRICT',
      'c': 'CASCADE',
      'n': 'SET NULL',
      'd': 'SET DEFAULT',
    };

    const parseArrayLiteral = (val: string | string[]): string[] => {
      if (Array.isArray(val)) return val;
      if (!val || val === '{}') return [];
      return val.slice(1, -1).split(',');
    };

    return result.rows.map(row => ({
      name: row.constraint_name,
      columns: parseArrayLiteral(row.columns),
      referencedTable: row.referenced_schema === 'public'
        ? row.referenced_table
        : `${row.referenced_schema}.${row.referenced_table}`,
      referencedColumns: parseArrayLiteral(row.referenced_columns),
      ...(row.match_type === "f" ? { matchType: "FULL" as const } : {}),
      onDelete: actionMap[row.delete_rule],
      ...(row.delete_set_columns?.length > 0
        ? { onDeleteColumns: row.delete_set_columns }
        : {}),
      onUpdate: actionMap[row.update_rule],
      ...(row.deferrable ? { deferrable: true } : {}),
      ...(row.initially_deferred ? { initiallyDeferred: true } : {}),
      ...(row.validated === false ? { notValid: true } : {}),
    }));
  }

  async getCheckConstraints(client: Client, tableName: string, tableSchema: string): Promise<CheckConstraint[]> {
    const result = await client.query(
      `
      SELECT
        conname as constraint_name,
        pg_get_expr(c.conbin, c.conrelid) as expression,
        c.connoinherit as no_inherit,
        c.convalidated as validated
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE t.relname = $1
        AND n.nspname = $2
        AND c.contype = 'c'
        AND c.coninhcount = 0
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    return this.parseCheckConstraintRows(result.rows);
  }

  private async getInheritedCheckConstraints(
    client: Client,
    tableName: string,
    tableSchema: string
  ): Promise<CheckConstraint[]> {
    const result = await client.query(
      `
      SELECT
        conname as constraint_name,
        pg_get_expr(c.conbin, c.conrelid) as expression,
        c.connoinherit as no_inherit,
        c.convalidated as validated
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE t.relname = $1
        AND n.nspname = $2
        AND c.contype = 'c'
        AND c.coninhcount > 0
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    return this.parseCheckConstraintRows(result.rows);
  }

  private parseCheckConstraintRows(rows: any[]): CheckConstraint[] {
    const constraints: CheckConstraint[] = [];
    for (const row of rows) {
      if (row.expression) {
        constraints.push({
          name: row.constraint_name,
          expression: row.expression,
          ...(row.no_inherit === true ? { noInherit: true } : {}),
          ...(row.validated === false ? { notValid: true } : {}),
        });
      }
    }
    return constraints;
  }

  async getUniqueConstraints(client: Client, tableName: string, tableSchema: string): Promise<UniqueConstraint[]> {
    const result = await client.query(
      `
      SELECT
        c.conname AS constraint_name,
        (
          SELECT array_agg(a.attname ORDER BY ord.n)
          FROM unnest(c.conkey) WITH ORDINALITY AS ord(col, n)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.col
        ) AS columns,
        COALESCE(
          (to_jsonb(index_catalog) ->> 'indnullsnotdistinct')::boolean,
          false
        ) AS nulls_not_distinct,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(index_catalog.indkey) WITH ORDINALITY
            AS included_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = index_catalog.indrelid
            AND attribute.attnum = included_column.attnum
          WHERE included_column.position > index_catalog.indnkeyatts
          ORDER BY included_column.position
        ) AS included_columns,
        index_relation.reloptions AS storage_options,
        tablespace.spcname AS tablespace_name,
        c.condeferrable AS deferrable,
        c.condeferred AS initially_deferred
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_index index_catalog ON index_catalog.indexrelid = c.conindid
      JOIN pg_class index_relation ON index_relation.oid = c.conindid
      LEFT JOIN pg_tablespace tablespace
        ON tablespace.oid = index_relation.reltablespace
      WHERE c.contype = 'u'
        AND cl.relname = $1
        AND ns.nspname = $2
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const parseArrayLiteral = (val: string | string[]): string[] => {
      if (Array.isArray(val)) return val;
      if (!val || val === '{}') return [];
      return val.slice(1, -1).split(',');
    };

    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: parseArrayLiteral(row.columns),
      ...(row.included_columns?.length > 0
        ? { include: row.included_columns }
        : {}),
      ...(row.storage_options
        ? { storageParameters: this.parseStorageOptions(row.storage_options) }
        : {}),
      ...(row.tablespace_name ? { tablespace: row.tablespace_name } : {}),
      ...(row.nulls_not_distinct ? { nullsNotDistinct: true } : {}),
      ...(row.deferrable ? { deferrable: true } : {}),
      ...(row.initially_deferred ? { initiallyDeferred: true } : {}),
    }));
  }

  async getExclusionConstraints(
    client: Client,
    tableName: string,
    tableSchema: string
  ): Promise<ExclusionConstraint[]> {
    const result = await client.query(
      `
      SELECT
        c.conname AS constraint_name,
        c.condeferrable AS deferrable,
        c.condeferred AS initially_deferred,
        am.amname AS access_method,
        ic.reloptions AS storage_options,
        tablespace.spcname AS tablespace_name,
        pg_get_expr(ix.indpred, ix.indrelid) AS where_clause,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(ix.indkey) WITH ORDINALITY AS key_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = ix.indrelid
            AND attribute.attnum = key_column.attnum
          WHERE key_column.position > ix.indnkeyatts
          ORDER BY key_column.position
        ) AS included_columns,
        exclusion.elements
      FROM pg_constraint c
      JOIN pg_class table_relation ON table_relation.oid = c.conrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      JOIN pg_class ic ON ic.oid = c.conindid
      JOIN pg_index ix ON ix.indexrelid = c.conindid
      JOIN pg_am am ON am.oid = ic.relam
      LEFT JOIN pg_tablespace tablespace ON tablespace.oid = ic.reltablespace
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'definition', pg_get_indexdef(c.conindid, operator_element.position::int, true),
            'operator_name', operator_relation.oprname,
            'operator_schema', operator_namespace.nspname
          )
          ORDER BY operator_element.position
        ) AS elements
        FROM unnest(c.conexclop) WITH ORDINALITY
          AS operator_element(operator_oid, position)
        JOIN pg_operator operator_relation
          ON operator_relation.oid = operator_element.operator_oid
        JOIN pg_namespace operator_namespace
          ON operator_namespace.oid = operator_relation.oprnamespace
      ) exclusion ON true
      WHERE c.contype = 'x'
        AND table_relation.relname = $1
        AND table_namespace.nspname = $2
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    return result.rows.map((row: any) => ({
      name: row.constraint_name,
      method: row.access_method,
      elements: (row.elements || []).map(function mapElement(element: any) {
        const operatorSchema =
          element.operator_schema === "pg_catalog"
            ? undefined
            : element.operator_schema;
        return {
          definition: element.definition,
          operator: {
            name: element.operator_name,
            ...(operatorSchema ? { schema: operatorSchema } : {}),
          },
        };
      }),
      include:
        row.included_columns?.length > 0 ? row.included_columns : undefined,
      storageParameters: this.parseStorageOptions(row.storage_options),
      ...(row.tablespace_name ? { tablespace: row.tablespace_name } : {}),
      where: row.where_clause || undefined,
      ...(row.deferrable ? { deferrable: true } : {}),
      ...(row.initially_deferred ? { initiallyDeferred: true } : {}),
    }));
  }

  async getCurrentEnums(client: Client, schemas: string[] = ['public']): Promise<EnumType[]> {
    const enumsResult = await client.query(`
      SELECT
        t.typname as enum_name,
        n.nspname as schema_name,
        e.enumlabel as enum_value,
        e.enumsortorder
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      LEFT JOIN pg_enum e ON t.oid = e.enumtypid
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'e'
        AND d.objid IS NULL  -- Exclude extension-owned types
      ORDER BY n.nspname, t.typname, e.enumsortorder
    `, [schemas]);

    const dependencyResult = await client.query(`
      SELECT
        t.typname as enum_name,
        n.nspname as schema_name,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'schema', relation_namespace.nspname,
              'relation', relation.relname,
              'attribute', attribute.attname,
              'relationKind', relation.relkind
            )
            ORDER BY relation_namespace.nspname, relation.relname, attribute.attnum
          )
          FROM pg_depend dependency
          JOIN pg_class relation
            ON dependency.classid = 'pg_class'::regclass
            AND relation.oid = dependency.objid
          JOIN pg_namespace relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          JOIN pg_attribute attribute
            ON attribute.attrelid = relation.oid
            AND attribute.attnum = dependency.objsubid
          WHERE dependency.refclassid = 'pg_type'::regclass
            AND dependency.refobjid IN (t.oid, t.typarray)
            AND dependency.deptype = 'n'
            AND NOT attribute.attisdropped
        ), '[]'::jsonb) as attribute_dependents,
        COALESCE((
          SELECT jsonb_agg(
            type_dependency
            ORDER BY type_dependency->>'schema', type_dependency->>'name'
          )
          FROM (
            SELECT jsonb_build_object(
              'schema', dependent_namespace.nspname,
              'name', dependent_type.typname,
              'kind', 'domain'
            ) as type_dependency
            FROM pg_type dependent_type
            JOIN pg_namespace dependent_namespace
              ON dependent_namespace.oid = dependent_type.typnamespace
            WHERE dependent_type.typtype = 'd'
              AND dependent_type.typbasetype IN (t.oid, t.typarray)

            UNION ALL

            SELECT jsonb_build_object(
              'schema', dependent_namespace.nspname,
              'name', dependent_type.typname,
              'kind', 'range'
            ) as type_dependency
            FROM pg_range dependent_range
            JOIN pg_type dependent_type
              ON dependent_type.oid = dependent_range.rngtypid
            JOIN pg_namespace dependent_namespace
              ON dependent_namespace.oid = dependent_type.typnamespace
            WHERE dependent_range.rngsubtype IN (t.oid, t.typarray)
          ) dependencies
        ), '[]'::jsonb) as type_dependents,
        ${getPostgresTypeRoutineDependentsSql("t.oid, t.typarray")} as routine_dependents,
        ${getPostgresTypeCatalogDependentsSql("t.oid, t.typarray")} as catalog_dependents
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      LEFT JOIN pg_depend extension_dependency
        ON extension_dependency.objid = t.oid
        AND extension_dependency.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'e'
        AND extension_dependency.objid IS NULL
      ORDER BY n.nspname, t.typname
    `, [schemas]);

    const enumGroups = new Map<string, EnumType>();

    for (const row of enumsResult.rows) {
      const enumName = row.enum_name;
      const schemaName = row.schema_name;
      const enumValue = row.enum_value;
      const enumKey = `${schemaName}.${enumName}`;

      if (!enumGroups.has(enumKey)) {
        enumGroups.set(enumKey, { name: enumName, schema: schemaName, values: [] });
      }
      if (typeof enumValue === "string") {
        enumGroups.get(enumKey)!.values.push(enumValue);
      }
    }

    for (const row of dependencyResult.rows) {
      const enumType = enumGroups.get(`${row.schema_name}.${row.enum_name}`);
      if (!enumType) continue;
      if (row.attribute_dependents?.length > 0) {
        enumType.attributeDependents = row.attribute_dependents;
      }
      if (row.type_dependents?.length > 0) {
        enumType.typeDependents = row.type_dependents;
      }
      if (row.routine_dependents?.length > 0) {
        enumType.routineDependents = row.routine_dependents;
      }
      if (row.catalog_dependents?.length > 0) {
        enumType.catalogDependents = row.catalog_dependents;
      }
    }

    return [...enumGroups.values()];
  }

  async getCurrentCompositeTypes(client: Client, schemas: string[] = ['public']): Promise<CompositeType[]> {
    const result = await client.query(`
      SELECT
        t.typname as type_name,
        n.nspname as schema_name,
        a.attname as attribute_name,
        format_type(a.atttypid, a.atttypmod) as attribute_type,
        attribute_type_namespace.nspname as attribute_type_schema,
        attribute_collation.collname as attribute_collation_name,
        attribute_collation_namespace.nspname as attribute_collation_schema,
        a.attnum
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      JOIN pg_class c ON c.oid = t.typrelid
      LEFT JOIN pg_attribute a
        ON a.attrelid = c.oid
        AND a.attnum > 0
        AND NOT a.attisdropped
      LEFT JOIN pg_type attribute_type ON attribute_type.oid = a.atttypid
      LEFT JOIN pg_namespace attribute_type_namespace
        ON attribute_type_namespace.oid = attribute_type.typnamespace
      LEFT JOIN pg_collation attribute_collation
        ON attribute_collation.oid = a.attcollation
        AND a.attcollation <> attribute_type.typcollation
      LEFT JOIN pg_namespace attribute_collation_namespace
        ON attribute_collation_namespace.oid = attribute_collation.collnamespace
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'c'
        AND c.relkind = 'c'
        AND d.objid IS NULL
      ORDER BY n.nspname, t.typname, a.attnum
    `, [schemas]);

    const groups = new Map<string, CompositeType>();

    for (const row of result.rows) {
      const key = `${row.schema_name}.${row.type_name}`;
      const current = groups.get(key);
      const attributeType = row.attribute_name
        ? this.qualifySerialNamedCustomType(
            row.attribute_type,
            row.attribute_type_schema,
            false
          )
        : undefined;
      const attributeTypeSchema = attributeType
        ? this.getUnqualifiedCatalogTypeSchema(
            attributeType,
            row.attribute_type_schema
          )
        : undefined;
      const attribute = row.attribute_name
        ? {
            name: row.attribute_name,
            type: attributeType!,
            ...(attributeTypeSchema
              ? { typeSchema: attributeTypeSchema }
              : {}),
            ...(row.attribute_collation_name
              ? {
                  collation: {
                    name: row.attribute_collation_name,
                    schema: row.attribute_collation_schema || undefined,
                  },
                }
              : {}),
          }
        : undefined;

      if (current) {
        if (attribute) {
          current.attributes.push(attribute);
        }
        continue;
      }

      groups.set(key, {
        name: row.type_name,
        schema: row.schema_name,
        attributes: attribute ? [attribute] : [],
      });
    }

    const dependencyResult = await client.query(`
      ${COMPOSITE_TYPE_DEPENDENCY_CTE_SQL}
      SELECT
        target_type.nspname as type_schema,
        target_type.typname as type_name,
        relation_namespace.nspname as relation_schema,
        relation.relname as relation_name,
        attribute.attname as attribute_name,
        relation.relkind as relation_kind
      FROM target_types target_type
      JOIN dependent_types dependent_type
        ON dependent_type.target_type_oid = target_type.oid
      JOIN pg_attribute attribute
        ON attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.atttypid = dependent_type.dependent_type_oid
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace relation_namespace
        ON relation_namespace.oid = relation.relnamespace
      WHERE relation.oid <> target_type.typrelid
      ORDER BY
        target_type.nspname,
        target_type.typname,
        relation_namespace.nspname,
        relation.relname,
        attribute.attnum
    `, [schemas]);

    for (const row of dependencyResult.rows) {
      const compositeType = groups.get(`${row.type_schema}.${row.type_name}`);
      if (!compositeType) continue;
      if (!compositeType.attributeDependents) {
        compositeType.attributeDependents = [];
      }
      compositeType.attributeDependents.push({
        schema: row.relation_schema,
        relation: row.relation_name,
        attribute: row.attribute_name,
        relationKind: row.relation_kind,
      });
    }

    const typeDependencyResult = await client.query(`
      ${COMPOSITE_TYPE_DEPENDENCY_CTE_SQL}
      SELECT DISTINCT
        target_type.nspname as type_schema,
        target_type.typname as type_name,
        dependent_namespace.nspname as dependent_schema,
        dependent_type.typname as dependent_name,
        CASE dependent_type.typtype
          WHEN 'd' THEN 'domain'
          WHEN 'r' THEN 'range'
        END as dependent_kind
      FROM target_types target_type
      JOIN dependent_types dependency
        ON dependency.target_type_oid = target_type.oid
      JOIN pg_type dependent_type
        ON dependent_type.oid = dependency.dependent_type_oid
      JOIN pg_namespace dependent_namespace
        ON dependent_namespace.oid = dependent_type.typnamespace
      WHERE dependent_type.typtype IN ('d', 'r')
      ORDER BY
        target_type.nspname,
        target_type.typname,
        dependent_namespace.nspname,
        dependent_type.typname
    `, [schemas]);

    for (const row of typeDependencyResult.rows) {
      const compositeType = groups.get(`${row.type_schema}.${row.type_name}`);
      if (!compositeType) continue;
      if (!compositeType.typeDependents) {
        compositeType.typeDependents = [];
      }
      compositeType.typeDependents.push({
        schema: row.dependent_schema,
        name: row.dependent_name,
        kind: row.dependent_kind,
      });
    }

    const catalogDependencyResult = await client.query(`
      SELECT
        t.typname as type_name,
        n.nspname as schema_name,
        ${getPostgresTypeRoutineDependentsSql("t.oid, t.typarray")} as routine_dependents,
        ${getPostgresTypeCatalogDependentsSql("t.oid, t.typarray")} as catalog_dependents
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_class relation ON relation.oid = t.typrelid
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'c'
        AND relation.relkind = 'c'
      ORDER BY n.nspname, t.typname
    `, [schemas]);

    for (const row of catalogDependencyResult.rows) {
      const compositeType = groups.get(`${row.schema_name}.${row.type_name}`);
      if (!compositeType) continue;
      if (row.routine_dependents?.length > 0) {
        compositeType.routineDependents = row.routine_dependents;
      }
      if (row.catalog_dependents?.length > 0) {
        compositeType.catalogDependents = row.catalog_dependents;
      }
    }

    return Array.from(groups.values());
  }

  // Get all views from the database
  async getCurrentViews(client: Client, schemas: string[] = ['public']): Promise<View[]> {
    const views: View[] = [];

    // Get regular views (excluding extension-owned views)
    const viewsResult = await client.query(`
      SELECT
        v.table_name as view_name,
        v.table_schema as schema_name,
        pg_get_viewdef(c.oid, false) as view_definition,
        ARRAY(
          SELECT attribute.attname::text
          FROM pg_attribute attribute
          WHERE attribute.attrelid = c.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
          ORDER BY attribute.attnum
        ) as column_names,
        v.check_option,
        c.reloptions,
        v.is_updatable,
        v.is_insertable_into
      FROM information_schema.views v
      JOIN pg_class c ON c.relname = v.table_name
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = v.table_schema
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE v.table_schema = ANY($1::text[])
        AND d.objid IS NULL  -- Exclude extension-owned views
      ORDER BY v.table_schema, v.table_name
    `, [schemas]);

    for (const row of viewsResult.rows) {
      const view: View = {
        name: row.view_name,
        schema: row.schema_name,
        definition: row.view_definition.trim(),
        materialized: false,
        columnNames: row.column_names,
      };

      // Set check option if present
      if (row.check_option && row.check_option !== 'NONE') {
        view.checkOption = row.check_option as 'CASCADED' | 'LOCAL';
      }

      const securityBarrier = parseBooleanRelationOption(
        row.reloptions,
        "security_barrier"
      );
      if (securityBarrier !== undefined) {
        view.securityBarrier = securityBarrier;
      }
      const securityInvoker = parseBooleanRelationOption(
        row.reloptions,
        "security_invoker"
      );
      if (securityInvoker !== undefined) {
        view.securityInvoker = securityInvoker;
      }

      views.push(view);
    }

    // Get materialized views (excluding extension-owned)
    const matViewsResult = await client.query(`
      SELECT
        m.matviewname as view_name,
        m.schemaname as schema_name,
        m.definition,
        m.ispopulated,
        c.reloptions as table_storage_options,
        toast_relation.reloptions as toast_storage_options,
        am.amname as access_method,
        m.tablespace as tablespace_name,
        cluster_index.index_name as cluster_index_name,
        ARRAY(
          SELECT attribute.attname::text
          FROM pg_attribute attribute
          WHERE attribute.attrelid = c.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
          ORDER BY attribute.attnum
        ) as column_names
      FROM pg_matviews m
      JOIN pg_class c ON c.relname = m.matviewname
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = m.schemaname
      LEFT JOIN pg_class toast_relation ON toast_relation.oid = c.reltoastrelid
      JOIN pg_am am ON am.oid = c.relam
      LEFT JOIN LATERAL (
        SELECT index_relation.relname AS index_name
        FROM pg_index index_catalog
        JOIN pg_class index_relation
          ON index_relation.oid = index_catalog.indexrelid
        WHERE index_catalog.indrelid = c.oid
          AND index_catalog.indisclustered
        ORDER BY index_relation.relname
        LIMIT 1
      ) cluster_index ON true
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE m.schemaname = ANY($1::text[])
        AND d.objid IS NULL  -- Exclude extension-owned materialized views
      ORDER BY m.schemaname, m.matviewname
    `, [schemas]);

    for (const row of matViewsResult.rows) {
      const storageParameters = this.parseTableStorageOptions(row);
      const columnStatistics = await this.getPostgresColumnStatistics(
        client,
        row.view_name,
        row.schema_name
      );
      const view: View = {
        name: row.view_name,
        schema: row.schema_name,
        definition: row.definition.trim(),
        materialized: true,
        columnNames: row.column_names,
        populated: row.ispopulated,
        ...(storageParameters ? { storageParameters } : {}),
        ...(row.access_method ? { accessMethod: row.access_method } : {}),
        ...(row.tablespace_name ? { tablespace: row.tablespace_name } : {}),
        ...(typeof row.cluster_index_name === "string"
          ? { clusterIndex: row.cluster_index_name }
          : {}),
        ...(columnStatistics.length > 0 ? { columnStatistics } : {}),
      };

      const indexes = await this.getTableIndexes(
        client,
        row.view_name,
        row.schema_name
      );
      if (indexes.length > 0) {
        view.indexes = indexes;
      }

      views.push(view);
    }

    return views;
  }

  async getCurrentSqlObjects(client: Client, schemas: string[] = ['public']): Promise<SqlObject[]> {
    const groups = await Promise.all([
      this.getCurrentPartitionObjects(client, schemas),
      this.getCurrentRowSecurityObjects(client, schemas),
      this.getCurrentPolicyObjects(client, schemas),
      this.getCurrentDomainObjects(client, schemas),
      this.getCurrentRangeObjects(client, schemas),
      this.getCurrentForeignServerObjects(client),
      this.getCurrentConstraintTriggerObjects(client, schemas),
      this.getCurrentEventTriggerObjects(client),
      this.getCurrentRoleObjects(client),
      this.getCurrentGrantObjects(client, schemas),
      this.getCurrentDefaultPrivilegeObjects(client),
    ]);

    return groups
      .flat()
      .sort(function sortSqlObjects(a, b) {
        return a.key.localeCompare(b.key);
      });
  }

  // Get complete schema including all database objects
  async getCompleteSchema(client: Client, schemas: string[] = ['public']): Promise<Schema> {
    const [tables, views, enumTypes, compositeTypes, functions, procedures, triggers, sequences, extensions, schemaDefinitions, comments, sqlObjects] = await Promise.all([
      this.getCurrentSchema(client, schemas),
      this.getCurrentViews(client, schemas),
      this.getCurrentEnums(client, schemas),
      this.getCurrentCompositeTypes(client, schemas),
      this.getCurrentFunctions(client, schemas),
      this.getCurrentProcedures(client, schemas),
      this.getCurrentTriggers(client, schemas),
      this.getCurrentSequences(client, schemas),
      this.getCurrentExtensions(client, schemas),
      this.getCurrentSchemas(client, schemas),
      this.getCurrentComments(client, schemas),
      this.getCurrentSqlObjects(client, schemas),
    ]);

    return {
      tables,
      views,
      enumTypes,
      ...(compositeTypes.length > 0 ? { compositeTypes } : {}),
      functions,
      procedures,
      triggers,
      sequences,
      extensions,
      schemas: schemaDefinitions,
      comments,
      ...(sqlObjects.length > 0 ? { sqlObjects } : {}),
    };
  }

  // Get all functions from the database
  async getCurrentFunctions(client: Client, schemas: string[] = ['public']): Promise<Function[]> {
    const result = await client.query(`
      SELECT
        p.proname as function_name,
        format(
          '%I.%I(%s)',
          n.nspname,
          p.proname,
          pg_get_function_identity_arguments(p.oid)
        ) as routine_identity,
        n.nspname as schema_name,
        pg_get_function_arguments(p.oid) as arguments,
        pg_get_function_result(p.oid) as return_type,
        ${ROUTINE_ARGUMENT_TYPES_SQL} as argument_types,
        p.proargmodes::text[] as argument_modes,
        p.proargnames as argument_names,
        ${ROUTINE_RETURN_TYPE_SQL} as canonical_return_type,
        l.lanname as language,
        p.prosrc as source_code,
        p.prokind as routine_kind,
        p.probin as object_file,
        p.prosqlbody IS NOT NULL as has_sql_body,
        p.protrftypes as transform_types,
        p.prosupport <> 0 as has_support,
        CASE p.provolatile
          WHEN 'i' THEN 'IMMUTABLE'
          WHEN 's' THEN 'STABLE'
          WHEN 'v' THEN 'VOLATILE'
        END as volatility,
        CASE p.proparallel
          WHEN 's' THEN 'SAFE'
          WHEN 'u' THEN 'UNSAFE'
          WHEN 'r' THEN 'RESTRICTED'
        END as parallel,
        p.proleakproof as leakproof,
        p.prosecdef as security_definer,
        p.proisstrict as is_strict,
        p.procost as cost,
        p.prorows as rows,
        p.proconfig as configuration,
        ${ROUTINE_DEPENDENT_OBJECTS_SQL} as dependent_objects
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      JOIN pg_type return_type ON return_type.oid = p.prorettype
      JOIN pg_namespace return_namespace
        ON return_namespace.oid = return_type.typnamespace
      LEFT JOIN pg_type return_element_type
        ON return_element_type.oid = return_type.typelem
        AND return_element_type.typarray = return_type.oid
      LEFT JOIN pg_namespace return_element_namespace
        ON return_element_namespace.oid = return_element_type.typnamespace
      LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND p.prokind IN ('f', 'w', 'a')
        AND d.objid IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pg_depend internal_dependency
          WHERE internal_dependency.classid = 'pg_proc'::regclass
            AND internal_dependency.objid = p.oid
            AND internal_dependency.deptype = 'i'
        )
      ORDER BY n.nspname, p.proname
    `, [schemas]);

    assertRoutineRowsAreSupported(result.rows);
    return result.rows.map((row: any) => {
      const dependentObjects = parseRoutineDependentObjects(
        row.dependent_objects
      );
      return {
        name: row.function_name,
        schema: row.schema_name,
        parameters: canonicalRoutineParameters(
          row,
          this.parseFunctionArguments(row.arguments)
        ),
        returnType: row.canonical_return_type || row.return_type,
        language: row.language,
        body: row.source_code,
        volatility: row.volatility,
        parallel: row.parallel,
        leakproof: row.leakproof || undefined,
        securityDefiner: row.security_definer || undefined,
        strict: row.is_strict || undefined,
        cost: row.cost !== getDefaultFunctionCost(row.language)
          ? row.cost
          : undefined,
        rows: row.rows !== 1000 ? row.rows : undefined,
        configuration: parseRoutineConfiguration(row.configuration),
        ...(dependentObjects ? { dependentObjects } : {}),
      };
    });
  }

  // Get all procedures from the database
  async getCurrentProcedures(client: Client, schemas: string[] = ['public']): Promise<Procedure[]> {
    const result = await client.query(`
      SELECT
        p.proname as procedure_name,
        format(
          '%I.%I(%s)',
          n.nspname,
          p.proname,
          pg_get_function_identity_arguments(p.oid)
        ) as routine_identity,
        n.nspname as schema_name,
        pg_get_function_arguments(p.oid) as arguments,
        ${ROUTINE_ARGUMENT_TYPES_SQL} as argument_types,
        p.proargmodes::text[] as argument_modes,
        p.proargnames as argument_names,
        l.lanname as language,
        p.prosrc as source_code,
        p.prokind as routine_kind,
        p.probin as object_file,
        p.prosqlbody IS NOT NULL as has_sql_body,
        p.protrftypes as transform_types,
        p.prosupport <> 0 as has_support,
        p.prosecdef as security_definer,
        p.proconfig as configuration,
        ${ROUTINE_DEPENDENT_OBJECTS_SQL} as dependent_objects
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND p.prokind = 'p'
        AND d.objid IS NULL
      ORDER BY n.nspname, p.proname
    `, [schemas]);

    assertRoutineRowsAreSupported(result.rows);
    return result.rows.map((row: any) => {
      const dependentObjects = parseRoutineDependentObjects(
        row.dependent_objects
      );
      return {
        name: row.procedure_name,
        schema: row.schema_name,
        parameters: canonicalRoutineParameters(
          row,
          this.parseFunctionArguments(row.arguments)
        ),
        language: row.language,
        body: row.source_code,
        securityDefiner: row.security_definer || undefined,
        configuration: parseRoutineConfiguration(row.configuration),
        ...(dependentObjects ? { dependentObjects } : {}),
      };
    });
  }

  // Get all triggers from the database
  async getCurrentTriggers(client: Client, schemas: string[] = ['public']): Promise<Trigger[]> {
    const result = await client.query(`
      SELECT
        t.tgname as trigger_name,
        c.relname as table_name,
        n.nspname as schema_name,
        CASE
          WHEN t.tgtype & 1 = 1 THEN 'ROW'
          ELSE 'STATEMENT'
        END as for_each,
        CASE
          WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
          WHEN t.tgtype & 64 = 64 THEN 'INSTEAD OF'
          ELSE 'AFTER'
        END as timing,
        CASE WHEN t.tgtype & 4 = 4 THEN true ELSE false END as on_insert,
        CASE WHEN t.tgtype & 8 = 8 THEN true ELSE false END as on_delete,
        CASE WHEN t.tgtype & 16 = 16 THEN true ELSE false END as on_update,
        CASE WHEN t.tgtype & 32 = 32 THEN true ELSE false END as on_truncate,
        p.proname as function_name,
        fn.nspname as function_schema,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY
            AS trigger_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = t.tgrelid
            AND attribute.attnum = trigger_column.attnum
          ORDER BY trigger_column.position
        ) as update_columns,
        t.tgoldtable as old_transition_table,
        t.tgnewtable as new_transition_table,
        t.tgenabled as trigger_enabled,
        ARRAY(
          SELECT DISTINCT clone.tgenabled::text
          FROM pg_trigger clone
          WHERE clone.tgparentid = t.oid
            AND clone.tgenabled <> t.tgenabled
          ORDER BY clone.tgenabled::text
        ) as divergent_clone_modes,
        pg_get_triggerdef(t.oid) as trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      JOIN pg_namespace fn ON p.pronamespace = fn.oid
      WHERE n.nspname = ANY($1::text[])
        AND NOT t.tgisinternal
        AND t.tgconstraint = 0
        AND t.tgparentid = 0
      ORDER BY n.nspname, c.relname, t.tgname
    `, [schemas]);

    return result.rows.map((row: any) => {
      if (row.divergent_clone_modes?.length > 0) {
        throw new ValidationError(
          `PostgreSQL partition trigger clones for ${row.schema_name}.${row.table_name}.${row.trigger_name} have firing modes that differ from their parent trigger. TerraDB manages partition clones through the parent; restore the parent mode without ALTER TABLE ONLY before planning`,
          `trigger ${row.schema_name}.${row.table_name}.${row.trigger_name}`,
          "enabled",
          row.divergent_clone_modes
        );
      }
      const events: Trigger['events'] = [];
      if (row.on_insert) events.push('INSERT');
      if (row.on_update) events.push('UPDATE');
      if (row.on_delete) events.push('DELETE');
      if (row.on_truncate) events.push('TRUNCATE');

      const enabled = getPostgresTriggerMode(
        row.trigger_enabled,
        `trigger ${row.schema_name}.${row.table_name}.${row.trigger_name}`
      );
      return {
        name: row.trigger_name,
        tableName: row.table_name,
        schema: row.schema_name,
        timing: row.timing,
        events,
        ...(row.update_columns?.length > 0
          ? { updateColumns: row.update_columns }
          : {}),
        forEach: row.for_each,
        ...(row.old_transition_table
          ? { oldTransitionTable: row.old_transition_table }
          : {}),
        ...(row.new_transition_table
          ? { newTransitionTable: row.new_transition_table }
          : {}),
        when: this.parseTriggerWhenClause(row.trigger_def),
        functionName: row.function_name,
        functionSchema: row.function_schema,
        functionArgs: this.parseTriggerFunctionArgs(row.trigger_def),
        ...(enabled ? { enabled } : {}),
      };
    });
  }

  private parseTriggerWhenClause(triggerDef: string | null): string | undefined {
    if (!triggerDef) {
      return undefined;
    }

    const whenMatch = triggerDef.match(/\sWHEN\s\((.+)\)\sEXECUTE FUNCTION\s/i);
    if (!whenMatch || !whenMatch[1]) {
      return undefined;
    }

    return this.stripOuterParentheses(whenMatch[1]);
  }

  private parseTriggerFunctionArgs(triggerDef: string | null): string[] | undefined {
    if (!triggerDef) {
      return undefined;
    }

    const argsMatch = triggerDef.match(/\sEXECUTE FUNCTION\s+[^()]+\((.*)\)\s*$/i);
    if (!argsMatch || argsMatch[1] === undefined) {
      return undefined;
    }

    const argsText = argsMatch[1].trim();
    if (argsText.length === 0) {
      return undefined;
    }

    const args = this.splitTriggerArgs(argsText);
    return args.length > 0 ? args : undefined;
  }

  private splitTriggerArgs(argsText: string): string[] {
    const args: string[] = [];
    let current = "";
    let inQuote = false;

    for (let i = 0; i < argsText.length; i++) {
      const char = argsText[i];

      if (char === "'") {
        current += char;
        if (inQuote && argsText[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        inQuote = !inQuote;
        continue;
      }

      if (char === "," && !inQuote) {
        const value = current.trim();
        if (value) {
          args.push(value);
        }
        current = "";
        continue;
      }

      current += char;
    }

    const finalValue = current.trim();
    if (finalValue) {
      args.push(finalValue);
    }

    return args;
  }

  private stripOuterParentheses(value: string): string {
    let normalized = value.trim();

    while (this.hasBalancedOuterParentheses(normalized)) {
      normalized = normalized.slice(1, -1).trim();
    }

    return normalized;
  }

  private hasBalancedOuterParentheses(value: string): boolean {
    if (!value.startsWith("(") || !value.endsWith(")")) {
      return false;
    }

    let depth = 0;
    for (let i = 0; i < value.length - 1; i++) {
      const char = value[i];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0) return false;
    }

    return depth === 1;
  }

  // Get all sequences from the database
  async getCurrentSequences(client: Client, schemas: string[] = ['public']): Promise<Sequence[]> {
    const result = await client.query(`
      SELECT
        c.relname as sequence_name,
        n.nspname as schema_name,
        c.relpersistence as sequence_persistence,
        s.seqtypid::regtype::text as data_type,
        s.seqincrement as increment,
        s.seqmin as min_value,
        s.seqmax as max_value,
        s.seqstart as start,
        s.seqcache as cache,
        s.seqcycle as cycle,
        CASE
          WHEN d.deptype = 'a' THEN
            quote_ident(n2.nspname) || '.' || quote_ident(c2.relname) || '.' || quote_ident(a.attname)
          ELSE NULL
        END as owned_by_table_column
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_sequence s ON s.seqrelid = c.oid
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
      LEFT JOIN pg_depend identity_dependency
        ON identity_dependency.objid = c.oid
        AND identity_dependency.classid = 'pg_class'::regclass
        AND identity_dependency.refclassid = 'pg_class'::regclass
        AND identity_dependency.deptype = 'i'
      LEFT JOIN pg_depend de ON de.objid = c.oid AND de.deptype = 'e'
      LEFT JOIN pg_class c2 ON c2.oid = d.refobjid
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      LEFT JOIN pg_namespace n2 ON c2.relnamespace = n2.oid
      WHERE c.relkind = 'S'
        AND n.nspname = ANY($1::text[])
        AND de.objid IS NULL  -- Exclude extension-owned sequences
        AND identity_dependency.objid IS NULL  -- Managed through the identity column
      ORDER BY n.nspname, c.relname
    `, [schemas]);

    return result.rows.map((row: any) => {
      const dataType = row.data_type === 'bigint' ? 'BIGINT'
                     : row.data_type === 'smallint' ? 'SMALLINT'
                     : 'INTEGER';

      return {
        name: row.sequence_name,
        schema: row.schema_name,
        unlogged: row.sequence_persistence === 'u' ? true : undefined,
        dataType: dataType !== 'BIGINT' ? dataType : undefined,
        increment: row.increment !== 1 ? row.increment : undefined,
        minValue: row.min_value,
        maxValue: row.max_value,
        start: row.start !== 1 ? row.start : undefined,
        cache: row.cache !== 1 ? row.cache : undefined,
        cycle: row.cycle || undefined,
        ownedBy: row.owned_by_table_column || undefined,
      };
    });
  }

  // Helper method to parse function arguments string from PostgreSQL
  private parseFunctionArguments(argsString: string): any[] {
    if (!argsString || argsString.trim() === '') {
      return [];
    }

    const params: any[] = [];
    const argParts = this.splitFunctionArguments(argsString);

    for (const arg of argParts) {
      const parsed = this.parseFunctionArgument(arg);
      if (parsed) {
        params.push(parsed);
      }
    }

    return params;
  }

  private parseFunctionArgument(arg: string): any | null {
    let content = arg.trim();
    if (!content) {
      return null;
    }

    let mode: string | undefined;
    const modeMatch = content.match(/^(INOUT|IN|OUT|VARIADIC)\s+/i);
    if (modeMatch) {
      mode = modeMatch[1]?.toUpperCase();
      content = content.slice(modeMatch[0].length).trim();
    }

    const { signaturePart, defaultValue } = this.extractArgumentDefault(content);
    const { name, type } = this.extractArgumentNameAndType(signaturePart);
    if (!type) {
      return null;
    }

    return {
      name,
      type,
      mode,
      default: defaultValue,
    };
  }

  private extractArgumentDefault(value: string): { signaturePart: string; defaultValue: string | undefined } {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let depthParen = 0;
    let depthBracket = 0;

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      if (char === "'" && !inDoubleQuote) {
        if (inSingleQuote && value[i + 1] === "'") {
          i++;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        if (inDoubleQuote && value[i + 1] === '"') {
          i++;
          continue;
        }
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (inSingleQuote || inDoubleQuote) {
        continue;
      }

      if (char === "(") depthParen++;
      if (char === ")") depthParen = Math.max(0, depthParen - 1);
      if (char === "[") depthBracket++;
      if (char === "]") depthBracket = Math.max(0, depthBracket - 1);

      if (depthParen !== 0 || depthBracket !== 0) {
        continue;
      }

      if (i > 0 && /\s/.test(value.charAt(i - 1)) && value.slice(i).toUpperCase().startsWith("DEFAULT ")) {
        return {
          signaturePart: value.slice(0, i).trim(),
          defaultValue: value.slice(i + 8).trim() || undefined,
        };
      }
    }

    return {
      signaturePart: value.trim(),
      defaultValue: undefined,
    };
  }

  private extractArgumentNameAndType(value: string): { name: string | undefined; type: string } {
    const trimmed = value.trim();
    if (!trimmed) {
      return { name: undefined, type: "" };
    }

    if (trimmed.startsWith('"')) {
      const quoted = this.readQuotedIdentifier(trimmed);
      if (quoted) {
        const rest = trimmed.slice(quoted.length).trim();
        if (rest) {
          return {
            name: this.unquoteIdentifier(quoted),
            type: rest,
          };
        }
      }
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_$]*)\s+(.+)$/);
    if (!match) {
      return { name: undefined, type: trimmed };
    }

    const candidateName = match[1]!;
    const normalizedCandidateType = match[2]!.trim();
    if (this.isLikelyTypeToken(candidateName)) {
      return { name: undefined, type: trimmed };
    }

    return {
      name: candidateName,
      type: normalizedCandidateType,
    };
  }

  private readQuotedIdentifier(value: string): string | null {
    if (!value.startsWith('"')) {
      return null;
    }

    let i = 1;
    while (i < value.length) {
      if (value[i] === '"') {
        if (value[i + 1] === '"') {
          i += 2;
          continue;
        }

        return value.slice(0, i + 1);
      }
      i++;
    }

    return null;
  }

  private unquoteIdentifier(value: string): string {
    if (!value.startsWith('"') || !value.endsWith('"')) {
      return value;
    }

    return value.slice(1, -1).replace(/""/g, '"');
  }

  private isLikelyTypeToken(value: string): boolean {
    return new Set([
      "array",
      "bigint",
      "bigserial",
      "bit",
      "bool",
      "boolean",
      "box",
      "bytea",
      "char",
      "character",
      "cidr",
      "circle",
      "date",
      "decimal",
      "double",
      "float",
      "inet",
      "int",
      "int2",
      "int4",
      "int8",
      "integer",
      "interval",
      "json",
      "jsonb",
      "line",
      "lseg",
      "macaddr",
      "money",
      "numeric",
      "path",
      "pg_lsn",
      "point",
      "polygon",
      "real",
      "serial",
      "smallint",
      "smallserial",
      "text",
      "time",
      "timetz",
      "timestamp",
      "timestamptz",
      "tsquery",
      "tsvector",
      "txid_snapshot",
      "uuid",
      "varbit",
      "varchar",
      "void",
      "xml",
    ]).has(value.toLowerCase());
  }

  private splitFunctionArguments(argsString: string): string[] {
    const args: string[] = [];
    let current = "";
    let depthParen = 0;
    let depthBracket = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if (char === "'" && !inDoubleQuote) {
        current += char;
        if (inSingleQuote && argsString[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        current += char;
        if (inDoubleQuote && argsString[i + 1] === '"') {
          current += '"';
          i++;
          continue;
        }
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote) {
        if (char === "(") depthParen++;
        if (char === ")") depthParen = Math.max(0, depthParen - 1);
        if (char === "[") depthBracket++;
        if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
      }

      if (char === "," && !inSingleQuote && !inDoubleQuote && depthParen === 0 && depthBracket === 0) {
        const value = current.trim();
        if (value) {
          args.push(value);
        }
        current = "";
        continue;
      }

      current += char;
    }

    const finalValue = current.trim();
    if (finalValue) {
      args.push(finalValue);
    }

    return args;
  }

  // Get the database-wide extension graph, excluding the built-in language extension.
  async getCurrentExtensions(client: Client, _schemas: string[] = ['public']): Promise<Extension[]> {
    const result = await client.query(`
      SELECT
        e.extname as extension_name,
        n.nspname as schema_name,
        e.extversion as version,
        dependency.names as dependencies
      FROM pg_extension e
      JOIN pg_namespace n ON e.extnamespace = n.oid
      LEFT JOIN LATERAL (
        SELECT json_agg(required.extname ORDER BY required.extname) as names
        FROM pg_depend d
        JOIN pg_extension required
          ON d.refclassid = 'pg_extension'::regclass
          AND d.refobjid = required.oid
        WHERE d.classid = 'pg_extension'::regclass
          AND d.objid = e.oid
          AND d.objsubid = 0
          AND d.refobjsubid = 0
          AND d.deptype = 'n'
          AND required.extname != 'plpgsql'
      ) dependency ON true
      WHERE e.extname != 'plpgsql'  -- Exclude the built-in language extension
      ORDER BY n.nspname, e.extname
    `);

    return result.rows.map(function mapExtension(row: any) {
      return {
        name: row.extension_name,
        schema: row.schema_name,
        version: row.version || undefined,
        dependencies: row.dependencies?.length > 0
          ? row.dependencies
          : undefined,
      };
    });
  }

  // Get all user-created schemas from the database
  async getCurrentSchemas(client: Client, schemas: string[] = ['public']): Promise<SchemaDefinition[]> {
    const result = await client.query(`
      SELECT
        n.nspname as schema_name,
        pg_get_userbyid(n.nspowner) as owner
      FROM pg_namespace n
      WHERE n.nspname = ANY($1::text[])
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_%'
      ORDER BY n.nspname
    `, [schemas]);

    return result.rows.map((row: any) => ({
      name: row.schema_name,
      owner: row.owner || undefined,
    }));
  }

  // Get all comments from the database
  async getCurrentComments(client: Client, schemas: string[] = ['public']): Promise<Comment[]> {
    const result = await client.query(`
      SELECT
        CASE c.relkind
          WHEN 'r' THEN 'TABLE'
          WHEN 'p' THEN 'TABLE'
          WHEN 'v' THEN 'VIEW'
          WHEN 'm' THEN 'MATERIALIZED VIEW'
          WHEN 'i' THEN 'INDEX'
          WHEN 'S' THEN 'SEQUENCE'
        END as object_type,
        c.relname as object_name,
        n.nspname as schema_name,
        NULL as column_name,
        d.description as comment
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_description d
        ON d.objoid = c.oid
        AND d.classoid = 'pg_class'::regclass
        AND d.objsubid = 0
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p', 'v', 'm', 'i', 'S')

      UNION ALL

      SELECT
        'TYPE' as object_type,
        t.typname as object_name,
        n.nspname as schema_name,
        NULL as column_name,
        d.description as comment
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      JOIN pg_description d
        ON d.objoid = t.oid
        AND d.classoid = 'pg_type'::regclass
        AND d.objsubid = 0
      LEFT JOIN pg_class c ON c.oid = t.typrelid
      LEFT JOIN pg_depend dep ON dep.objid = t.oid AND dep.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND dep.objid IS NULL
        AND (
          t.typtype IN ('e', 'd', 'r', 'm')
          OR (t.typtype = 'c' AND c.relkind = 'c')
        )

      UNION ALL

      SELECT
        'SCHEMA' as object_type,
        n.nspname as object_name,
        NULL as schema_name,
        NULL as column_name,
        d.description as comment
      FROM pg_namespace n
      JOIN pg_description d
        ON d.objoid = n.oid
        AND d.classoid = 'pg_namespace'::regclass
        AND d.objsubid = 0
      WHERE n.nspname = ANY($1::text[])

      UNION ALL

      SELECT
        'COLUMN' as object_type,
        c.relname as object_name,
        n.nspname as schema_name,
        a.attname as column_name,
        d.description as comment
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = c.oid
      JOIN pg_description d
        ON d.objoid = c.oid
        AND d.classoid = 'pg_class'::regclass
        AND d.objsubid = a.attnum
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p', 'v', 'm', 'c')
        AND a.attnum > 0
        AND NOT a.attisdropped

      ORDER BY object_type, object_name
    `, [schemas]);

    return result.rows.map((row: any) => ({
      objectType: row.object_type as Comment['objectType'],
      objectName: row.object_name,
      schemaName: row.schema_name || undefined,
      columnName: row.column_name || undefined,
      comment: row.comment,
    }));
  }

  private async getCurrentPartitionObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        c.oid,
        c.relname as table_name,
        n.nspname as schema_name,
        c.relpersistence as relation_persistence,
        c.relkind as relation_kind,
        c.relispartition as is_partition,
        c.reloptions as relation_options,
        relation_tablespace.spcname as relation_tablespace,
        relation_access_method.amname as relation_access_method,
        pg_get_partkeydef(c.oid) as partition_key,
        c.relreplident as replica_identity_mode,
        replica_identity_index.index_name as replica_identity_index_name,
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'name', operator_class.opcname,
              'schema', operator_class_namespace.nspname,
              'inputType', jsonb_build_object(
                'name', operator_class_type.typname,
                'schema', operator_class_type_namespace.nspname
              ),
              'isDefault', operator_class.opcdefault
            )
            ORDER BY partition_key_class.position
          )
          FROM pg_partitioned_table partitioned
          CROSS JOIN LATERAL unnest(partitioned.partclass::oid[])
            WITH ORDINALITY AS partition_key_class(operator_class_oid, position)
          JOIN pg_opclass operator_class
            ON operator_class.oid = partition_key_class.operator_class_oid
          JOIN pg_namespace operator_class_namespace
            ON operator_class_namespace.oid = operator_class.opcnamespace
          JOIN pg_type operator_class_type
            ON operator_class_type.oid = operator_class.opcintype
          JOIN pg_namespace operator_class_type_namespace
            ON operator_class_type_namespace.oid = operator_class_type.typnamespace
          WHERE partitioned.partrelid = c.oid
        ) as partition_key_operator_classes,
        unsupported_partition_feature.items as unsupported_partition_features,
        unsupported_constraint.items as unsupported_constraints
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_tablespace relation_tablespace
        ON relation_tablespace.oid = c.reltablespace
      LEFT JOIN pg_am relation_access_method
        ON relation_access_method.oid = c.relam
      LEFT JOIN LATERAL (
        SELECT index_relation.relname AS index_name
        FROM pg_index index_catalog
        JOIN pg_class index_relation
          ON index_relation.oid = index_catalog.indexrelid
        WHERE index_catalog.indrelid = c.oid
          AND index_catalog.indisreplident
        ORDER BY index_relation.relname
        LIMIT 1
      ) replica_identity_index ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(feature ORDER BY feature) AS items
        FROM (
          SELECT format(
            'column %I STORAGE or COMPRESSION',
            attribute.attname
          ) AS feature
          FROM pg_attribute attribute
          JOIN pg_type attribute_type ON attribute_type.oid = attribute.atttypid
          WHERE attribute.attrelid = c.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND (
              attribute.attstorage <> attribute_type.typstorage
              OR attribute.attcompression <> ''
            )

          UNION ALL

          SELECT format(
            'column %I statistics target or attribute options',
            attribute.attname
          ) AS feature
          FROM pg_attribute attribute
          WHERE attribute.attrelid = c.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND (
              attribute.attstattarget >= 0
              OR COALESCE(array_length(attribute.attoptions, 1), 0) > 0
            )

          UNION ALL

          SELECT format(
            'expression index %I statistics target',
            index_relation.relname
          ) AS feature
          FROM pg_index index_catalog
          JOIN pg_class index_relation
            ON index_relation.oid = index_catalog.indexrelid
          JOIN pg_attribute index_attribute
            ON index_attribute.attrelid = index_catalog.indexrelid
            AND index_attribute.attnum > 0
            AND index_attribute.attnum <= index_catalog.indnkeyatts
          WHERE index_catalog.indrelid = c.oid
            AND index_attribute.attstattarget >= 0

          UNION ALL

          SELECT format('foreign key %I', constraint_catalog.conname)
          FROM pg_constraint constraint_catalog
          WHERE constraint_catalog.conrelid = c.oid
            AND constraint_catalog.contype = 'f'

          UNION ALL

          SELECT format('persistent cluster index %I', index_relation.relname)
          FROM pg_index index_catalog
          JOIN pg_class index_relation
            ON index_relation.oid = index_catalog.indexrelid
          WHERE index_catalog.indrelid = c.oid
            AND index_catalog.indisclustered
        ) feature_catalog
      ) unsupported_partition_feature ON true
      ${UNSUPPORTED_CONSTRAINT_JOIN_SQL}
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind = 'p'
        AND d.objid IS NULL
      ORDER BY n.nspname, c.relname
    `, [schemas]);
    assertConstraintRowsAreSupported(result.rows);
    assertPartitionRowsAreSupported(result.rows);

    const objects: SqlObject[] = [];

    for (const row of result.rows) {
      const inspectedColumns = await this.getTableColumnDefinitions(
        client,
        row.table_name,
        row.schema_name
      );
      const columns = inspectedColumns.map(function getDefinition(column) {
        return column.definition;
      });
      const partitionColumnTypeSchemas = Object.fromEntries(
        inspectedColumns.flatMap(function getTypeSchema(column) {
          return column.typeSchema
            ? [[column.name, column.typeSchema]]
            : [];
        })
      );
      const constraints = await this.getTableConstraintDefinitions(client, row.oid);
      const body = [...columns, ...constraints].join(",\n  ");
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);
      const createStatement = `CREATE TABLE ${qualifiedTable} (\n  ${body}\n) PARTITION BY ${row.partition_key};`;
      const replicaIdentity = getPostgresReplicaIdentity(
        row.replica_identity_mode,
        row.replica_identity_index_name,
        `partitioned table ${row.schema_name}.${row.table_name}`
      );

      objects.push({
        kind: "partition",
        key: `partition:${row.schema_name}.${row.table_name}`,
        name: row.table_name,
        schema: row.schema_name,
        createStatement,
        dropStatement: `DROP TABLE IF EXISTS ${qualifiedTable} RESTRICT;`,
        ...(Object.keys(partitionColumnTypeSchemas).length > 0
          ? { partitionColumnTypeSchemas }
          : {}),
        ...(Array.isArray(row.partition_key_operator_classes)
          ? {
              partitionKeyOperatorClasses:
                row.partition_key_operator_classes,
            }
          : {}),
        ...(replicaIdentity ? { replicaIdentity } : {}),
      });
    }

    const childResult = await client.query(`
      SELECT
        c.relname as table_name,
        n.nspname as schema_name,
        c.relpersistence as relation_persistence,
        c.relkind as relation_kind,
        c.relispartition as is_partition,
        c.reloptions as relation_options,
        relation_tablespace.spcname as relation_tablespace,
        relation_access_method.amname as relation_access_method,
        parent.relname as parent_name,
        parent_ns.nspname as parent_schema,
        pg_get_expr(c.relpartbound, c.oid) as partition_bound,
        c.relreplident as replica_identity_mode,
        replica_identity_index.index_name as replica_identity_index_name,
        unsupported_partition_feature.items as unsupported_partition_features,
        unsupported_constraint.items as unsupported_constraints
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      LEFT JOIN pg_tablespace relation_tablespace
        ON relation_tablespace.oid = c.reltablespace
      LEFT JOIN pg_am relation_access_method
        ON relation_access_method.oid = c.relam
      LEFT JOIN LATERAL (
        SELECT index_relation.relname AS index_name
        FROM pg_index index_catalog
        JOIN pg_class index_relation
          ON index_relation.oid = index_catalog.indexrelid
        WHERE index_catalog.indrelid = c.oid
          AND index_catalog.indisreplident
        ORDER BY index_relation.relname
        LIMIT 1
      ) replica_identity_index ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(feature ORDER BY feature) AS items
        FROM (
          SELECT format('column override %I', child_attribute.attname) AS feature
          FROM pg_attribute child_attribute
          JOIN pg_attribute parent_attribute
            ON parent_attribute.attrelid = parent.oid
            AND parent_attribute.attname = child_attribute.attname
            AND parent_attribute.attnum > 0
            AND NOT parent_attribute.attisdropped
          LEFT JOIN pg_attrdef child_default
            ON child_default.adrelid = child_attribute.attrelid
            AND child_default.adnum = child_attribute.attnum
          LEFT JOIN pg_attrdef parent_default
            ON parent_default.adrelid = parent_attribute.attrelid
            AND parent_default.adnum = parent_attribute.attnum
          WHERE child_attribute.attrelid = c.oid
            AND child_attribute.attnum > 0
            AND NOT child_attribute.attisdropped
            AND (
              child_attribute.attnotnull IS DISTINCT FROM parent_attribute.attnotnull
              OR pg_get_expr(child_default.adbin, child_default.adrelid)
                IS DISTINCT FROM
                pg_get_expr(parent_default.adbin, parent_default.adrelid)
              OR child_attribute.attstorage IS DISTINCT FROM parent_attribute.attstorage
              OR child_attribute.attcompression IS DISTINCT FROM parent_attribute.attcompression
            )

          UNION ALL

          SELECT format(
            'column %I statistics target or attribute options',
            child_attribute.attname
          ) AS feature
          FROM pg_attribute child_attribute
          WHERE child_attribute.attrelid = c.oid
            AND child_attribute.attnum > 0
            AND NOT child_attribute.attisdropped
            AND (
              child_attribute.attstattarget >= 0
              OR COALESCE(array_length(child_attribute.attoptions, 1), 0) > 0
            )

          UNION ALL

          SELECT format(
            'expression index %I statistics target',
            index_relation.relname
          ) AS feature
          FROM pg_index index_catalog
          JOIN pg_class index_relation
            ON index_relation.oid = index_catalog.indexrelid
          JOIN pg_attribute index_attribute
            ON index_attribute.attrelid = index_catalog.indexrelid
            AND index_attribute.attnum > 0
            AND index_attribute.attnum <= index_catalog.indnkeyatts
          WHERE index_catalog.indrelid = c.oid
            AND index_attribute.attstattarget >= 0

          UNION ALL

          SELECT format('local constraint %I', constraint_catalog.conname)
          FROM pg_constraint constraint_catalog
          WHERE constraint_catalog.conrelid = c.oid
            AND constraint_catalog.conislocal
            AND constraint_catalog.coninhcount = 0

          UNION ALL

          SELECT format('persistent cluster index %I', index_relation.relname)
          FROM pg_index index_catalog
          JOIN pg_class index_relation
            ON index_relation.oid = index_catalog.indexrelid
          WHERE index_catalog.indrelid = c.oid
            AND index_catalog.indisclustered
        ) feature_catalog
      ) unsupported_partition_feature ON true
      ${UNSUPPORTED_CONSTRAINT_JOIN_SQL}
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND c.relispartition
        AND c.relkind IN ('r', 'p', 'f')
        AND d.objid IS NULL
      ORDER BY n.nspname, c.relname
    `, [schemas]);
    assertConstraintRowsAreSupported(childResult.rows);
    assertPartitionRowsAreSupported(childResult.rows);

    for (const row of childResult.rows) {
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);
      const parentTable = this.qualifyName(row.parent_name, row.parent_schema);
      const replicaIdentity = getPostgresReplicaIdentity(
        row.replica_identity_mode,
        row.replica_identity_index_name,
        `partition ${row.schema_name}.${row.table_name}`
      );
      objects.push({
        kind: "partition",
        key: `partition:${row.schema_name}.${row.table_name}`,
        name: row.table_name,
        schema: row.schema_name,
        createStatement: `CREATE TABLE ${qualifiedTable} PARTITION OF ${parentTable} ${row.partition_bound};`,
        dropStatement: `DROP TABLE IF EXISTS ${qualifiedTable} RESTRICT;`,
        dependencies: [`partition:${row.parent_schema}.${row.parent_name}`],
        ...(replicaIdentity ? { replicaIdentity } : {}),
      });
    }

    return objects;
  }

  private async getCurrentRowSecurityObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        c.relname as table_name,
        n.nspname as schema_name,
        c.relrowsecurity as row_security_enabled,
        c.relforcerowsecurity as row_security_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')
        AND (c.relrowsecurity OR c.relforcerowsecurity)
      ORDER BY n.nspname, c.relname
    `, [schemas]);

    const objects: SqlObject[] = [];

    for (const row of result.rows) {
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);

      if (row.row_security_enabled) {
        objects.push({
          kind: "row-level-security",
          key: `row-level-security:${row.schema_name}.${row.table_name}:enabled`,
          name: row.table_name,
          schema: row.schema_name,
          createStatement: `ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY;`,
          dropStatement: `ALTER TABLE ${qualifiedTable} DISABLE ROW LEVEL SECURITY;`,
        });
      }

      if (row.row_security_forced) {
        objects.push({
          kind: "row-level-security",
          key: `row-level-security:${row.schema_name}.${row.table_name}:force`,
          name: row.table_name,
          schema: row.schema_name,
          createStatement: `ALTER TABLE ${qualifiedTable} FORCE ROW LEVEL SECURITY;`,
          dropStatement: `ALTER TABLE ${qualifiedTable} NO FORCE ROW LEVEL SECURITY;`,
        });
      }
    }

    return objects;
  }

  private async getCurrentPolicyObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        pol.polname as policy_name,
        c.relname as table_name,
        n.nspname as schema_name,
        pol.polcmd as policy_command,
        pol.polpermissive as is_permissive,
        pg_get_expr(pol.polqual, pol.polrelid) as using_expression,
        pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expression,
        ARRAY(
          SELECT policy_role.role_name
          FROM (
            SELECT 'PUBLIC'::text as role_name
            WHERE 0::oid = ANY(pol.polroles)
            UNION ALL
            SELECT rolname::text as role_name
            FROM pg_roles
            WHERE oid = ANY(pol.polroles)
          ) policy_role
          ORDER BY policy_role.role_name
        ) as policy_roles
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname, pol.polname
    `, [schemas]);

    const inspector = this;
    return result.rows.map(function mapPolicy(row: any) {
      const qualifiedTable = inspector.qualifyName(
        row.table_name,
        row.schema_name
      );
      const commandMap: Record<
        string,
        PostgresPolicyDefinition["command"]
      > = {
        r: "select",
        a: "insert",
        w: "update",
        d: "delete",
        "*": "all",
      };
      const command = commandMap[row.policy_command] || "all";
      const parts = [
        `CREATE POLICY ${inspector.quoteIdent(row.policy_name)}`,
        `ON ${qualifiedTable}`,
        `AS ${row.is_permissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
        `FOR ${command.toUpperCase()}`,
      ];

      const roles = row.policy_roles || [];
      if (roles.length > 0) {
        parts.push(
          `TO ${roles.map(function quotePolicyRole(role: string) {
            return inspector.quoteRole(role);
          }).join(", ")}`
        );
      }
      if (row.using_expression) {
        parts.push(`USING (${row.using_expression})`);
      }
      if (row.with_check_expression) {
        parts.push(`WITH CHECK (${row.with_check_expression})`);
      }

      return {
        kind: "policy" as const,
        key: `policy:${row.schema_name}.${row.table_name}.${row.policy_name}`,
        name: row.policy_name,
        schema: row.schema_name,
        createStatement: `${parts.join(" ")};`,
        dropStatement: `DROP POLICY IF EXISTS ${inspector.quoteIdent(row.policy_name)} ON ${qualifiedTable};`,
        policyDefinition: {
          command,
          permissive: row.is_permissive,
          roles: roles.map(function mapPolicyRole(role: string) {
            return role === "PUBLIC"
              ? { kind: "public" as const }
              : { kind: "name" as const, name: role };
          }),
          ...(row.using_expression
            ? { using: row.using_expression }
            : {}),
          ...(row.with_check_expression
            ? { withCheck: row.with_check_expression }
            : {}),
        },
      };
    });
  }

  private async getCurrentDomainObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        t.oid,
        t.typname as type_name,
        n.nspname as schema_name,
        format_type(t.typbasetype, t.typtypmod) as base_type,
        CASE
          WHEN base_type.typtype IN ('d', 'r') THEN base_type.typtype
          WHEN base_element_type.typtype IN ('d', 'r') THEN base_element_type.typtype
          WHEN base_range.rngtypid IS NOT NULL THEN 'r'
          ELSE base_type.typtype
        END as base_type_kind,
        CASE
          WHEN base_type.typtype IN ('d', 'r') THEN base_namespace.nspname
          WHEN base_element_type.typtype IN ('d', 'r') THEN base_element_namespace.nspname
          WHEN base_range.rngtypid IS NOT NULL THEN base_range_namespace.nspname
          ELSE base_namespace.nspname
        END as base_type_schema,
        CASE
          WHEN base_type.typtype IN ('d', 'r') THEN base_type.typname
          WHEN base_element_type.typtype IN ('d', 'r') THEN base_element_type.typname
          WHEN base_range.rngtypid IS NOT NULL THEN base_range_type.typname
          ELSE base_type.typname
        END as base_type_name,
        t.typnotnull as is_not_null,
        t.typdefault as default_value,
        CASE
          WHEN domain_collation.oid = 0
            OR domain_collation.oid = base_type.typcollation
          THEN NULL
          ELSE domain_collation.collname
        END as collation_name,
        CASE
          WHEN domain_collation.oid = 0
            OR domain_collation.oid = base_type.typcollation
          THEN NULL
          ELSE collation_namespace.nspname
        END as collation_schema,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'schema', relation_namespace.nspname,
              'relation', relation.relname,
              'attribute', attribute.attname,
              'relationKind', relation.relkind
            )
            ORDER BY relation_namespace.nspname, relation.relname, attribute.attname
          )
          FROM pg_depend dependency
          JOIN pg_class relation
            ON dependency.classid = 'pg_class'::regclass
            AND relation.oid = dependency.objid
          JOIN pg_namespace relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          JOIN pg_attribute attribute
            ON attribute.attrelid = relation.oid
            AND attribute.attnum = dependency.objsubid
          WHERE dependency.refclassid = 'pg_type'::regclass
            AND dependency.refobjid IN (t.oid, t.typarray)
            AND dependency.deptype = 'n'
            AND NOT attribute.attisdropped
        ), '[]'::jsonb) as attribute_dependents,
        COALESCE((
          SELECT jsonb_agg(type_dependency ORDER BY type_dependency->>'schema', type_dependency->>'name')
          FROM (
            SELECT jsonb_build_object(
              'schema', dependent_namespace.nspname,
              'name', dependent_type.typname,
              'kind', 'domain'
            ) as type_dependency
            FROM pg_type dependent_type
            JOIN pg_namespace dependent_namespace
              ON dependent_namespace.oid = dependent_type.typnamespace
            WHERE dependent_type.typtype = 'd'
              AND dependent_type.typbasetype IN (t.oid, t.typarray)

            UNION ALL

            SELECT jsonb_build_object(
              'schema', dependent_namespace.nspname,
              'name', dependent_type.typname,
              'kind', 'range'
            ) as type_dependency
            FROM pg_range dependent_range
            JOIN pg_type dependent_type
              ON dependent_type.oid = dependent_range.rngtypid
            JOIN pg_namespace dependent_namespace
              ON dependent_namespace.oid = dependent_type.typnamespace
            WHERE dependent_range.rngsubtype IN (t.oid, t.typarray)
          ) dependencies
        ), '[]'::jsonb) as type_dependents,
        ${getPostgresTypeRoutineDependentsSql("t.oid, t.typarray")} as routine_dependents,
        ${getPostgresTypeCatalogDependentsSql("t.oid, t.typarray")} as catalog_dependents
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_type base_type ON base_type.oid = t.typbasetype
      JOIN pg_namespace base_namespace ON base_namespace.oid = base_type.typnamespace
      LEFT JOIN pg_type base_element_type
        ON base_element_type.oid = base_type.typelem
        AND base_type.typelem <> 0
      LEFT JOIN pg_namespace base_element_namespace
        ON base_element_namespace.oid = base_element_type.typnamespace
      LEFT JOIN pg_range base_range
        ON base_range.rngtypid IN (base_type.oid, base_element_type.oid)
        OR base_range.rngmultitypid IN (base_type.oid, base_element_type.oid)
      LEFT JOIN pg_type base_range_type ON base_range_type.oid = base_range.rngtypid
      LEFT JOIN pg_namespace base_range_namespace
        ON base_range_namespace.oid = base_range_type.typnamespace
      LEFT JOIN pg_collation domain_collation ON domain_collation.oid = t.typcollation
      LEFT JOIN pg_namespace collation_namespace
        ON collation_namespace.oid = domain_collation.collnamespace
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'd'
        AND d.objid IS NULL
      ORDER BY n.nspname, t.typname
    `, [schemas]);

    const objects: SqlObject[] = [];

    for (const row of result.rows) {
      const constraints = await client.query(`
        SELECT
          conname,
          pg_get_constraintdef(oid) as definition,
          pg_get_expr(conbin, 0) as expression,
          convalidated as is_validated
        FROM pg_constraint
        WHERE contypid = $1
          AND contype <> 'n'
        ORDER BY conname
      `, [row.oid]);
      const containerDependents = await client.query(`
        WITH RECURSIVE dependent_types(oid, is_container) AS (
          SELECT $1::oid, false

          UNION

          SELECT
            candidate.oid,
            dependent.is_container OR candidate.adds_container
          FROM dependent_types dependent
          CROSS JOIN LATERAL (
            SELECT derived.oid, false AS adds_container
            FROM pg_type derived
            WHERE derived.typtype = 'd'
              AND derived.typbasetype = dependent.oid

            UNION ALL

            SELECT source.typarray, true
            FROM pg_type source
            WHERE source.oid = dependent.oid
              AND source.typarray <> 0

            UNION ALL

            SELECT range_definition.rngtypid, true
            FROM pg_range range_definition
            WHERE range_definition.rngsubtype = dependent.oid

            UNION ALL

            SELECT range_definition.rngmultitypid, true
            FROM pg_range range_definition
            WHERE range_definition.rngtypid = dependent.oid

            UNION ALL

            SELECT relation.reltype, true
            FROM pg_attribute attribute
            JOIN pg_class relation ON relation.oid = attribute.attrelid
            WHERE relation.relkind = 'c'
              AND attribute.atttypid = dependent.oid
              AND NOT attribute.attisdropped
          ) candidate
        )
        SELECT EXISTS (
          SELECT 1
          FROM dependent_types dependent
          JOIN pg_attribute attribute ON attribute.atttypid = dependent.oid
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          WHERE dependent.is_container
            AND relation.relkind IN ('r', 'p', 'f', 'm')
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) AS has_container_dependents
      `, [row.oid]);

      const parts = [
        `CREATE DOMAIN ${this.qualifyName(row.type_name, row.schema_name)}`,
        `AS ${row.base_type}`,
      ];

      if (row.collation_name) {
        parts.push(
          `COLLATE ${this.qualifyName(row.collation_name, row.collation_schema)}`
        );
      }
      if (row.default_value) {
        parts.push(`DEFAULT ${row.default_value}`);
      }
      if (row.is_not_null) {
        parts.push("NOT NULL");
      }
      for (const constraint of constraints.rows) {
        parts.push(`CONSTRAINT ${this.quoteIdent(constraint.conname)} ${constraint.definition}`);
      }

      const typeDependents = row.type_dependents || [];
      const dependencies =
        row.base_type_kind === "d" || row.base_type_kind === "r"
          ? [
              `${row.base_type_kind === "d" ? "domain" : "range"}-type:${row.base_type_schema}.${row.base_type_name}`,
            ]
          : [];
      const baseTypeSchema = this.getUnqualifiedCatalogTypeSchema(
        row.base_type,
        row.base_type_schema
      );

      objects.push({
        kind: "domain-type",
        key: `domain-type:${row.schema_name}.${row.type_name}`,
        name: row.type_name,
        schema: row.schema_name,
        createStatement: `${parts.join(" ")};`,
        dropStatement: `DROP DOMAIN IF EXISTS ${this.qualifyName(row.type_name, row.schema_name)} RESTRICT;`,
        ...(dependencies.length > 0 ? { dependencies } : {}),
        typeDefinition: {
          kind: "domain",
          baseType: row.base_type,
          ...(baseTypeSchema ? { baseTypeSchema } : {}),
          ...(row.collation_name
            ? {
                collation: {
                  name: row.collation_name,
                  schema: row.collation_schema,
                },
              }
            : {}),
          ...(row.default_value ? { default: row.default_value } : {}),
          notNull: row.is_not_null,
          constraints: constraints.rows.map(function mapConstraint(
            constraint: any
          ) {
            return {
              name: constraint.conname,
              expression:
                constraint.expression ||
                String(constraint.definition || "")
                  .replace(/^CHECK\s*\(/i, "")
                  .replace(/\)$/, ""),
              validated: constraint.is_validated !== false,
            };
          }),
        },
        ...(row.attribute_dependents?.length > 0
          ? { attributeDependents: row.attribute_dependents }
          : {}),
        ...(typeDependents.length > 0 ? { typeDependents } : {}),
        ...(row.routine_dependents?.length > 0
          ? { routineDependents: row.routine_dependents }
          : {}),
        ...(row.catalog_dependents?.length > 0
          ? { catalogDependents: row.catalog_dependents }
          : {}),
        ...(containerDependents.rows[0]?.has_container_dependents
          ? { hasContainerColumnDependents: true }
          : {}),
      });
    }

    return objects;
  }

  private async getCurrentRangeObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        t.oid,
        t.typname as type_name,
        n.nspname as schema_name,
        format_type(r.rngsubtype, NULL) as subtype_name,
        subtype.typtype as subtype_kind,
        subtype_namespace.nspname as subtype_schema,
        subtype.typname as subtype_type_name,
        CASE
          WHEN opclass.oid IS NULL OR opclass.opcdefault THEN NULL
          WHEN opclass_ns.nspname = 'public' THEN quote_ident(opclass.opcname)
          ELSE quote_ident(opclass_ns.nspname) || '.' || quote_ident(opclass.opcname)
        END as subtype_opclass_name,
        opclass.opcname as subtype_opclass_bare_name,
        opclass_ns.nspname as subtype_opclass_schema,
        COALESCE(opclass.opcdefault, false) as subtype_opclass_is_default,
        CASE
          WHEN coll.oid IS NULL OR coll.oid = subtype.typcollation THEN NULL
          WHEN coll_ns.nspname = 'public' THEN quote_ident(coll.collname)
          ELSE quote_ident(coll_ns.nspname) || '.' || quote_ident(coll.collname)
        END as collation_name,
        CASE
          WHEN coll.oid IS NULL OR coll.oid = subtype.typcollation THEN NULL
          ELSE coll.collname
        END as collation_bare_name,
        CASE
          WHEN coll.oid IS NULL OR coll.oid = subtype.typcollation THEN NULL
          ELSE coll_ns.nspname
        END as collation_schema,
        CASE
          WHEN canonical.oid IS NULL THEN NULL
          ELSE quote_ident(canonical_ns.nspname) || '.' || quote_ident(canonical.proname)
        END as canonical_name,
        canonical.proname as canonical_bare_name,
        canonical_ns.nspname as canonical_schema,
        CASE
          WHEN diff.oid IS NULL THEN NULL
          ELSE quote_ident(diff_ns.nspname) || '.' || quote_ident(diff.proname)
        END as diff_name,
        diff.proname as diff_bare_name,
        diff_ns.nspname as diff_schema,
        multirange.typname as multirange_name,
        multirange_namespace.nspname as multirange_schema,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'schema', relation_namespace.nspname,
              'relation', relation.relname,
              'attribute', attribute.attname,
              'relationKind', relation.relkind
            )
            ORDER BY relation_namespace.nspname, relation.relname, attribute.attname
          )
          FROM pg_depend dependency
          JOIN pg_class relation
            ON dependency.classid = 'pg_class'::regclass
            AND relation.oid = dependency.objid
          JOIN pg_namespace relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          JOIN pg_attribute attribute
            ON attribute.attrelid = relation.oid
            AND attribute.attnum = dependency.objsubid
          WHERE dependency.refclassid = 'pg_type'::regclass
            AND dependency.refobjid IN (
              t.oid,
              t.typarray,
              r.rngmultitypid,
              multirange.typarray
            )
            AND dependency.deptype = 'n'
            AND NOT attribute.attisdropped
        ), '[]'::jsonb) as attribute_dependents,
        COALESCE((
          SELECT jsonb_agg(type_dependency ORDER BY type_dependency->>'schema', type_dependency->>'name')
          FROM (
            SELECT jsonb_build_object(
              'schema', dependent_namespace.nspname,
              'name', dependent_type.typname,
              'kind', 'domain'
            ) as type_dependency
            FROM pg_type dependent_type
            JOIN pg_namespace dependent_namespace
              ON dependent_namespace.oid = dependent_type.typnamespace
            WHERE dependent_type.typtype = 'd'
              AND dependent_type.typbasetype IN (
                t.oid,
                t.typarray,
                r.rngmultitypid,
                multirange.typarray
              )

            UNION ALL

            SELECT jsonb_build_object(
              'schema', dependent_namespace.nspname,
              'name', dependent_type.typname,
              'kind', 'range'
            ) as type_dependency
            FROM pg_range dependent_range
            JOIN pg_type dependent_type
              ON dependent_type.oid = dependent_range.rngtypid
            JOIN pg_namespace dependent_namespace
              ON dependent_namespace.oid = dependent_type.typnamespace
            WHERE dependent_range.rngsubtype IN (
              t.oid,
              t.typarray,
              r.rngmultitypid,
              multirange.typarray
            )
          ) dependencies
        ), '[]'::jsonb) as type_dependents,
        ${getPostgresTypeRoutineDependentsSql(`
          t.oid,
          t.typarray,
          r.rngmultitypid,
          multirange.typarray
        `)} as routine_dependents,
        ${getPostgresTypeCatalogDependentsSql(`
          t.oid,
          t.typarray,
          r.rngmultitypid,
          multirange.typarray
        `)} as catalog_dependents
      FROM pg_range r
      JOIN pg_type t ON t.oid = r.rngtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_type subtype ON subtype.oid = r.rngsubtype
      JOIN pg_namespace subtype_namespace
        ON subtype_namespace.oid = subtype.typnamespace
      JOIN pg_type multirange ON multirange.oid = r.rngmultitypid
      JOIN pg_namespace multirange_namespace
        ON multirange_namespace.oid = multirange.typnamespace
      LEFT JOIN pg_opclass opclass ON opclass.oid = r.rngsubopc
      LEFT JOIN pg_namespace opclass_ns ON opclass_ns.oid = opclass.opcnamespace
      LEFT JOIN pg_collation coll ON coll.oid = r.rngcollation AND r.rngcollation <> 0
      LEFT JOIN pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
      LEFT JOIN pg_proc canonical ON canonical.oid = r.rngcanonical AND r.rngcanonical <> 0
      LEFT JOIN pg_namespace canonical_ns ON canonical_ns.oid = canonical.pronamespace
      LEFT JOIN pg_proc diff ON diff.oid = r.rngsubdiff AND r.rngsubdiff <> 0
      LEFT JOIN pg_namespace diff_ns ON diff_ns.oid = diff.pronamespace
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND d.objid IS NULL
      ORDER BY n.nspname, t.typname
    `, [schemas]);

    const inspector = this;
    return result.rows.map(function mapRange(row: any) {
      const params = [`subtype = ${row.subtype_name}`];
      if (row.subtype_opclass_name) {
        params.push(`subtype_opclass = ${row.subtype_opclass_name}`);
      }
      if (row.collation_name) {
        params.push(`collation = ${row.collation_name}`);
      }
      if (row.canonical_name) {
        params.push(`canonical = ${row.canonical_name}`);
      }
      if (row.diff_name) {
        params.push(`subtype_diff = ${row.diff_name}`);
      }
      const automaticMultirangeName = row.type_name.includes("range")
        ? row.type_name.replace("range", "multirange")
        : `${row.type_name}_multirange`;
      const hasCustomMultirangeName =
        row.multirange_name &&
        (row.multirange_name !== automaticMultirangeName ||
          row.multirange_schema !== row.schema_name);
      if (hasCustomMultirangeName) {
        params.push(
          `multirange_type_name = ${inspector.qualifyName(row.multirange_name, row.multirange_schema)}`
        );
      }

      const dependencies =
        row.subtype_kind === "d" || row.subtype_kind === "r"
          ? [
              `${row.subtype_kind === "d" ? "domain" : "range"}-type:${row.subtype_schema}.${row.subtype_type_name}`,
            ]
          : [];
      const subtypeSchema = inspector.getUnqualifiedCatalogTypeSchema(
        row.subtype_name,
        row.subtype_schema
      );

      return {
        kind: "range-type" as const,
        key: `range-type:${row.schema_name}.${row.type_name}`,
        name: row.type_name,
        schema: row.schema_name,
        createStatement: `CREATE TYPE ${inspector.qualifyName(row.type_name, row.schema_name)} AS RANGE (${params.join(", ")});`,
        dropStatement: `DROP TYPE IF EXISTS ${inspector.qualifyName(row.type_name, row.schema_name)} RESTRICT;`,
        ...(dependencies.length > 0 ? { dependencies } : {}),
        typeDefinition: {
          kind: "range" as const,
          subtype: row.subtype_name,
          ...(subtypeSchema ? { subtypeSchema } : {}),
          ...(row.subtype_opclass_bare_name
            ? {
                subtypeOperatorClass: {
                  name: row.subtype_opclass_bare_name,
                  schema: row.subtype_opclass_schema,
                },
                ...(row.subtype_opclass_is_default
                  ? { subtypeOperatorClassIsDefault: true }
                  : {}),
              }
            : {}),
          ...(row.collation_bare_name
            ? {
                collation: {
                  name: row.collation_bare_name,
                  schema: row.collation_schema,
                },
              }
            : {}),
          ...(row.canonical_bare_name
            ? {
                canonicalFunction: {
                  name: row.canonical_bare_name,
                  schema: row.canonical_schema,
                },
              }
            : {}),
          ...(row.diff_bare_name
            ? {
                subtypeDiffFunction: {
                  name: row.diff_bare_name,
                  schema: row.diff_schema,
                },
              }
            : {}),
          ...(hasCustomMultirangeName
            ? {
                multirangeTypeName: {
                  name: row.multirange_name,
                  schema: row.multirange_schema,
                },
              }
            : {}),
        },
        ...(row.attribute_dependents?.length > 0
          ? { attributeDependents: row.attribute_dependents }
          : {}),
        ...(row.type_dependents?.length > 0
          ? { typeDependents: row.type_dependents }
          : {}),
        ...(row.routine_dependents?.length > 0
          ? { routineDependents: row.routine_dependents }
          : {}),
        ...(row.catalog_dependents?.length > 0
          ? { catalogDependents: row.catalog_dependents }
          : {}),
      };
    });
  }

  private async getCurrentForeignServerObjects(client: Client): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        srvname as server_name,
        fdw.fdwname as fdw_name,
        pg_get_userbyid(srvowner) as owner_name,
        srvtype as server_type,
        srvversion as server_version,
        srvoptions as server_options
      FROM pg_foreign_server s
      JOIN pg_foreign_data_wrapper fdw ON fdw.oid = s.srvfdw
      ORDER BY srvname
    `);

    return result.rows.map((row: any) => {
      const foreignServerDefinition = {
        foreignDataWrapper: row.fdw_name,
        owner: row.owner_name,
        ...(typeof row.server_type === "string"
          ? { type: row.server_type }
          : {}),
        ...(typeof row.server_version === "string"
          ? { version: row.server_version }
          : {}),
        options: parsePostgresForeignServerCatalogOptions(
          row.server_options,
          row.server_name
        ),
      };
      return {
        kind: "foreign-server" as const,
        key: `foreign-server:${row.server_name}`,
        name: row.server_name,
        createStatement: renderPostgresForeignServerCreate(
          row.server_name,
          foreignServerDefinition
        ),
        dropStatement: `DROP SERVER IF EXISTS ${this.quoteIdent(row.server_name)} RESTRICT;`,
        foreignServerDefinition,
      };
    });
  }

  private async getCurrentConstraintTriggerObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        t.tgname as trigger_name,
        c.relname as table_name,
        n.nspname as schema_name,
        t.tgenabled as trigger_enabled,
        p.proname as function_name,
        fn.nspname as function_schema,
        pg_get_triggerdef(t.oid) as trigger_definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace fn ON fn.oid = p.pronamespace
      WHERE n.nspname = ANY($1::text[])
        AND NOT t.tgisinternal
        AND t.tgconstraint <> 0
        AND t.tgparentid = 0
      ORDER BY n.nspname, c.relname, t.tgname
    `, [schemas]);

    return result.rows.map((row: any) => {
      const enabled = getPostgresTriggerMode(
        row.trigger_enabled,
        `constraint trigger ${row.schema_name}.${row.table_name}.${row.trigger_name}`
      );
      return {
        kind: "constraint-trigger" as const,
        key: `constraint-trigger:${row.schema_name}.${row.table_name}.${row.trigger_name}`,
        name: row.trigger_name,
        schema: row.schema_name,
        createStatement: this.ensureStatement(row.trigger_definition),
        dropStatement: `DROP TRIGGER IF EXISTS ${this.quoteIdent(row.trigger_name)} ON ${this.qualifyName(row.table_name, row.schema_name)};`,
        triggerTable: {
          name: row.table_name,
          schema: row.schema_name,
        },
        ...(row.function_name
          ? {
              triggerFunction: {
                name: row.function_name,
                ...(row.function_schema
                  ? { schema: row.function_schema }
                  : {}),
              },
            }
          : {}),
        ...(enabled ? { triggerEnabled: enabled } : {}),
      };
    });
  }

  private async getCurrentEventTriggerObjects(client: Client): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        e.evtname as trigger_name,
        e.evtevent as event_name,
        e.evttags as trigger_tags,
        e.evtenabled as trigger_enabled,
        p.proname as function_name,
        n.nspname as function_schema
      FROM pg_event_trigger e
      JOIN pg_proc p ON p.oid = e.evtfoid
      JOIN pg_namespace n ON n.oid = p.pronamespace
      ORDER BY e.evtname
    `);

    return result.rows.map((row: any) => {
      const tagClause = Array.isArray(row.trigger_tags) && row.trigger_tags.length > 0
        ? ` WHEN TAG IN (${row.trigger_tags.map((tag: string) => this.quoteLiteral(tag)).join(", ")})`
        : "";
      const enabled = getPostgresTriggerMode(
        row.trigger_enabled,
        `event trigger ${row.trigger_name}`
      );
      return {
        kind: "event-trigger" as const,
        key: `event-trigger:${row.trigger_name}`,
        name: row.trigger_name,
        createStatement: `CREATE EVENT TRIGGER ${this.quoteIdent(row.trigger_name)} ON ${row.event_name}${tagClause} EXECUTE FUNCTION ${this.qualifyName(row.function_name, row.function_schema)}();`,
        dropStatement: `DROP EVENT TRIGGER IF EXISTS ${this.quoteIdent(row.trigger_name)};`,
        ...(row.function_name
          ? {
              triggerFunction: {
                name: row.function_name,
                ...(row.function_schema
                  ? { schema: row.function_schema }
                  : {}),
              },
            }
          : {}),
        ...(enabled ? { triggerEnabled: enabled } : {}),
      };
    });
  }

  private async getCurrentRoleObjects(client: Client): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        rolname as role_name,
        rolcanlogin as can_login,
        rolsuper as is_superuser,
        rolcreatedb as can_create_db,
        rolcreaterole as can_create_role,
        rolinherit as can_inherit,
        rolreplication as can_replicate,
        rolbypassrls as can_bypass_rls,
        rolconnlimit as connection_limit
      FROM pg_roles
      WHERE rolname !~ '^pg_'
        AND rolname <> 'public'
      ORDER BY rolname
    `);

    return result.rows.map((row: any) => {
      const definition: PostgresRoleDefinition = {
        login: row.can_login,
        superuser: row.is_superuser,
        createDatabase: row.can_create_db,
        createRole: row.can_create_role,
        inherit: row.can_inherit,
        replication: row.can_replicate,
        bypassRowLevelSecurity: row.can_bypass_rls,
        connectionLimit: row.connection_limit,
      };
      return {
        kind: "role" as const,
        key: `role:${row.role_name}`,
        name: row.role_name,
        createStatement: renderPostgresRoleCreate(row.role_name, definition),
        dropStatement: renderPostgresRoleDrop(row.role_name),
        roleDefinition: definition,
      };
    });
  }

  private async getCurrentGrantObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const [classResult, schemaResult, serverResult] = await Promise.all([
      client.query(`
        SELECT
          n.nspname as schema_name,
          c.relname as object_name,
          CASE
            WHEN c.relkind = 'S' THEN 'SEQUENCE'
            ELSE 'TABLE'
          END as object_type,
          COALESCE(grantee.rolname, 'PUBLIC') as grantee_name,
          privilege.grantee = 0 as grantee_is_public,
          privilege.privilege_type,
          privilege.is_grantable,
          pg_get_userbyid(privilege.grantor) as grantor_name,
          pg_get_userbyid(c.relowner) as owner_name,
          EXISTS (
            SELECT 1
            FROM aclexplode(
              acldefault(
                CASE
                  WHEN c.relkind = 'S' THEN 's'::"char"
                  ELSE 'r'::"char"
                END,
                c.relowner
              )
            ) default_privilege
            WHERE default_privilege.grantor = privilege.grantor
              AND default_privilege.grantee = privilege.grantee
              AND default_privilege.privilege_type = privilege.privilege_type
              AND default_privilege.is_grantable = privilege.is_grantable
          ) as is_implicit_default
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL aclexplode(c.relacl) as privilege ON c.relacl IS NOT NULL
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
        WHERE n.nspname = ANY($1::text[])
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND d.objid IS NULL
        ORDER BY n.nspname, c.relname, grantee_name, privilege.privilege_type
      `, [schemas]),
      client.query(`
        SELECT
          n.nspname as schema_name,
          COALESCE(grantee.rolname, 'PUBLIC') as grantee_name,
          privilege.grantee = 0 as grantee_is_public,
          privilege.privilege_type,
          privilege.is_grantable,
          pg_get_userbyid(privilege.grantor) as grantor_name,
          pg_get_userbyid(n.nspowner) as owner_name,
          (
            EXISTS (
              SELECT 1
              FROM aclexplode(acldefault('n', n.nspowner)) default_privilege
              WHERE default_privilege.grantor = privilege.grantor
                AND default_privilege.grantee = privilege.grantee
                AND default_privilege.privilege_type = privilege.privilege_type
                AND default_privilege.is_grantable = privilege.is_grantable
            )
            OR (
              -- initdb grants PUBLIC access to the standard public schema:
              -- USAGE on PostgreSQL 15+, and USAGE plus CREATE before 15.
              n.nspname = 'public'
              AND privilege.grantee = 0
              AND privilege.grantor = n.nspowner
              AND NOT privilege.is_grantable
              AND (
                privilege.privilege_type = 'USAGE'
                OR (
                  privilege.privilege_type = 'CREATE'
                  AND current_setting('server_version_num')::integer < 150000
                )
              )
            )
          ) as is_implicit_default
        FROM pg_namespace n
        JOIN LATERAL aclexplode(n.nspacl) as privilege ON n.nspacl IS NOT NULL
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        WHERE n.nspname = ANY($1::text[])
        ORDER BY n.nspname, grantee_name, privilege.privilege_type
      `, [schemas]),
      client.query(`
        SELECT
          s.srvname as server_name,
          COALESCE(grantee.rolname, 'PUBLIC') as grantee_name,
          privilege.grantee = 0 as grantee_is_public,
          privilege.privilege_type,
          privilege.is_grantable,
          pg_get_userbyid(privilege.grantor) as grantor_name,
          pg_get_userbyid(s.srvowner) as owner_name,
          EXISTS (
            SELECT 1
            FROM aclexplode(acldefault('F', s.srvowner)) default_privilege
            WHERE default_privilege.grantor = privilege.grantor
              AND default_privilege.grantee = privilege.grantee
              AND default_privilege.privilege_type = privilege.privilege_type
              AND default_privilege.is_grantable = privilege.is_grantable
          ) as is_implicit_default
        FROM pg_foreign_server s
        JOIN LATERAL aclexplode(s.srvacl) as privilege ON s.srvacl IS NOT NULL
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        ORDER BY s.srvname, grantee_name, privilege.privilege_type
      `),
    ]);

    const objects: SqlObject[] = [];

    for (const row of classResult.rows) {
      if (!isSupportedPostgresGrantPrivilege(
        row.object_type,
        row.privilege_type
      )) {
        continue;
      }
      objects.push(this.buildGrantObject(
        row.object_type,
        row.object_name,
        row.schema_name,
        row
      ));
    }

    for (const row of schemaResult.rows) {
      if (!isSupportedPostgresGrantPrivilege("SCHEMA", row.privilege_type)) {
        continue;
      }
      objects.push(this.buildGrantObject(
        "SCHEMA",
        row.schema_name,
        row.schema_name,
        row
      ));
    }

    for (const row of serverResult.rows) {
      if (!isSupportedPostgresGrantPrivilege(
        "FOREIGN SERVER",
        row.privilege_type
      )) {
        continue;
      }
      objects.push(this.buildGrantObject(
        "FOREIGN SERVER",
        row.server_name,
        undefined,
        row
      ));
    }

    return objects;
  }

  private async getCurrentDefaultPrivilegeObjects(
    client: Client
  ): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        owner.rolname AS owner_name,
        namespace.nspname AS schema_name,
        defaults.defaclobjtype AS object_type,
        privilege.privilege_type,
        privilege.grantee = 0 AS grantee_is_public,
        COALESCE(grantee.rolname, 'PUBLIC') AS grantee_name,
        privilege.actual_granted,
        privilege.is_grantable,
        privilege.baseline_granted,
        pg_get_userbyid(privilege.actual_grantor) AS grantor_name
      FROM pg_default_acl defaults
      JOIN pg_roles owner ON owner.oid = defaults.defaclrole
      LEFT JOIN pg_namespace namespace
        ON namespace.oid = defaults.defaclnamespace
      JOIN LATERAL (
        SELECT
          COALESCE(actual.grantee, baseline.grantee) AS grantee,
          COALESCE(
            actual.privilege_type,
            baseline.privilege_type
          ) AS privilege_type,
          actual.privilege_type IS NOT NULL AS actual_granted,
          COALESCE(actual.is_grantable, false) AS is_grantable,
          baseline.privilege_type IS NOT NULL AS baseline_granted,
          actual.grantor AS actual_grantor
        FROM aclexplode(defaults.defaclacl) actual
        FULL JOIN aclexplode(
          CASE
            WHEN defaults.defaclnamespace = 0 THEN
              acldefault(
                CASE
                  WHEN defaults.defaclobjtype = 'S' THEN 's'::"char"
                  ELSE defaults.defaclobjtype
                END,
                defaults.defaclrole
              )
            ELSE NULL::aclitem[]
          END
        ) baseline
          ON baseline.grantor = actual.grantor
          AND baseline.grantee = actual.grantee
          AND baseline.privilege_type = actual.privilege_type
        WHERE actual.privilege_type IS NULL
          OR baseline.privilege_type IS NULL
          OR actual.is_grantable <> baseline.is_grantable
      ) privilege ON true
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      ORDER BY
        owner.rolname,
        namespace.nspname NULLS FIRST,
        defaults.defaclobjtype,
        privilege.grantee,
        privilege.privilege_type
    `);
    const objects: SqlObject[] = [];
    for (const row of result.rows) {
      const objectType = postgresDefaultPrivilegeObjectTypeFromCatalog(
        row.object_type
      );
      if (
        !objectType ||
        !isSupportedPostgresDefaultPrivilege(
          objectType,
          row.privilege_type
        )
      ) {
        continue;
      }
      if (row.grantor_name && row.grantor_name !== row.owner_name) {
        throw new ValidationError(
          `PostgreSQL default ${objectType} privilege ${row.privilege_type} for role '${row.owner_name}' was granted by non-owner role '${row.grantor_name}', which TerraDB cannot reconcile safely`,
          "default-privilege",
          row.owner_name
        );
      }
      const definition: PostgresDefaultPrivilegeDefinition = {
        owner: row.owner_name,
        objectType,
        ...(row.schema_name ? { schema: row.schema_name } : {}),
        grantee: row.grantee_name,
        granteeIsPublic: row.grantee_is_public,
        privilege: row.privilege_type,
        granted: row.actual_granted,
        grantable: row.actual_granted && row.is_grantable,
        baselineGranted: row.baseline_granted,
      };
      const createStatement = renderPostgresDefaultPrivilegeState(definition);
      objects.push({
        kind: "default-privilege",
        key: postgresDefaultPrivilegeKey(definition),
        name: createStatement,
        ...(definition.schema ? { schema: definition.schema } : {}),
        createStatement,
        dropStatement: renderPostgresDefaultPrivilegeRestore(definition),
        defaultPrivilegeDefinition: definition,
        dependencies: [
          `role:${definition.owner}`,
          ...(definition.granteeIsPublic
            ? []
            : [`role:${definition.grantee}`]),
        ],
      });
    }
    return objects;
  }

  private async getTableColumnDefinitions(
    client: Client,
    tableName: string,
    tableSchema: string
  ): Promise<Array<{
    name: string;
    definition: string;
    typeSchema?: string;
  }>> {
    const result = await client.query(
      `
        SELECT
          a.attname as column_name,
          format_type(a.atttypid, a.atttypmod) as pg_type,
          column_type_namespace.nspname as column_type_schema,
          NOT a.attnotnull as is_nullable,
          pg_get_expr(ad.adbin, ad.adrelid) as column_default,
          a.attgenerated,
          a.attidentity,
          CASE
            WHEN a.attgenerated != '' THEN pg_get_expr(ad.adbin, ad.adrelid)
            ELSE NULL
          END as generation_expression,
          identity_sequence.sequence_schema as identity_sequence_schema,
          identity_sequence.sequence_name as identity_sequence_name,
          identity_sequence.sequence_persistence as identity_sequence_persistence,
          identity_sequence.seqstart as identity_start,
          identity_sequence.seqincrement as identity_increment,
          identity_sequence.seqmin as identity_min_value,
          identity_sequence.seqmax as identity_max_value,
          identity_sequence.seqcache as identity_cache,
          identity_sequence.seqcycle as identity_cycle,
          column_collation_namespace.nspname as column_collation_schema,
          column_collation.collname as column_collation_name,
          CASE
            WHEN a.attstorage <> column_type.typstorage THEN a.attstorage
            ELSE NULL
          END as column_storage,
          column_type.typstorage as column_default_storage,
          a.attcompression as column_compression
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        JOIN pg_class cls ON cls.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        ${IDENTITY_SEQUENCE_JOIN_SQL}
        ${COLUMN_COLLATION_JOIN_SQL}
        WHERE cls.relname = $1
          AND n.nspname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
      [tableName, tableSchema]
    );

    const inspector = this;
    return result.rows.map(function mapColumn(row: any) {
      const typeSchema = inspector.getUnqualifiedCatalogTypeSchema(
        row.pg_type,
        row.column_type_schema
      );
      return {
        name: row.column_name,
        definition: inspector.buildColumnDefinition(row),
        ...(typeSchema ? { typeSchema } : {}),
      };
    });
  }

  private async getTableConstraintDefinitions(client: Client, relationOid: number): Promise<string[]> {
    const result = await client.query(`
      SELECT
        conname,
        pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = $1
        AND contype <> 'n'
      ORDER BY conname
    `, [relationOid]);

    return result.rows.map((row: any) => {
      return `CONSTRAINT ${this.quoteIdent(row.conname)} ${row.definition}`;
    });
  }

  private buildColumnDefinition(row: any): string {
    const type = this.qualifySerialNamedCustomType(
      row.pg_type,
      row.column_type_schema,
      false
    );
    const parts = [this.quoteIdent(row.column_name), type];

    const collation = this.buildColumnCollation(row);
    if (collation) {
      parts.push(`COLLATE ${renderCollationName(collation)}`);
    }

    const identity = this.buildIdentityColumn(row);
    if (identity) {
      parts.push(renderIdentityClause(identity));
      return parts.join(" ");
    }

    if (row.attgenerated && row.attgenerated !== "") {
      const stored = row.attgenerated === "s" ? "STORED" : "VIRTUAL";
      parts.push(`GENERATED ALWAYS AS (${row.generation_expression}) ${stored}`);
      return parts.join(" ");
    }

    if (!row.is_nullable) {
      parts.push("NOT NULL");
    }
    if (row.column_default) {
      parts.push(`DEFAULT ${row.column_default}`);
    }

    return parts.join(" ");
  }

  private buildColumnCollation(row: any): Column['collation'] | undefined {
    if (!row.column_collation_name) return undefined;
    return {
      name: String(row.column_collation_name),
      schema: row.column_collation_schema
        ? String(row.column_collation_schema)
        : undefined,
    };
  }

  private buildIdentityColumn(row: any): Column['identity'] | undefined {
    if (!row.attidentity) return undefined;

    const toOptionalString = function toOptionalString(
      value: unknown
    ): string | undefined {
      return value === null || value === undefined ? undefined : String(value);
    };
    const sequenceName = row.identity_sequence_name
      ? {
          name: String(row.identity_sequence_name),
          schema: row.identity_sequence_schema
            ? String(row.identity_sequence_schema)
            : undefined,
        }
      : undefined;

    return {
      generation: row.attidentity === 'a' ? 'ALWAYS' : 'BY DEFAULT',
      sequenceName,
      sequencePersistence: getIdentitySequencePersistence(
        row.identity_sequence_persistence
      ),
      start: toOptionalString(row.identity_start),
      increment: toOptionalString(row.identity_increment),
      minValue: toOptionalString(row.identity_min_value),
      maxValue: toOptionalString(row.identity_max_value),
      cache: toOptionalString(row.identity_cache),
      cycle:
        row.identity_cycle === null || row.identity_cycle === undefined
          ? undefined
          : Boolean(row.identity_cycle),
    };
  }

  private buildGrantObject(
    objectType: PostgresGrantObjectType,
    objectName: string,
    schemaName: string | undefined,
    row: PostgresGrantCatalogRow
  ): SqlObject {
    if (
      row.grantor_name &&
      row.owner_name &&
      row.grantor_name !== row.owner_name
    ) {
      throw new ValidationError(
        `PostgreSQL ${objectType} privilege ${row.privilege_type} on '${objectName}' was granted by non-owner role '${row.grantor_name}', which TerraDB cannot revoke safely without managing grantor provenance`,
        "grant",
        objectName
      );
    }
    const definition: PostgresGrantDefinition = {
      objectType,
      objectName,
      ...(schemaName ? { schema: schemaName } : {}),
      grantee: row.grantee_name,
      granteeIsPublic: row.grantee_is_public === true,
      privilege: row.privilege_type,
      grantable: row.is_grantable,
      implicitDefault: row.is_implicit_default === true,
    };
    const createStatement = renderPostgresGrant(definition);
    return {
      kind: "grant",
      key: postgresGrantKey(definition),
      name: createStatement,
      schema: schemaName,
      createStatement,
      dropStatement: renderPostgresGrantRevoke(definition),
      grantDefinition: definition,
    };
  }

  private formatOptions(options: string[] | null): string {
    if (!options || options.length === 0) {
      return "";
    }

    return options.map((option) => {
      const match = option.match(/^([^=]+)=(.*)$/);
      if (!match) {
        return option;
      }
      return `${match[1] || ""} ${this.quoteLiteral(match[2] || "")}`;
    }).join(", ");
  }

  private ensureStatement(statement: string): string {
    const trimmed = statement.trim();
    return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
  }

  private quoteIdent(value: string): string {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  private qualifySerialNamedCustomType(
    type: string,
    typeSchema: string | undefined,
    isStructuralSerial: boolean
  ): string {
    if (
      isStructuralSerial ||
      !typeSchema ||
      typeSchema === "pg_catalog"
    ) {
      return type;
    }

    const arrayMatch = type.match(/^(.+?)(\[\])+$/);
    const baseType = arrayMatch?.[1] || type;
    if (!isPostgresSerialType(baseType)) {
      return type;
    }

    const schema = /^[a-z_][a-z0-9_$]*$/.test(typeSchema)
      ? typeSchema
      : this.quoteIdent(typeSchema);
    return `${schema}.${type}`;
  }

  private getUnqualifiedCatalogTypeSchema(
    type: string,
    typeSchema: string | undefined
  ): string | undefined {
    if (!typeSchema || typeSchema === "pg_catalog") {
      return undefined;
    }
    return parseTypeReference(type)?.length === 1
      ? typeSchema
      : undefined;
  }

  private quoteLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private quoteRole(value: string): string {
    return value === "PUBLIC" ? "PUBLIC" : this.quoteIdent(value);
  }

  private qualifyName(name: string, schema?: string): string {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(name)}` : this.quoteIdent(name);
  }

  // Helper method to analyze view dependencies
  async getViewDependencies(client: Client, viewName: string, viewSchema: string = "public"): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT DISTINCT
          CASE
            WHEN referenced_table_schema = 'public' THEN referenced_table_name
            ELSE referenced_table_schema || '.' || referenced_table_name
          END as dependency
        FROM information_schema.view_table_usage
        WHERE view_schema = $1 AND view_name = $2
        ORDER BY dependency
      `, [viewSchema, viewName]);

      return result.rows.map(row => row.dependency);
    } catch (error) {
      // If the query fails (e.g., permissions), return empty array
      return [];
    }
  }

  async getFunctionDependencies(
    client: Client,
    functionName: string,
    functionSchema: string = "public"
  ): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT DISTINCT
          CASE
            WHEN ref_ns.nspname = 'public' THEN ref_class.relname
            ELSE ref_ns.nspname || '.' || ref_class.relname
          END as dependency
        FROM pg_proc p
        JOIN pg_namespace proc_ns ON proc_ns.oid = p.pronamespace
        JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass
        JOIN pg_class ref_class ON ref_class.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
        JOIN pg_namespace ref_ns ON ref_ns.oid = ref_class.relnamespace
        WHERE proc_ns.nspname = $1
          AND p.proname = $2
        ORDER BY dependency
      `, [functionSchema, functionName]);

      return result.rows.map(row => row.dependency);
    } catch (error) {
      return [];
    }
  }
}
