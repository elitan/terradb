import type { DatabaseDialect, ParsedSchema } from "../../providers/types";
import type { MigrationContext } from "../../types/migration";
import type { Column, Function, Table, View } from "../../types/schema";
import { getDefaultFunctionCost } from "../../utils/function-cost";
import { normalizeIdentityColumn } from "../../utils/identity";
import { normalizeRoutineType } from "./handlers/routine-handler-utils";

const SERIAL_TYPE_BY_INTEGER_TYPE: Record<string, string> = {
  smallint: "SMALLSERIAL",
  integer: "SERIAL",
  bigint: "BIGSERIAL",
};

export function createEmptySchemaState(): ParsedSchema {
  return {
    tables: [],
    enums: [],
    compositeTypes: [],
    views: [],
    functions: [],
    procedures: [],
    triggers: [],
    sequences: [],
    extensions: [],
    schemas: [],
    comments: [],
    sqlObjects: [],
  };
}

function getOwnedByKey(ownedBy: string, sequenceSchema?: string): string {
  const parts = splitQualifiedName(ownedBy);
  if (parts.length === 2) {
    parts.unshift(sequenceSchema || "public");
  }
  return parts.join("\u0000");
}

function getColumnKey(table: Table, column: Column): string {
  return [table.schema || "public", table.name, column.name].join("\u0000");
}

function splitQualifiedName(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      if (inQuote && value[index + 1] === '"') {
        current += '"';
        index++;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (char === "." && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * PostgreSQL expands a serial declaration into an integer column, an owned
 * sequence, and a nextval default. The planner reconciles an inspected
 * expansion only against a desired serial pseudo-type, so the pulled model
 * collapses a canonical expansion back into that declaration.
 */
function collapseSerialColumns(state: ParsedSchema): ParsedSchema {
  const collapsedColumnKeys = new Set<string>();
  const tables = state.tables.map(function collapseTable(table) {
    let changed = false;
    const columns = table.columns.map(function collapseColumn(column) {
      const serialType = SERIAL_TYPE_BY_INTEGER_TYPE[column.type.toLowerCase()];
      if (!column.serial || !column.serialSequenceOptionsMatch || !serialType) {
        return column;
      }
      changed = true;
      collapsedColumnKeys.add(getColumnKey(table, column));
      const {
        default: _default,
        serial: _serial,
        serialSequenceOptionsMatch: _serialSequenceOptionsMatch,
        typeSchema: _typeSchema,
        ...rest
      } = column;
      return { ...rest, type: serialType, nullable: false };
    });
    return changed ? { ...table, columns } : table;
  });

  const sequences = state.sequences.filter(function isStandalone(sequence) {
    return !sequence.ownedBy ||
      !collapsedColumnKeys.has(getOwnedByKey(sequence.ownedBy, sequence.schema));
  });

  return { ...state, tables, sequences };
}

/**
 * Identity options that match what PostgreSQL would choose for a bare
 * `GENERATED ... AS IDENTITY` are omitted. An omitted option is not compared
 * by the planner, and a fresh database receives the same default.
 */
function omitDefaultIdentityOptions(
  table: Table,
  context: MigrationContext
): Table {
  let changed = false;
  const columns = table.columns.map(function normalizeColumn(column) {
    if (!column.identity) {
      return column;
    }
    const defaults = normalizeIdentityColumn(column.type, {
      generation: column.identity.generation,
    });
    const identity = { ...column.identity };
    for (const option of ["increment", "minValue", "maxValue", "start", "cache"] as const) {
      if (identity[option] !== undefined && identity[option] === defaults[option]) {
        delete identity[option];
      }
    }
    if (identity.cycle === false) {
      delete identity.cycle;
    }
    const defaultPersistence =
      table.unlogged && (context.postgresVersionNum || 0) >= 150000
        ? "unlogged"
        : "logged";
    if (identity.sequencePersistence === defaultPersistence) {
      delete identity.sequencePersistence;
    }
    const defaultSequenceName = `${table.name}_${column.name}_seq`;
    if (
      identity.sequenceName &&
      identity.sequenceName.name === defaultSequenceName &&
      Buffer.byteLength(defaultSequenceName) <= 63 &&
      (identity.sequenceName.schema || "public") === (table.schema || "public")
    ) {
      delete identity.sequenceName;
    }
    changed = true;
    return { ...column, identity };
  });
  return changed ? { ...table, columns } : table;
}

function omitDefaultAccessMethod<T extends Table | View>(
  relation: T,
  defaultAccessMethod: string
): T {
  if (relation.accessMethod !== defaultAccessMethod) {
    return relation;
  }
  const { accessMethod: _accessMethod, ...rest } = relation;
  return rest as T;
}

/**
 * Catalog inspection spells out every routine option. Options equal to the
 * PostgreSQL defaults are omitted so the file reads like hand-written DDL;
 * the planner normalizes an omitted option to the same default.
 */
function omitDefaultRoutineOptions(func: Function): Function {
  const result = { ...func };
  if (result.volatility === "VOLATILE") {
    delete result.volatility;
  }
  if (result.parallel === "UNSAFE") {
    delete result.parallel;
  }
  if (result.leakproof === false) {
    delete result.leakproof;
  }
  if (result.securityDefiner === false) {
    delete result.securityDefiner;
  }
  if (result.strict === false) {
    delete result.strict;
  }
  if (result.cost === getDefaultFunctionCost(result.language)) {
    delete result.cost;
  }
  const returnsSet = normalizeRoutineType(result.returnType)
    .toUpperCase()
    .startsWith("SETOF ");
  if (!returnsSet || result.rows === 1000) {
    delete result.rows;
  }
  return result;
}

/**
 * Converts inspected catalog state into the declarative model that the
 * desired-schema parser produces for equivalent SQL.
 */
export interface PullNormalizationOptions {
  context?: MigrationContext;
  /** Roles that own the standard public schema right after initdb. */
  bootstrapPublicSchemaOwners?: string[];
}

export function normalizePulledSchema(
  state: ParsedSchema,
  dialect: DatabaseDialect,
  options: PullNormalizationOptions = {}
): ParsedSchema {
  const context = options.context ?? {};
  const bootstrapOwners = new Set(options.bootstrapPublicSchemaOwners ?? []);
  if (dialect !== "postgres") {
    return state;
  }
  const collapsed = collapseSerialColumns(state);
  const defaultAccessMethod = context.defaultTableAccessMethod || "heap";
  return {
    ...collapsed,
    // The standard public schema always exists; declaring it only pins an
    // owner, which is redundant for its initdb owner.
    schemas: collapsed.schemas.filter(function isDeclarationNeeded(schema) {
      return schema.name !== "public" ||
        schema.owner === undefined ||
        !bootstrapOwners.has(schema.owner);
    }),
    tables: collapsed.tables.map(function normalizeTable(table) {
      return omitDefaultIdentityOptions(
        omitDefaultAccessMethod(table, defaultAccessMethod),
        context
      );
    }),
    views: collapsed.views.map(function normalizeView(view) {
      return omitDefaultAccessMethod(view, defaultAccessMethod);
    }),
    functions: collapsed.functions.map(omitDefaultRoutineOptions),
  };
}

export function toDesiredStatements(statements: string[]): string[] {
  return statements.map(function normalizeStatement(statement) {
    const trimmed = statement.trim();
    return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
  });
}

export interface PulledSchemaHeader {
  dialect: DatabaseDialect;
  schemas: string[];
}

export function renderPulledSchema(
  statements: string[],
  header: PulledSchemaHeader
): string {
  const lines = [
    `-- Generated by terradb pull from a ${header.dialect === "postgres" ? "PostgreSQL" : "SQLite"} database.`,
  ];
  if (header.dialect === "postgres") {
    lines.push(`-- Managed schemas: ${header.schemas.join(", ")}`);
  }
  lines.push(
    "-- Verified: planning this file against the source database produces no changes."
  );

  if (statements.length === 0) {
    return `${lines.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n\n${statements.join("\n\n")}\n`;
}
