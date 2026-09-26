/**
 * Schema Parser
 *
 * Main parser class that orchestrates parsing of SQL schema definitions.
 * Handles file I/O and coordinates all sub-parsers.
 */

import { readFileSync, existsSync } from "fs";
import { deparseSync, parse, parseSync, loadModule } from "pgsql-parser";
import { Logger } from "../../../utils/logger";
import { parseCreateTable } from "./tables/table-parser";
import { parseCreateIndex } from "./index-parser";
import { parseCreateType } from "./enum-parser";
import { parseCreateCompositeType } from "./composite-type-parser";
import { parseCreateView, parseCreateMaterializedView } from "./view-parser";
import { parseCreateFunction } from "./function-parser";
import { parseCreateProcedure } from "./procedure-parser";
import { parseCreateTrigger } from "./trigger-parser";
import { parseCreateSequence } from "./sequence-parser";
import { parseCreateExtension } from "./extension-parser";
import { parseCreateSchema } from "./schema-definition-parser";
import {
  parseCheckConstraint,
  parseForeignKey,
} from "./tables/constraint-parser";
import {
  extractColumnCollation,
  extractDataType,
} from "./tables/column-parser";
import type {
  Table,
  Index,
  EnumType,
  CompositeType,
  View,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
  SqlObject,
  QualifiedName,
  PostgresPolicyDefinition,
  PostgresPolicyRole,
} from "../../../types/schema";
import { ParserError } from "../../../types/errors";
import { DEFAULT_COLLATION } from "../../../utils/collation";
import {
  getIndexTermCollation,
  synchronizeLegacyIndexFields,
} from "../../../utils/postgres-index";
import { qualifyDeclaredRoutineTypes } from "./routine-type-canonicalizer";
import { toPgAstNode } from "./pgsql-ast";
import {
  isTableTriggerModeSubtype,
  mergePendingTriggerModes,
  parseAlterEventTriggerMode,
  parseAlterTableTriggerModes,
  rejectDuplicateTriggerDeclarations,
  rejectUnsupportedBulkTriggerAlter,
  type PendingTriggerMode,
} from "./trigger-mode-parser";
import {
  isReplicaIdentitySubtype,
  mergePendingReplicaIdentities,
  parseAlterTableReplicaIdentities,
  type PendingReplicaIdentity,
} from "./replica-identity-parser";
import {
  isClusteringSubtype,
  mergePendingClusteringChoices,
  parseAlterRelationClustering,
  type PendingClusteringChoice,
} from "./clustering-parser";
import {
  isPostgresStatisticsSubtype,
  mergePendingPostgresStatistics,
  parseAlterPostgresStatistics,
  type PendingPostgresStatisticsChange,
} from "./column-statistics-parser";
import {
  renderPostgresForeignServerCreate,
  sortPostgresForeignServerOptions,
} from "../../../utils/postgres-foreign-server";
import { isPostgresSerialType } from "../../../utils/sql";
import {
  mergeForeignServerOwners,
  parseForeignServerOwner,
  type PendingForeignServerOwner,
} from "./foreign-server-owner-parser";
import { parseForeignServerRemovals } from "./foreign-server-removal-parser";
import { parsePostgresRole } from "./role-parser";
import { parsePostgresRoleRemovals } from "./role-removal-parser";
import { parsePostgresGrants } from "./grant-parser";
import { parsePostgresDefaultPrivileges } from "./default-privilege-parser";

let wasmInitialization: Promise<void> | undefined;

type PendingTableConstraint = {
  tableName: string;
  schemaName?: string;
} & (
  | {
      kind: "foreign_key";
      constraint: NonNullable<Table["foreignKeys"]>[number];
    }
  | {
      kind: "check";
      constraint: NonNullable<Table["checkConstraints"]>[number];
  }
);

const POSTGRES_SERIAL_CONFLICTING_CLAUSES: ReadonlyMap<string, string> = new Map([
  ["CONSTR_NULL", "NULL"],
  ["CONSTR_DEFAULT", "DEFAULT"],
  ["CONSTR_IDENTITY", "identity"],
  ["CONSTR_GENERATED", "generated"],
]);

function getPostgresStatementSource(sql: string, wrapper: any): string {
  const bytes = Buffer.from(sql, "utf8");
  const location = Number(wrapper?.stmt_location) || 0;
  const length = Number(wrapper?.stmt_len) || bytes.length - location;
  return bytes.subarray(location, location + length).toString("utf8");
}

export function hasEmptyForeignServerClause(
  statement: string,
  keyword: "TYPE" | "VERSION"
): boolean {
  let index = 0;
  while (index < statement.length) {
    const skippedIndex = skipPostgresSpaceAndComments(statement, index);
    if (skippedIndex !== index) {
      index = skippedIndex;
      continue;
    }
    const character = statement[index];
    if (character === "'") {
      index = skipPostgresQuoted(statement, index, "'");
      continue;
    }
    if (character === '"') {
      index = skipPostgresQuoted(statement, index, '"');
      continue;
    }
    const dollarEnd = postgresDollarQuoteEnd(statement, index);
    if (dollarEnd !== undefined) {
      index = dollarEnd;
      continue;
    }
    if (!character || !/[A-Za-z_]/.test(character)) {
      index += 1;
      continue;
    }

    let wordEnd = index + 1;
    while (
      wordEnd < statement.length &&
      /[A-Za-z0-9_$]/.test(statement[wordEnd]!)
    ) {
      wordEnd += 1;
    }
    const word = statement.slice(index, wordEnd).toUpperCase();
    if (word === "FOREIGN") {
      return false;
    }
    if (word === keyword) {
      let valueIndex = skipPostgresSpaceAndComments(statement, wordEnd);
      if (
        (statement[valueIndex] === "E" || statement[valueIndex] === "e") &&
        statement[valueIndex + 1] === "'"
      ) {
        valueIndex += 1;
      } else if (
        (statement[valueIndex] === "U" || statement[valueIndex] === "u") &&
        statement[valueIndex + 1] === "&" &&
        statement[valueIndex + 2] === "'"
      ) {
        valueIndex += 2;
      }
      return statement.slice(valueIndex, valueIndex + 2) === "''";
    }
    index = wordEnd;
  }
  return false;
}

function resolveForeignServerString(
  parsedValue: unknown,
  hasExplicitEmptyValue: boolean
): string | undefined {
  if (typeof parsedValue === "string") {
    return parsedValue;
  }
  if (hasExplicitEmptyValue) {
    return "";
  }
  return undefined;
}

function getPartitionKeyColumnReferences(value: unknown): string[] {
  if (value === null || value === undefined || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(function getReferences(item) {
      return getPartitionKeyColumnReferences(item);
    });
  }

  const node = value as Record<string, any>;
  const fields = node.ColumnRef?.fields;
  if (Array.isArray(fields)) {
    const name = fields.at(-1)?.String?.sval;
    return typeof name === "string" ? [name] : [];
  }
  return Object.values(node).flatMap(function getNestedReferences(item) {
    return getPartitionKeyColumnReferences(item);
  });
}

function skipPostgresSpaceAndComments(statement: string, start: number): number {
  let index = start;
  while (index < statement.length) {
    if (/\s/.test(statement[index]!)) {
      index += 1;
      continue;
    }
    if (statement.slice(index, index + 2) === "--") {
      const lineEnd = statement.indexOf("\n", index + 2);
      index = lineEnd === -1 ? statement.length : lineEnd + 1;
      continue;
    }
    if (statement.slice(index, index + 2) !== "/*") {
      return index;
    }
    let depth = 1;
    index += 2;
    while (index < statement.length && depth > 0) {
      if (statement.slice(index, index + 2) === "/*") {
        depth += 1;
        index += 2;
      } else if (statement.slice(index, index + 2) === "*/") {
        depth -= 1;
        index += 2;
      } else {
        index += 1;
      }
    }
  }
  return index;
}

function skipPostgresQuoted(
  statement: string,
  start: number,
  quote: "'" | '"'
): number {
  let index = start + 1;
  while (index < statement.length) {
    if (statement[index] !== quote) {
      index += 1;
      continue;
    }
    if (statement[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return statement.length;
}

function postgresDollarQuoteEnd(
  statement: string,
  start: number
): number | undefined {
  if (statement[start] !== "$") {
    return undefined;
  }
  const tagMatch = statement.slice(start).match(/^\$[A-Za-z0-9_]*\$/);
  const tag = tagMatch?.[0];
  if (!tag) {
    return undefined;
  }
  const end = statement.indexOf(tag, start + tag.length);
  return end === -1 ? statement.length : end + tag.length;
}

const ROW_SECURITY_SUBTYPES = new Set([
  "AT_EnableRowSecurity",
  "AT_DisableRowSecurity",
  "AT_ForceRowSecurity",
  "AT_NoForceRowSecurity",
]);

const COMMENT_OBJECT_TYPE_MAP: Readonly<
  Partial<Record<string, Comment['objectType']>>
> = {
  OBJECT_TABLE: 'TABLE',
  OBJECT_COLUMN: 'COLUMN',
  OBJECT_VIEW: 'VIEW',
  OBJECT_MATVIEW: 'MATERIALIZED VIEW',
  OBJECT_INDEX: 'INDEX',
  OBJECT_SEQUENCE: 'SEQUENCE',
  OBJECT_SCHEMA: 'SCHEMA',
  OBJECT_TYPE: 'TYPE',
  OBJECT_DOMAIN: 'TYPE',
};

function isRowSecuritySubtype(subtype: unknown): boolean {
  return typeof subtype === "string" && ROW_SECURITY_SUBTYPES.has(subtype);
}

function qualifiedNameFromStringNodes(
  nodes: any[] | undefined,
  defaultSchema?: string
): QualifiedName | undefined {
  const names = (nodes || []).map(function getName(item: any) {
    return item?.String?.sval;
  }).filter(function isName(value: unknown): value is string {
    return typeof value === "string";
  });
  const name = names.at(-1);
  if (!name) {
    return undefined;
  }
  const schema = names.length > 1 ? names.at(-2) : defaultSchema;
  return { name, ...(schema ? { schema } : {}) };
}

function isCanonicalPartitionBoundDatum(datum: any, strategy: string): boolean {
  if (datum?.A_Const) {
    return true;
  }
  if (strategy !== "r" || !datum?.ColumnRef) {
    return false;
  }

  const fields = datum.ColumnRef.fields || [];
  const sentinel = fields.length === 1
    ? fields[0]?.String?.sval?.toLowerCase()
    : undefined;
  return sentinel === "minvalue" || sentinel === "maxvalue";
}

function protectReservedKeywordSegments(sql: string): {
  sql: string;
  segments: string[];
} {
  const segments: string[] = [];
  const output: string[] = [];
  let index = 0;

  function protect(end: number): void {
    const placeholder = `__TERRADB_PROTECTED_SQL_${segments.length}__`;
    segments.push(sql.slice(index, end));
    output.push(placeholder);
    index = end;
  }

  while (index < sql.length) {
    if (sql.slice(index, index + 2) === "--") {
      const lineEnd = sql.indexOf("\n", index + 2);
      protect(lineEnd === -1 ? sql.length : lineEnd);
      continue;
    }
    if (sql.slice(index, index + 2) === "/*") {
      let end = index + 2;
      let depth = 1;
      while (end < sql.length && depth > 0) {
        if (sql.slice(end, end + 2) === "/*") {
          depth += 1;
          end += 2;
        } else if (sql.slice(end, end + 2) === "*/") {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      protect(end);
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      protect(skipPostgresQuoted(sql, index, sql[index] as "'" | '"'));
      continue;
    }
    const dollarEnd = postgresDollarQuoteEnd(sql, index);
    if (dollarEnd !== undefined) {
      protect(dollarEnd);
      continue;
    }
    output.push(sql[index]!);
    index += 1;
  }

  return { sql: output.join(""), segments };
}

function restoreReservedKeywordSegments(
  sql: string,
  segments: string[]
): string {
  for (const [index, segment] of segments.entries()) {
    sql = sql.replace(
      `__TERRADB_PROTECTED_SQL_${index}__`,
      function restoreSegment() {
        return segment;
      }
    );
  }
  return sql;
}

export class SchemaParser {
  private async ensureWasmLoaded() {
    if (!wasmInitialization) {
      wasmInitialization = loadModule();
    }
    await wasmInitialization;
  }

  /**
   * Extract error context from pgsql-parser error message
   */
  private extractErrorContext(errorMessage: string, sql: string): { line?: number; column?: number; snippet?: string } {
    // pgsql-parser errors sometimes contain position info like:
    // "syntax error at or near "something" at line X"
    // or just "syntax error at or near "something""

    // Try to extract quoted text that caused the error
    const nearMatch = errorMessage.match(/at or near "([^"]+)"/);
    const problemText = nearMatch ? nearMatch[1] : null;

    if (!problemText) {
      return {};
    }

    // Find the first occurrence of the problem text in the SQL
    const lines = sql.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] || '';
      const col = lineText.indexOf(problemText);

      if (col !== -1) {
        // Found it! Extract context
        const line = i + 1;
        const column = col + 1;

        // Get snippet: current line + 2 lines before and after
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const contextLines = lines.slice(start, end);

        // Add line numbers and highlight the problem line
        const snippet = contextLines.map((l, idx) => {
          const lineNum = start + idx + 1;
          const marker = lineNum === line ? '→' : ' ';
          return `${marker} ${lineNum.toString().padStart(4)} | ${l}`;
        }).join('\n');

        return { line, column, snippet };
      }
    }

    return {};
  }

  /**
   * Auto-quote common reserved keywords when used as identifiers
   */
  private autoQuoteReservedKeywords(sql: string): string {
    const protectedSql = protectReservedKeywordSegments(sql);
    sql = protectedSql.sql;
    // List of commonly used PostgreSQL reserved keywords that users might use as column names
    // Note: Excludes highly ambiguous keywords like 'table', 'column', 'index' that appear in DDL
    const keywords = [
      'user', 'year', 'month', 'day', 'hour', 'minute', 'second',
      'order', 'group', 'limit', 'offset',
      'key', 'value', 'comment', 'status'
    ];

    // Pattern to match unquoted identifiers in column definitions
    // This handles: column_name TYPE constraints
    // Only match after whitespace or comma to ensure it's in a column position
    for (const keyword of keywords) {
      const createTablePattern = new RegExp(`(\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)${keyword}(\\b)`, 'gi');
      sql = sql.replace(createTablePattern, `$1"${keyword}"$2`);

      const pattern = new RegExp(`([,(]\\s*)(?<!")\\b${keyword}\\b(?!")(\\s+(INTEGER|INT|INT2|INT4|INT8|SMALLINT|BIGINT|VARCHAR|TEXT|BOOLEAN|BOOL|TIMESTAMP|DATE|TIME|NUMERIC|DECIMAL|REAL|DOUBLE|SERIAL|BIGSERIAL|UUID|JSONB|JSON|MONEY|BIT|VARBIT|INET|CIDR|MACADDR|XML|OID|TSVECTOR|TSQUERY|TSRANGE|BYTEA|POINT|LINE|LSEG|BOX|PATH|POLYGON|CIRCLE|(?!DEFAULT\\b|NOT\\b|NULL\\b|PRIMARY\\b|UNIQUE\\b|CHECK\\b|REFERENCES\\b|CONSTRAINT\\b|COLLATE\\b|GENERATED\\b|AS\\b|BY\\b|ON\\b|WITH\\b|USING\\b|WHERE\\b|GROUP\\b|ORDER\\b|LIMIT\\b|OFFSET\\b)[a-z_][a-z0-9_]*(?:\\.[a-z_][a-z0-9_]*)?)(?:\\s*\\[\\s*\\])*)`, 'gi');
      sql = sql.replace(pattern, `$1"${keyword}"$2`);

      // Also match in UNIQUE constraints: UNIQUE (column1, keyword, column3)
      const uniquePattern = new RegExp(`(UNIQUE\\s*\\([^)]*?)(?<!")\\b${keyword}\\b(?!")`, 'gi');
      sql = sql.replace(uniquePattern, `$1"${keyword}"`);

      // Also match in PRIMARY KEY and FOREIGN KEY constraints
      const keyPattern = new RegExp(`((?:PRIMARY|FOREIGN)\\s+KEY\\s*\\([^)]*?)(?<!")\\b${keyword}\\b(?!")`, 'gi');
      sql = sql.replace(keyPattern, `$1"${keyword}"`);
    }

    return restoreReservedKeywordSegments(sql, protectedSql.segments);
  }

  /**
   * Parse schema from a file path
   */
  async parseSchemaFile(filePath: string): Promise<{
    tables: Table[];
    enums: EnumType[];
    compositeTypes?: CompositeType[];
    views: View[];
    functions: Function[];
    procedures: Procedure[];
    triggers: Trigger[];
    sequences: Sequence[];
    extensions: Extension[];
    schemas: SchemaDefinition[];
    comments: Comment[];
    sqlObjects: SqlObject[];
  }> {
    if (!existsSync(filePath)) {
      throw new ParserError(
        `Schema file not found: ${filePath}`,
        filePath
      );
    }

    const content = readFileSync(filePath, "utf-8");
    return this.parseSchema(content, filePath);
  }

  /**
   * Parse schema from SQL string
   */
  async parseSchema(
    sql: string,
    filePath?: string
  ): Promise<{
    tables: Table[];
    enums: EnumType[];
    compositeTypes?: CompositeType[];
    views: View[];
    functions: Function[];
    procedures: Procedure[];
    triggers: Trigger[];
    sequences: Sequence[];
    extensions: Extension[];
    schemas: SchemaDefinition[];
    comments: Comment[];
    sqlObjects: SqlObject[];
  }> {
    await this.ensureWasmLoaded();

    const { tables, indexes, enums, compositeTypes, views, functions, procedures, triggers, sequences, extensions, schemas, comments, sqlObjects } = await this.parseWithPgsql(sql, filePath);

    this.associateIndexes(tables, views, indexes, filePath);
    qualifyDeclaredRoutineTypes({
      tables,
      enums,
      compositeTypes,
      sqlObjects,
      functions,
      procedures,
      filePath,
    });

    return {
      tables,
      enums,
      ...(compositeTypes.length > 0 ? { compositeTypes } : {}),
      views,
      functions,
      procedures,
      triggers,
      sequences,
      extensions,
      schemas,
      comments,
      sqlObjects,
    };
  }

  private associateIndexes(
    tables: Table[],
    views: View[],
    indexes: Index[],
    filePath?: string
  ): void {
    const tableMap = new Map(
      tables.map(function mapTable(table) {
        return [SchemaParser.tableKey(table.name, table.schema), table] as const;
      })
    );
    const viewMap = new Map(
      views.map(function mapView(view) {
        return [SchemaParser.tableKey(view.name, view.schema), view] as const;
      })
    );

    for (const index of indexes) {
      const targetKey = SchemaParser.tableKey(index.tableName, index.schema);
      const table = tableMap.get(targetKey);
      if (table) {
        this.normalizeIndexCollations(index, table);
        if (!table.indexes) {
          table.indexes = [];
        }
        table.indexes.push(index);
        continue;
      }

      const view = viewMap.get(targetKey);
      if (!view) {
        throw new ParserError(
          `Index ${index.name} targets ${targetKey}, but that table is not defined in the desired schema; define the table in the desired schema and qualify the index target when it is outside public`,
          filePath
        );
      }
      if (!view.materialized) {
        throw new ParserError(
          `Index ${index.name} targets ordinary view ${targetKey}; PostgreSQL indexes can target tables and materialized views, not ordinary views`,
          filePath
        );
      }
      if (!view.indexes) {
        view.indexes = [];
      }
      view.indexes.push(index);
    }
  }

  private normalizeIndexCollations(index: Index, table: Table): void {
    if (index.terms) {
      for (const term of index.terms) {
        const collation = getIndexTermCollation(term);
        if (!collation) {
          continue;
        }
        const column = term.column
          ? table.columns.find(function findColumn(candidate) {
              return candidate.name === term.column;
            })
          : undefined;
        let naturalCollation: QualifiedName | undefined;
        if (column) {
          naturalCollation = column.collation || DEFAULT_COLLATION;
        } else if (term.expression) {
          naturalCollation = this.getExpressionNaturalCollation(
            term.expression,
            table
          );
        }
        if (SchemaParser.collationNamesEqual(collation, naturalCollation)) {
          delete term.collation;
        }
      }
      synchronizeLegacyIndexFields(index);
      return;
    }
    if (!index.collations) {
      return;
    }

    const expressionCollation = index.expression
      ? this.getExpressionNaturalCollation(index.expression, table)
      : undefined;
    const normalized = index.collations.map(function normalizeKeyCollation(
      collation,
      position
    ) {
      if (!collation) {
        return undefined;
      }

      const columnName = index.columns[position];
      const column = columnName
        ? table.columns.find(function findColumn(candidate) {
            return candidate.name === columnName;
          })
        : undefined;
      const naturalCollation = column
        ? column.collation || DEFAULT_COLLATION
        : expressionCollation;
      return SchemaParser.collationNamesEqual(collation, naturalCollation)
        ? undefined
        : collation;
    });

    index.collations = normalized.some(function hasCollation(collation) {
      return Boolean(collation);
    })
      ? normalized
      : undefined;
  }

  private getExpressionNaturalCollation(
    expression: string,
    table: Table
  ): QualifiedName | undefined {
    const ast = parseSync(`SELECT ${expression} AS terradb_index_expression`);
    const statement = toPgAstNode(ast.stmts?.[0]?.stmt);
    const target = toPgAstNode(statement?.SelectStmt?.targetList?.[0]);
    const expressionNode =
      target?.ResTarget?.val;
    const referencedColumns = new Set<string>();

    function collectColumnReferences(value: unknown): void {
      if (Array.isArray(value)) {
        for (const item of value) {
          collectColumnReferences(item);
        }
        return;
      }
      if (!value || typeof value !== "object") {
        return;
      }

      const record = value as Record<string, unknown>;
      const columnReference = record.ColumnRef as
        | { fields?: Array<{ String?: { sval?: string } }> }
        | undefined;
      if (columnReference) {
        const columnName = columnReference.fields
          ?.map(function getReferencePart(field) {
            return field.String?.sval;
          })
          .filter(function hasReferencePart(part): part is string {
            return Boolean(part);
          })
          .at(-1);
        if (columnName) {
          referencedColumns.add(columnName);
        }
        return;
      }

      for (const child of Object.values(record)) {
        collectColumnReferences(child);
      }
    }

    collectColumnReferences(expressionNode);
    if (referencedColumns.size === 0) {
      return DEFAULT_COLLATION;
    }

    const columns = [...referencedColumns].map(function findColumn(columnName) {
      return table.columns.find(function hasName(candidate) {
        return candidate.name === columnName;
      });
    });
    if (columns.some(function isMissing(column) {
      return !column;
    })) {
      return undefined;
    }

    const naturalCollations = columns.map(function getColumnCollation(column) {
      return column?.collation || DEFAULT_COLLATION;
    });
    const firstCollation = naturalCollations[0];
    return naturalCollations.every(function hasSameCollation(collation) {
      return SchemaParser.collationNamesEqual(collation, firstCollation);
    })
      ? firstCollation
      : undefined;
  }

  private static collationNamesEqual(
    first: QualifiedName | undefined,
    second: QualifiedName | undefined
  ): boolean {
    if (!first || !second || first.name !== second.name) {
      return first === second;
    }
    return !first.schema || !second.schema || first.schema === second.schema;
  }

  /**
   * Parse CREATE TABLE statements
   */
  async parseCreateTableStatements(sql: string): Promise<Table[]> {
    await this.ensureWasmLoaded();
    const { tables } = await this.parseWithPgsql(sql);
    return tables;
  }

  /**
   * Parse CREATE INDEX statements
   */
  async parseCreateIndexStatements(sql: string): Promise<Index[]> {
    await this.ensureWasmLoaded();
    const { indexes } = await this.parseWithPgsql(sql);
    return indexes;
  }

  /**
   * Parse CREATE VIEW statements
   */
  async parseCreateViewStatements(sql: string): Promise<View[]> {
    await this.ensureWasmLoaded();
    const { views } = await this.parseWithPgsql(sql);
    return views;
  }

  /**
   * Parse SQL using pgsql-parser and extract all schema objects
   */
  private async parseWithPgsql(
    sql: string,
    filePath?: string
  ): Promise<{
    tables: Table[];
    indexes: Index[];
    enums: EnumType[];
    compositeTypes: CompositeType[];
    views: View[];
    functions: Function[];
    procedures: Procedure[];
    triggers: Trigger[];
    sequences: Sequence[];
    extensions: Extension[];
    schemas: SchemaDefinition[];
    comments: Comment[];
    sqlObjects: SqlObject[];
  }> {
    const tables: Table[] = [];
    const indexes: Index[] = [];
    const enums: EnumType[] = [];
    const compositeTypes: CompositeType[] = [];
    const views: View[] = [];
    const functions: Function[] = [];
    const procedures: Procedure[] = [];
    const triggers: Trigger[] = [];
    const sequences: Sequence[] = [];
    const extensions: Extension[] = [];
    const schemas: SchemaDefinition[] = [];
    const comments: Comment[] = [];
    const sqlObjects: SqlObject[] = [];
    const pendingTableConstraints: PendingTableConstraint[] = [];
    const pendingTriggerModes: PendingTriggerMode[] = [];
    const pendingReplicaIdentities: PendingReplicaIdentity[] = [];
    const pendingClusteringChoices: PendingClusteringChoice[] = [];
    const pendingPostgresStatistics: PendingPostgresStatisticsChange[] = [];
    const pendingForeignServerOwners: PendingForeignServerOwner[] = [];
    const partitionDefinitions = new Map<string, Table>();

    // Auto-quote reserved keywords that are commonly used as column names
    sql = this.autoQuoteReservedKeywords(sql);

    // Handle empty SQL (after keyword quoting to preserve empty checks correctly)
    if (!sql || sql.trim() === '') {
      return { tables, indexes, enums, compositeTypes, views, functions, procedures, triggers, sequences, extensions, schemas, comments, sqlObjects };
    }

    try {
      const ast = await parse(sql);

      if (!ast.stmts) {
        return { tables, indexes, enums, compositeTypes, views, functions, procedures, triggers, sequences, extensions, schemas, comments, sqlObjects };
      }

      for (const stmtWrapper of ast.stmts) {
        const stmt = toPgAstNode(stmtWrapper.stmt);
        if (!stmt) {
          throw new ParserError(
            "PostgreSQL parser returned an empty statement",
            filePath
          );
        }
        this.rejectTemporaryRelation(stmt, filePath);
        if (stmt.CreateStmt) {
          this.rejectUnsupportedTableShorthand(stmt.CreateStmt, filePath);
          this.rejectUnsupportedPartitionPersistence(
            stmt.CreateStmt,
            filePath
          );
          this.rejectUnsupportedPartitionDefinition(
            stmt.CreateStmt,
            filePath
          );
          this.rejectGeneratedPartitionKey(stmt.CreateStmt, filePath);
          this.rejectInvalidSerialTypeForms(
            stmt.CreateStmt,
            filePath
          );
          this.rejectConflictingSerialColumnClauses(
            stmt.CreateStmt,
            filePath
          );
          this.rejectUnsupportedConstraintSemantics(
            stmt.CreateStmt,
            filePath
          );
        }

        if (stmt.CreateStmt && this.isPartitionCreateStatement(stmt.CreateStmt)) {
          const sqlObject = this.parsePartitionSqlObject(stmt);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
            const partitionDefinition = parseCreateTable(stmt.CreateStmt);
            if (partitionDefinition) {
              partitionDefinitions.set(
                `${partitionDefinition.schema || "public"}.${partitionDefinition.name}`,
                partitionDefinition
              );
            }
          }
        } else if (stmt.CreateStmt) {
          const table = parseCreateTable(stmt.CreateStmt);
          if (table) {
            tables.push(table);
          }
        } else if (stmt.IndexStmt) {
          const index = parseCreateIndex(stmt.IndexStmt);
          if (index) {
            indexes.push(index);
          }
        } else if (stmt.CreateEnumStmt) {
          const enumType = parseCreateType(stmt.CreateEnumStmt);
          if (enumType) {
            enums.push(enumType);
          }
        } else if (stmt.CompositeTypeStmt) {
          const compositeType = parseCreateCompositeType(stmt.CompositeTypeStmt);
          if (compositeType) {
            compositeTypes.push(compositeType);
          }
        } else if (stmt.ViewStmt) {
          const view = parseCreateView(stmt.ViewStmt, sql, filePath);
          if (view) {
            views.push(view);
          }
        } else if (stmt.CreateTableAsStmt) {
          if (stmt.CreateTableAsStmt.objtype !== "OBJECT_MATVIEW") {
            throw this.unsupportedDerivedTableError(
              "CREATE TABLE AS",
              filePath
            );
          }
          const view = parseCreateMaterializedView(stmt.CreateTableAsStmt);
          if (view) {
            views.push(view);
          }
        } else if (stmt.SelectStmt?.intoClause) {
          throw this.unsupportedDerivedTableError("SELECT INTO", filePath);
        } else if (stmt.CreateFunctionStmt) {
          if (stmt.CreateFunctionStmt.is_procedure) {
            const proc = parseCreateProcedure(
              stmt.CreateFunctionStmt,
              sql,
              filePath
            );
            if (proc) {
              procedures.push(proc);
            }
          } else {
            const func = parseCreateFunction(
              stmt.CreateFunctionStmt,
              sql,
              filePath
            );
            if (func) {
              functions.push(func);
            }
          }
        } else if (stmt.CreateProcedureStmt) {
          const proc = parseCreateProcedure(
            stmt.CreateProcedureStmt,
            sql,
            filePath
          );
          if (proc) {
            procedures.push(proc);
          }
        } else if (stmt.CreateTrigStmt && stmt.CreateTrigStmt.isconstraint) {
          const sqlObject = this.parseConstraintTriggerSqlObject(stmt);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.CreateTrigStmt) {
          const trigger = parseCreateTrigger(stmt.CreateTrigStmt);
          if (trigger) {
            triggers.push(trigger);
          }
        } else if (stmt.CreateEventTrigStmt) {
          const sqlObject = this.parseEventTriggerSqlObject(stmt);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.CreateSeqStmt) {
          const sequence = parseCreateSequence(stmt.CreateSeqStmt);
          if (sequence) {
            sequences.push(sequence);
          }
        } else if (stmt.CreateExtensionStmt) {
          extensions.push(parseCreateExtension(stmt.CreateExtensionStmt, filePath));
        } else if (stmt.CreateSchemaStmt) {
          schemas.push(parseCreateSchema(stmt.CreateSchemaStmt, filePath));
        } else if (stmt.CommentStmt) {
          comments.push(this.parseCommentStmt(stmt.CommentStmt, filePath));
        } else if (stmt.CreatePolicyStmt) {
          const sqlObject = this.parsePolicySqlObject(stmt, filePath);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.AlterPolicyStmt) {
          throw new ParserError(
            "ALTER POLICY is an imperative partial mutation and is not supported in desired schemas; declare the policy's complete desired state with one CREATE POLICY statement",
            filePath
          );
        } else if (stmt.CreateDomainStmt) {
          const sqlObject = this.parseDomainSqlObject(stmt, filePath);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.CreateRangeStmt) {
          const sqlObject = this.parseRangeSqlObject(stmt, filePath);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.CreateForeignServerStmt) {
          const sqlObject = this.parseForeignServerSqlObject(
            stmt,
            filePath,
            getPostgresStatementSource(sql, stmtWrapper)
          );
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.CreateRoleStmt) {
          const sqlObject = this.parseRoleSqlObject(stmt, filePath);
          if (sqlObject) {
            sqlObjects.push(sqlObject);
          }
        } else if (stmt.GrantStmt) {
          sqlObjects.push(
            ...this.parseGrantSqlObjects(stmt.GrantStmt, filePath)
          );
        } else if (stmt.AlterDefaultPrivilegesStmt) {
          sqlObjects.push(
            ...parsePostgresDefaultPrivileges(
              stmt.AlterDefaultPrivilegesStmt,
              filePath
            )
          );
        } else if (stmt.GrantRoleStmt) {
          throw new ParserError(
            "PostgreSQL role membership GRANT is not supported in desired schemas because membership options and version-specific inheritance state are not modeled; manage role memberships separately",
            filePath
          );
        } else if (
          stmt.AlterOwnerStmt?.objectType === "OBJECT_FOREIGN_SERVER"
        ) {
          pendingForeignServerOwners.push(
            parseForeignServerOwner(stmt.AlterOwnerStmt, filePath)
          );
        } else if (stmt.AlterEventTrigStmt) {
          pendingTriggerModes.push(
            parseAlterEventTriggerMode(stmt.AlterEventTrigStmt, filePath)
          );
        } else if (stmt.AlterTableStmt) {
          this.rejectUnsupportedPartitionAlter(stmt.AlterTableStmt, filePath);
          rejectUnsupportedBulkTriggerAlter(
            stmt.AlterTableStmt,
            filePath
          );
          const rowSecurityObjects = this.parseAlterTableSqlObjects(
            stmt,
            filePath
          );
          sqlObjects.push(...rowSecurityObjects);
          const triggerModes = parseAlterTableTriggerModes(
            stmt.AlterTableStmt,
            filePath
          );
          pendingTriggerModes.push(...triggerModes);
          const replicaIdentities = parseAlterTableReplicaIdentities(
            stmt.AlterTableStmt,
            filePath
          );
          pendingReplicaIdentities.push(...replicaIdentities);
          const clusteringChoices = parseAlterRelationClustering(
            stmt.AlterTableStmt,
            filePath
          );
          pendingClusteringChoices.push(...clusteringChoices);
          const statisticsChanges = parseAlterPostgresStatistics(
            stmt.AlterTableStmt,
            filePath
          );
          pendingPostgresStatistics.push(...statisticsChanges);
          const remainingCommands = (stmt.AlterTableStmt.cmds || []).filter(
            function isNotDeclarativeStateCommand(item: any) {
              const subtype = item?.AlterTableCmd?.subtype;
              return !isRowSecuritySubtype(subtype) &&
                !isTableTriggerModeSubtype(subtype) &&
                !isReplicaIdentitySubtype(subtype) &&
                !isClusteringSubtype(subtype) &&
                !isPostgresStatisticsSubtype(subtype);
            }
          );
          if (remainingCommands.length > 0) {
            pendingTableConstraints.push(
              ...this.parseAlterTableConstraints(
                { ...stmt.AlterTableStmt, cmds: remainingCommands },
                filePath
              )
            );
          } else if (
            rowSecurityObjects.length === 0 &&
            triggerModes.length === 0 &&
            replicaIdentities.length === 0 &&
            clusteringChoices.length === 0 &&
            statisticsChanges.length === 0
          ) {
            throw this.unsupportedAlterTableError(filePath);
          }
        } else if (stmt.ClusterStmt) {
          throw new ParserError(
            "Physical CLUSTER is an imperative maintenance operation and is not supported in desired schemas; declare only the persistent choice with ALTER TABLE or ALTER MATERIALIZED VIEW ... CLUSTER ON",
            filePath
          );
        } else if (
          stmt.DropStmt?.removeType === "OBJECT_FOREIGN_SERVER"
        ) {
          sqlObjects.push(
            ...parseForeignServerRemovals(stmt.DropStmt, filePath)
          );
        } else if (stmt.DropRoleStmt) {
          sqlObjects.push(
            ...parsePostgresRoleRemovals(stmt.DropRoleStmt, filePath)
          );
        } else if (
          stmt.AlterRoleStmt ||
          stmt.AlterRoleSetStmt ||
          stmt.RenameStmt?.renameType === "OBJECT_ROLE"
        ) {
          throw new ParserError(
            "PostgreSQL ALTER ROLE is an imperative partial mutation and is not supported in desired schemas; declare the role's complete desired state with one CREATE ROLE statement",
            filePath
          );
        } else if (stmt.DropStmt) {
          throw new ParserError(
            "DROP statements are not supported in schema definitions. " +
              "Terra is a declarative schema tool - only include the tables and indexes " +
              "you want to exist. Terra will automatically determine what needs to be dropped.",
            filePath
          );
        } else {
          throw this.unsupportedStatementError(stmt, filePath);
        }
      }
    } catch (error) {
      if (error instanceof ParserError) {
        throw error;
      }

      if (error instanceof Error) {
        // Try to extract line/column info from pgsql-parser error message
        const { line, column, snippet } = this.extractErrorContext(error.message, sql);

        if (error.message.includes("MATCH PARTIAL not yet implemented")) {
          throw new ParserError(
            "PostgreSQL does not implement MATCH PARTIAL; use MATCH SIMPLE or MATCH FULL",
            filePath,
            line,
            column,
            snippet
          );
        }

        throw new ParserError(
          error.message,
          filePath,
          line,
          column,
          snippet
        );
      }

      throw new ParserError(
        `Unexpected parser error: ${String(error)}`,
        filePath
      );
    }

    this.rejectDuplicateDeclarativeSqlObjects(sqlObjects, filePath);
    this.rejectDuplicateSchemas(schemas, filePath);
    this.rejectDuplicateExtensions(extensions, filePath);
    this.rejectDuplicateComments(comments, filePath);
    mergeForeignServerOwners(
      sqlObjects,
      pendingForeignServerOwners,
      filePath
    );
    this.rejectUnboundForeignServerGrants(sqlObjects, filePath);
    this.rejectUnboundDefaultPrivileges(sqlObjects, schemas, filePath);
    rejectDuplicateTriggerDeclarations(triggers, sqlObjects, filePath);
    mergePendingTriggerModes(
      triggers,
      sqlObjects,
      pendingTriggerModes,
      filePath
    );
    mergePendingReplicaIdentities(
      tables,
      sqlObjects,
      pendingReplicaIdentities,
      partitionDefinitions,
      filePath
    );
    mergePendingClusteringChoices(
      tables,
      views,
      sqlObjects,
      pendingClusteringChoices,
      filePath
    );
    mergePendingPostgresStatistics(
      tables,
      views,
      indexes,
      sqlObjects,
      pendingPostgresStatistics,
      filePath
    );
    this.mergePendingTableConstraints(tables, pendingTableConstraints, filePath);
    this.resolveImplicitForeignKeyColumns(tables, filePath);

    return { tables, indexes, enums, compositeTypes, views, functions, procedures, triggers, sequences, extensions, schemas, comments, sqlObjects };
  }

  private rejectTemporaryRelation(stmt: any, filePath?: string): void {
    const candidates = [
      { relation: stmt.CreateStmt?.relation, kind: "table" },
      { relation: stmt.ViewStmt?.view, kind: "view" },
      { relation: stmt.CreateSeqStmt?.sequence, kind: "sequence" },
      {
        relation: stmt.CreateTableAsStmt?.into?.rel,
        kind:
          stmt.CreateTableAsStmt?.objtype === "OBJECT_MATVIEW"
            ? "materialized view"
            : "table",
      },
    ];

    for (const candidate of candidates) {
      if (candidate.relation?.relpersistence !== "t") {
        continue;
      }

      const name = candidate.relation.relname || "<unnamed>";
      throw new ParserError(
        `Temporary PostgreSQL ${candidate.kind} "${name}" is session-local and cannot be managed in a persistent desired schema; use a persistent ${candidate.kind} or remove it from the schema file`,
        filePath
      );
    }
  }

  private rejectUnsupportedTableShorthand(
    stmt: any,
    filePath?: string
  ): void {
    if (stmt.ofTypename) {
      throw new ParserError(
        "PostgreSQL CREATE TABLE OF is not supported in desired schemas because the persistent dependency on its composite type is not modeled; define a regular table with explicit columns instead",
        filePath
      );
    }

    const hasLikeClause = (stmt.tableElts || []).some(
      function hasTableLikeClause(item: any) {
        return Boolean(item.TableLikeClause);
      }
    );
    if (hasLikeClause) {
      throw new ParserError(
        "PostgreSQL CREATE TABLE LIKE is not supported in desired schemas because copied columns, constraints, indexes, and options cannot be represented safely; define the table structure explicitly instead",
        filePath
      );
    }
  }

  private rejectUnsupportedPartitionPersistence(
    stmt: any,
    filePath?: string
  ): void {
    if (
      stmt.relation?.relpersistence !== "u" ||
      !this.isPartitionCreateStatement(stmt)
    ) {
      return;
    }

    throw new ParserError(
      "PostgreSQL UNLOGGED partition hierarchies are not supported in desired schemas because PostgreSQL 18 rejects unlogged partitioned parents and earlier releases do not propagate persistence consistently to children; use a logged partition hierarchy or manage it outside TerraDB",
      filePath
    );
  }

  private rejectUnsupportedPartitionDefinition(
    stmt: any,
    filePath?: string
  ): void {
    if (!this.isPartitionCreateStatement(stmt)) {
      return;
    }

    const features: string[] = [];
    if (stmt.if_not_exists === true) {
      features.push("IF NOT EXISTS");
    }

    if (stmt.partbound) {
      if ((stmt.tableElts || []).length > 0) {
        features.push("column overrides or local constraints");
      }
      if (stmt.partspec) {
        features.push("subpartitioning");
      }
      const boundDatums = [
        ...(stmt.partbound.lowerdatums || []),
        ...(stmt.partbound.upperdatums || []),
        ...(stmt.partbound.listdatums || []),
      ];
      const hasEvaluatedBoundExpression = boundDatums.some(
        function hasEvaluatedBoundExpression(datum: any) {
          return !isCanonicalPartitionBoundDatum(
            datum,
            stmt.partbound.strategy
          );
        }
      );
      if (hasEvaluatedBoundExpression) {
        features.push(
          "non-literal partition bound expressions; use canonical uncast literal values"
        );
      }
    } else {
      const parentConstraints = (stmt.tableElts || []).flatMap(
        function getParentConstraints(item: any) {
          if (item.Constraint) {
            return [{ constraint: item.Constraint, inline: false }];
          }
          return (item.ColumnDef?.constraints || []).flatMap(
            function getColumnConstraint(wrapper: any) {
              return wrapper.Constraint
                ? [{ constraint: wrapper.Constraint, inline: true }]
                : [];
            }
          );
        }
      );
      const hasUnnamedTableConstraint = parentConstraints.some(
        function hasUnnamedTableConstraint(item: any) {
          return !item.inline && !item.constraint.conname;
        }
      );
      if (hasUnnamedTableConstraint) {
        features.push("constraints without explicit names; use explicitly named table constraints");
      }
      const hasInlinePersistentConstraint = parentConstraints.some(
        function hasInlinePersistentConstraint(item: any) {
          return item.inline && [
            "CONSTR_PRIMARY",
            "CONSTR_UNIQUE",
            "CONSTR_CHECK",
            "CONSTR_FOREIGN",
          ].includes(item.constraint.contype);
        }
      );
      if (hasInlinePersistentConstraint) {
        features.push("inline key, check, or reference constraints");
      }
      const hasForeignKey = parentConstraints.some(
        function hasForeignKey(item: any) {
          return item.constraint.contype === "CONSTR_FOREIGN";
        }
      );
      if (hasForeignKey) {
        features.push("foreign keys");
      }

      const hasPhysicalColumnOptions = (stmt.tableElts || []).some(
        function hasPhysicalColumnOptions(item: any) {
          return Boolean(
            item.ColumnDef?.storage_name || item.ColumnDef?.compression
          );
        }
      );
      if (hasPhysicalColumnOptions) {
        features.push("column STORAGE or COMPRESSION");
      }

      const serialTypeNames = new Set([
        "serial",
        "serial2",
        "serial4",
        "serial8",
        "smallserial",
        "bigserial",
      ]);
      const hasSerialColumn = (stmt.tableElts || []).some(
        function hasSerialColumn(item: any) {
          const names = item.ColumnDef?.typeName?.names || [];
          return names.some(function isSerialName(name: any) {
            return serialTypeNames.has(String(name?.String?.sval || "").toLowerCase());
          });
        }
      );
      if (hasSerialColumn) {
        features.push("serial pseudo-types; use an identity column instead");
      }
    }

    if (stmt.accessMethod) {
      features.push("access method");
    }
    if ((stmt.options || []).length > 0) {
      features.push("storage parameters");
    }
    if (stmt.tablespacename) {
      features.push("tablespace");
    }

    if (features.length === 0) {
      return;
    }

    throw new ParserError(
      `PostgreSQL partition definition uses unsupported persistent features: ${features.join(", ")}. TerraDB cannot inspect these features losslessly; use a basic partitioned parent and direct CREATE TABLE ... PARTITION OF leaf, or manage the hierarchy outside TerraDB`,
      filePath
    );
  }

  private rejectGeneratedPartitionKey(stmt: any, filePath?: string): void {
    if (!stmt.partspec) {
      return;
    }

    const table = parseCreateTable(stmt);
    if (!table) {
      return;
    }
    const generatedColumnNames = new Set(
      table.columns.filter(function isGeneratedColumn(column) {
        return Boolean(column.generated);
      }).map(function getColumnName(column) {
        return column.name;
      })
    );
    if (generatedColumnNames.size === 0) {
      return;
    }

    const generatedPartitionColumn = (stmt.partspec.partParams || []).flatMap(
      function getPartitionKeyReferences(wrapper: any) {
        const element = wrapper?.PartitionElem;
        return element?.name
          ? [element.name]
          : getPartitionKeyColumnReferences(element?.expr);
      }
    ).find(function findGeneratedPartitionColumn(name: string) {
      return generatedColumnNames.has(name);
    });
    if (!generatedPartitionColumn) {
      return;
    }

    throw new ParserError(
      `PostgreSQL generated column '${generatedPartitionColumn}' cannot be part of a partition key; use a non-generated source column instead`,
      filePath
    );
  }

  private rejectUnsupportedPartitionAlter(
    stmt: any,
    filePath?: string
  ): void {
    const hasPartitionCommand = (stmt.cmds || []).some(
      function hasPartitionCommand(item: any) {
        return [
          "AT_AttachPartition",
          "AT_DetachPartition",
          "AT_DetachPartitionFinalize",
        ].includes(item?.AlterTableCmd?.subtype);
      }
    );
    if (!hasPartitionCommand) {
      return;
    }

    throw new ParserError(
      "Imperative PostgreSQL ATTACH PARTITION and DETACH PARTITION commands are not supported in declarative desired schemas; declare the child with CREATE TABLE ... PARTITION OF or remove it from the desired schema instead",
      filePath
    );
  }

  private rejectUnsupportedConstraintSemantics(
    stmt: any,
    filePath?: string
  ): void {
    for (const element of stmt.tableElts || []) {
      if (element.ColumnDef) {
        for (const wrapper of element.ColumnDef.constraints || []) {
          if (wrapper.Constraint) {
            this.rejectUnsupportedConstraintNode(
              wrapper.Constraint,
              "column",
              filePath
            );
          }
        }
        continue;
      }

      if (element.Constraint) {
        this.rejectUnsupportedConstraintNode(
          element.Constraint,
          "table",
          filePath
        );
      }
    }
  }

  private rejectConflictingSerialColumnClauses(
    stmt: any,
    filePath?: string
  ): void {
    for (const element of stmt.tableElts || []) {
      const column = element.ColumnDef;
      if (!column || !isPostgresSerialType(extractDataType(column.typeName))) {
        continue;
      }

      const conflicts: string[] = [];
      for (const wrapper of column.constraints || []) {
        const label = POSTGRES_SERIAL_CONFLICTING_CLAUSES.get(
          wrapper.Constraint?.contype
        );
        if (label && !conflicts.includes(label)) {
          conflicts.push(label);
        }
      }
      if (conflicts.length === 0) {
        continue;
      }

      const schema = stmt.relation?.schemaname || "public";
      const table = stmt.relation?.relname || "<unnamed>";
      const name = column.colname || "<unnamed>";
      throw new ParserError(
        `PostgreSQL serial column '${schema}.${table}.${name}' declares ${conflicts.join(", ")}, which conflicts with SERIAL's implicit NOT NULL and sequence-backed default. Remove the conflicting clause or use an integer identity column or explicit sequence-backed default instead`,
        filePath
      );
    }
  }

  private rejectInvalidSerialTypeForms(
    stmt: any,
    filePath?: string
  ): void {
    for (const element of stmt.tableElts || []) {
      const column = element.ColumnDef;
      if (!column) {
        continue;
      }

      const typeName = column.typeName;
      const typeParts = (typeName?.names || [])
        .map(function getTypePart(item: any) {
          return item?.String?.sval;
        })
        .filter(function hasTypePart(value: unknown): value is string {
          return typeof value === "string" && value.length > 0;
        });
      const serialName = typeParts.at(-1);
      if (
        !serialName ||
        serialName !== serialName.toLowerCase() ||
        !isPostgresSerialType(serialName)
      ) {
        continue;
      }

      const isUnqualified = typeParts.length === 1;
      const isPgCatalogQualified =
        typeParts.length === 2 && typeParts[0] === "pg_catalog";
      if (!isUnqualified && !isPgCatalogQualified) {
        continue;
      }

      const invalidForms: string[] = [];
      if (isPgCatalogQualified) {
        invalidForms.push("pg_catalog qualification");
      }
      if (isUnqualified && (typeName.typmods || []).length > 0) {
        invalidForms.push("type modifiers");
      }
      if (isUnqualified && (typeName.arrayBounds || []).length > 0) {
        invalidForms.push("array bounds");
      }
      if (invalidForms.length === 0) {
        continue;
      }

      const schema = stmt.relation?.schemaname || "public";
      const table = stmt.relation?.relname || "<unnamed>";
      const name = column.colname || "<unnamed>";
      throw new ParserError(
        `PostgreSQL serial pseudo-type column '${schema}.${table}.${name}' uses ${invalidForms.join(", ")}. PostgreSQL serial pseudo-types are unqualified scalar shorthands without type modifiers or array bounds; use unqualified SERIAL, SMALLSERIAL, or BIGSERIAL, or declare an explicit integer or array type with a separate sequence`,
        filePath
      );
    }
  }

  private rejectUnsupportedConstraintNode(
    constraint: any,
    placement: "column" | "table",
    filePath?: string
  ): void {
    const isCheckOrForeignKey =
      constraint.contype === "CONSTR_CHECK" ||
      constraint.contype === "CONSTR_FOREIGN";
    const isNotEnforced =
      constraint.contype === "CONSTR_ATTR_NOT_ENFORCED" ||
      constraint.is_enforced === false ||
      (isCheckOrForeignKey &&
        constraint.skip_validation === true &&
        constraint.is_enforced !== true);

    if (isNotEnforced) {
      throw new ParserError(
        "PostgreSQL NOT ENFORCED constraints are not supported in desired schemas because enforcement state is not modeled; use an enforced constraint or manage the table outside TerraDB",
        filePath
      );
    }

    if (
      constraint.without_overlaps === true ||
      constraint.fk_with_period === true ||
      constraint.pk_with_period === true
    ) {
      throw new ParserError(
        "PostgreSQL temporal constraints using WITHOUT OVERLAPS or PERIOD are not supported in desired schemas because temporal coverage semantics are not modeled; use a non-temporal constraint or manage the table outside TerraDB",
        filePath
      );
    }

    if (
      constraint.contype === "CONSTR_NOTNULL" &&
      (placement === "table" ||
        Boolean(constraint.conname) ||
        constraint.is_no_inherit === true ||
        constraint.skip_validation === true ||
        constraint.initially_valid === false)
    ) {
      throw new ParserError(
        "PostgreSQL advanced NOT NULL constraints (named, table-level, NO INHERIT, or NOT VALID) are not supported in desired schemas because TerraDB models only column nullability; use an unnamed column-level NOT NULL constraint or manage the table outside TerraDB",
        filePath
      );
    }
  }

  private unsupportedDerivedTableError(
    statement: "CREATE TABLE AS" | "SELECT INTO",
    filePath?: string
  ): ParserError {
    return new ParserError(
      `PostgreSQL ${statement} is not supported in desired schemas because query-derived structure and optional initial data cannot be represented declaratively; define the table with CREATE TABLE and load data separately`,
      filePath
    );
  }

  private unsupportedStatementError(stmt: any, filePath?: string): ParserError {
    const statement = this.unsupportedStatementName(stmt);
    return new ParserError(
      `PostgreSQL ${statement} is not supported in desired schemas. TerraDB manages declarative schema state only; run data, query, session, maintenance, and unsupported DDL commands separately`,
      filePath
    );
  }

  private unsupportedStatementName(stmt: any): string {
    if (stmt.VacuumStmt) {
      return stmt.VacuumStmt.is_vacuumcmd ? "VACUUM" : "ANALYZE";
    }
    if (stmt.VariableSetStmt) {
      return "SET";
    }
    if (stmt.TransactionStmt) {
      return "TRANSACTION";
    }
    if (stmt.RefreshMatViewStmt) {
      return "REFRESH MATERIALIZED VIEW";
    }
    if (stmt.AlterSeqStmt) {
      return "ALTER SEQUENCE";
    }

    const nodeName = Object.keys(stmt).find(function findStatementNode(key) {
      return key.endsWith("Stmt");
    });
    if (!nodeName) {
      return "STATEMENT";
    }

    return nodeName
      .replace(/Stmt$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toUpperCase();
  }

  private parseAlterTableConstraints(
    stmt: any,
    filePath?: string
  ): PendingTableConstraint[] {
    const relation = stmt?.relation;
    const tableName = relation?.relname;
    const schemaName = relation?.schemaname;
    const commands = Array.isArray(stmt?.cmds) ? stmt.cmds : [];

    if (!tableName || commands.length === 0) {
      throw this.unsupportedAlterTableError(filePath);
    }

    const pending: PendingTableConstraint[] = [];

    for (const commandWrapper of commands) {
      const command = commandWrapper?.AlterTableCmd;
      if (!command || command.subtype !== "AT_AddConstraint" || !command.def?.Constraint) {
        throw this.unsupportedAlterTableError(filePath);
      }

      const constraint = command.def.Constraint;
      this.rejectUnsupportedConstraintNode(constraint, "table", filePath);
      if (constraint.contype === "CONSTR_FOREIGN") {
        const foreignKey = parseForeignKey(constraint);
        if (!foreignKey) {
          throw this.unsupportedAlterTableError(filePath);
        }
        pending.push({
          tableName,
          schemaName,
          kind: "foreign_key",
          constraint: foreignKey,
        });
        continue;
      }

      if (constraint.contype === "CONSTR_CHECK") {
        const checkConstraint = parseCheckConstraint(constraint);
        if (!checkConstraint) {
          throw this.unsupportedAlterTableError(filePath);
        }
        pending.push({
          tableName,
          schemaName,
          kind: "check",
          constraint: checkConstraint,
        });
        continue;
      }

      throw this.unsupportedAlterTableError(filePath);
    }

    return pending;
  }

  private mergePendingTableConstraints(
    tables: Table[],
    pendingConstraints: PendingTableConstraint[],
    filePath?: string
  ): void {
    if (pendingConstraints.length === 0) {
      return;
    }

    const tableMap = new Map(
      tables.map(function (table) {
        return [SchemaParser.tableKey(table.name, table.schema), table] as const;
      })
    );

    for (const pending of pendingConstraints) {
      const table = tableMap.get(SchemaParser.tableKey(pending.tableName, pending.schemaName));

      if (!table) {
        throw new ParserError(
          `ALTER TABLE target not found in schema definitions: ${pending.schemaName ? `${pending.schemaName}.` : ""}${pending.tableName}`,
          filePath
        );
      }

      if (pending.kind === "foreign_key") {
        if (!table.foreignKeys) {
          table.foreignKeys = [];
        }
        table.foreignKeys.push(pending.constraint);
      } else {
        if (!table.checkConstraints) {
          table.checkConstraints = [];
        }
        table.checkConstraints.push(pending.constraint);
      }
    }
  }

  private resolveImplicitForeignKeyColumns(
    tables: Table[],
    filePath?: string
  ): void {
    const tableMap = new Map(
      tables.map(function mapTable(table) {
        return [SchemaParser.tableKey(table.name, table.schema), table] as const;
      })
    );

    for (const table of tables) {
      for (const foreignKey of table.foreignKeys || []) {
        if (foreignKey.referencedColumns.length > 0) {
          continue;
        }

        let referencedTableKey = SchemaParser.referencedTableKey(
          foreignKey.referencedTable
        );
        const sourceTableKey = SchemaParser.tableKey(table.name, table.schema);
        const errorPrefix =
          `Cannot resolve implicit referenced columns for foreign key on ${sourceTableKey}`;
        let referencedTable = tableMap.get(referencedTableKey);
        if (
          !referencedTable &&
          !foreignKey.referencedTable.includes(".") &&
          table.schema &&
          table.schema !== "public"
        ) {
          const sameSchemaKey = SchemaParser.tableKey(
            foreignKey.referencedTable,
            table.schema
          );
          referencedTable = tableMap.get(sameSchemaKey);
          if (referencedTable) {
            referencedTableKey = sameSchemaKey;
            foreignKey.referencedTable = sameSchemaKey;
          }
        }
        if (!referencedTable) {
          throw new ParserError(
            `${errorPrefix}: referenced table ${referencedTableKey} is not defined in the desired schema; specify referenced columns explicitly for external or unmanaged tables`,
            filePath
          );
        }

        const primaryKeyColumns = referencedTable.primaryKey?.columns || [];
        if (primaryKeyColumns.length === 0) {
          throw new ParserError(
            `${errorPrefix}: referenced table ${referencedTableKey} has no primary key`,
            filePath
          );
        }

        if (foreignKey.columns.length !== primaryKeyColumns.length) {
          const referencingLabel =
            foreignKey.columns.length === 1 ? "column" : "columns";
          const primaryKeyLabel =
            primaryKeyColumns.length === 1 ? "column" : "columns";
          throw new ParserError(
            `${errorPrefix}: it has ${foreignKey.columns.length} referencing ${referencingLabel} but the primary key has ${primaryKeyColumns.length} ${primaryKeyLabel}`,
            filePath
          );
        }

        foreignKey.referencedColumns = [...primaryKeyColumns];
      }
    }
  }

  private unsupportedAlterTableError(filePath?: string): ParserError {
    return new ParserError(
      "This ALTER TABLE statement is not supported in schema definitions. " +
        "TerraDB is a declarative schema tool and accepts ALTER TABLE only for " +
        "ADD FOREIGN KEY and ADD CHECK constraints, row security flags, and " +
        "named trigger firing modes, replica identity state, and persistent " +
        "clustering choices, per-column statistics, and expression-index " +
        "statistics targets; " +
        "define all other desired table state with CREATE TABLE.",
      filePath
    );
  }

  private rejectDuplicateDeclarativeSqlObjects(
    objects: SqlObject[],
    filePath?: string
  ): void {
    const seen = new Set<string>();
    for (const object of objects) {
      if (
        object.kind !== "policy" &&
        object.kind !== "row-level-security" &&
        object.kind !== "foreign-server" &&
        object.kind !== "grant" &&
        object.kind !== "default-privilege" &&
        object.kind !== "role"
      ) {
        continue;
      }
      if (seen.has(object.key)) {
        let label = "foreign server";
        if (object.kind === "policy") {
          label = "policy";
        } else if (object.kind === "row-level-security") {
          label = "row-level security state";
        } else if (object.kind === "role") {
          label = "role";
        } else if (object.kind === "grant") {
          label = "privilege grant";
        } else if (object.kind === "default-privilege") {
          label = "default privilege";
        }
        throw new ParserError(
          `PostgreSQL ${label} '${object.key}' is declared more than once in the desired schema`,
          filePath
        );
      }
      seen.add(object.key);
    }
  }

  private rejectUnboundForeignServerGrants(
    objects: SqlObject[],
    filePath?: string
  ): void {
    const declaredServers = new Set(
      objects
        .filter(function isPresentForeignServer(object) {
          return object.kind === "foreign-server" &&
            object.desiredAbsent !== true;
        })
        .map(function getServerName(object) {
          return object.name;
        })
    );
    for (const object of objects) {
      const definition = object.grantDefinition;
      if (
        definition?.objectType !== "FOREIGN SERVER" ||
        declaredServers.has(definition.objectName)
      ) {
        continue;
      }
      throw new ParserError(
        `PostgreSQL GRANT on foreign server '${definition.objectName}' must also declare that server with CREATE SERVER so omission has a stable database-wide management scope`,
        filePath
      );
    }
  }

  private rejectUnboundDefaultPrivileges(
    objects: SqlObject[],
    schemas: SchemaDefinition[],
    filePath?: string
  ): void {
    const declaredRoles = new Set(
      objects
        .filter(function isPresentRole(object) {
          return object.kind === "role" && object.desiredAbsent !== true;
        })
        .map(function getRoleName(object) {
          return object.name;
        })
    );
    const declaredSchemas = new Set(schemas.map(function getSchemaName(schema) {
      return schema.name;
    }));
    for (const object of objects) {
      const definition = object.defaultPrivilegeDefinition;
      if (!definition) {
        continue;
      }
      if (!declaredRoles.has(definition.owner)) {
        throw new ParserError(
          `PostgreSQL default privileges for role '${definition.owner}' must also declare that owner with CREATE ROLE so omission has a stable database-wide scope`,
          filePath
        );
      }
      if (definition.schema && !declaredSchemas.has(definition.schema)) {
        throw new ParserError(
          `PostgreSQL default privileges in schema '${definition.schema}' must also declare that schema with CREATE SCHEMA so omission has a stable scope`,
          filePath
        );
      }
    }
  }

  private static tableKey(name: string, schema?: string): string {
    return `${schema || "public"}.${name}`;
  }

  private static referencedTableKey(referencedTable: string): string {
    return referencedTable.includes(".")
      ? referencedTable
      : SchemaParser.tableKey(referencedTable);
  }

  private statementToSql(stmt: any): string {
    const sql = deparseSync([stmt]).trim();
    return sql.endsWith(";") ? sql : `${sql};`;
  }

  private buildSqlObject(
    kind: SqlObject["kind"],
    stmt: any,
    name: string,
    schema?: string,
    key?: string,
    dependencies?: string[]
  ): SqlObject {
    return {
      kind,
      key: key || `${kind}:${schema || "public"}.${name}`,
      name,
      schema,
      createStatement: this.statementToSql(stmt),
      ...(dependencies && dependencies.length > 0 ? { dependencies } : {}),
    };
  }

  private isPartitionCreateStatement(stmt: any): boolean {
    return Boolean(stmt?.partspec || stmt?.partbound);
  }

  private parsePartitionSqlObject(stmt: any): SqlObject | null {
    const relation = stmt?.CreateStmt?.relation;
    const name = relation?.relname;
    if (!name) {
      return null;
    }

    const schema = relation?.schemaname;
    const dependencies = (stmt?.CreateStmt?.inhRelations || []).map(function (item: any) {
      const parent = item?.RangeVar;
      const parentName = parent?.relname;
      if (!parentName) {
        return null;
      }
      return `partition:${parent?.schemaname || schema || "public"}.${parentName}`;
    }).filter(Boolean);

    const object = this.buildSqlObject(
      "partition",
      stmt,
      name,
      schema,
      `partition:${schema || "public"}.${name}`,
      dependencies
    );
    const partitionTable = parseCreateTable(stmt.CreateStmt);
    const partitionColumnTypes = Object.fromEntries(
      (partitionTable?.columns || []).map(function mapColumnType(column) {
        return [column.name, column.type];
      })
    );
    return {
      ...object,
      ...(Object.keys(partitionColumnTypes).length > 0
        ? { partitionColumnTypes }
        : {}),
    };
  }

  private parseAlterTableSqlObjects(
    stmt: any,
    filePath?: string
  ): SqlObject[] {
    const commands = stmt?.AlterTableStmt?.cmds || [];
    const relation = stmt?.AlterTableStmt?.relation;
    const tableName = relation?.relname;
    const rowSecurityCommands = commands.filter(function isRowSecurityCommand(
      item: any
    ) {
      return isRowSecuritySubtype(item?.AlterTableCmd?.subtype);
    });
    if (rowSecurityCommands.length === 0) {
      return [];
    }
    if (!tableName) {
      throw this.unsupportedAlterTableError(filePath);
    }

    const schema = relation?.schemaname;
    const seen = new Set<string>();
    const objects: SqlObject[] = [];
    for (const item of rowSecurityCommands) {
      const subtype = item.AlterTableCmd.subtype;
      if (subtype === "AT_DisableRowSecurity") {
        throw new ParserError(
          "DISABLE ROW LEVEL SECURITY is an imperative mutation and is not supported in desired schemas; omit ENABLE ROW LEVEL SECURITY to declare that enforcement should be disabled",
          filePath
        );
      }
      if (subtype === "AT_NoForceRowSecurity") {
        throw new ParserError(
          "NO FORCE ROW LEVEL SECURITY is an imperative mutation and is not supported in desired schemas; omit FORCE ROW LEVEL SECURITY to declare that owner enforcement should be disabled",
          filePath
        );
      }

      const suffix = subtype === "AT_ForceRowSecurity" ? "force" : "enabled";
      if (seen.has(suffix)) {
        throw new ParserError(
          `ROW LEVEL SECURITY ${suffix === "force" ? "FORCE" : "ENABLE"} is declared more than once for '${schema ? `${schema}.` : ""}${tableName}'`,
          filePath
        );
      }
      seen.add(suffix);
      objects.push(
        this.buildSqlObject(
          "row-level-security",
          {
            AlterTableStmt: {
              ...stmt.AlterTableStmt,
              cmds: [item],
            },
          },
          tableName,
          schema,
          `row-level-security:${schema || "public"}.${tableName}:${suffix}`
        )
      );
    }
    return objects;
  }

  private parsePolicyRole(
    wrapper: any,
    filePath?: string
  ): PostgresPolicyRole {
    const role = wrapper?.RoleSpec;
    switch (role?.roletype) {
      case "ROLESPEC_PUBLIC":
        return { kind: "public" };
      case "ROLESPEC_CURRENT_ROLE":
        return { kind: "current_role" };
      case "ROLESPEC_CURRENT_USER":
        return { kind: "current_user" };
      case "ROLESPEC_SESSION_USER":
        return { kind: "session_user" };
      case "ROLESPEC_CSTRING":
        if (role.rolename) {
          return { kind: "name", name: role.rolename };
        }
    }
    throw new ParserError(
      "CREATE POLICY contains an unsupported role reference",
      filePath
    );
  }

  private parsePolicySqlObject(
    stmt: any,
    filePath?: string
  ): SqlObject | null {
    const node = stmt?.CreatePolicyStmt;
    const name = node?.policy_name;
    const relation = node?.table;
    const tableName = relation?.relname;
    if (!name || !tableName) {
      return null;
    }

    const command = (node.cmd_name || "all") as
      PostgresPolicyDefinition["command"];
    if (command === "insert" && node.qual) {
      throw new ParserError(
        `PostgreSQL INSERT policy '${name}' cannot declare USING; use WITH CHECK for inserted rows`,
        filePath
      );
    }
    if (
      (command === "select" || command === "delete") &&
      node.with_check
    ) {
      throw new ParserError(
        `PostgreSQL ${command.toUpperCase()} policy '${name}' cannot declare WITH CHECK; use USING for visible rows`,
        filePath
      );
    }

    const schema = relation?.schemaname;
    const object = this.buildSqlObject(
      "policy",
      stmt,
      name,
      schema,
      `policy:${schema || "public"}.${tableName}.${name}`
    );
    const parser = this;
    return {
      ...object,
      policyDefinition: {
        command,
        permissive: node.permissive === true,
        roles: (node.roles || []).map(function mapPolicyRole(role: any) {
          return parser.parsePolicyRole(role, filePath);
        }),
        ...(node.qual
          ? { using: deparseSync([node.qual]).trim() }
          : {}),
        ...(node.with_check
          ? { withCheck: deparseSync([node.with_check]).trim() }
          : {}),
      },
    };
  }

  private parseDomainSqlObject(stmt: any, filePath?: string): SqlObject | null {
    const domain = stmt?.CreateDomainStmt;
    const typeName = domain?.domainname || [];
    const names = typeName.map(function (item: any) {
      return item?.String?.sval;
    }).filter(Boolean);
    const name = names[names.length - 1];
    if (!name) {
      return null;
    }
    const schema = names.length > 1 ? names[names.length - 2] : undefined;
    const constraints = domain.constraints || [];
    const defaultConstraints = constraints.filter(function isDefault(item: any) {
      return item?.Constraint?.contype === "CONSTR_DEFAULT";
    });
    if (defaultConstraints.length > 1) {
      throw new ParserError(
        `PostgreSQL domain '${schema ? `${schema}.` : ""}${name}' declares more than one default`,
        filePath
      );
    }
    const notNullConstraints = constraints.filter(function isNotNull(item: any) {
      return item?.Constraint?.contype === "CONSTR_NOTNULL";
    });
    if (notNullConstraints.length > 1) {
      throw new ParserError(
        `PostgreSQL domain '${schema ? `${schema}.` : ""}${name}' declares NOT NULL more than once`,
        filePath
      );
    }
    const constraintNames = new Set<string>();
    const checkConstraints = constraints.flatMap(function parseConstraint(
      item: any
    ) {
      const constraint = item?.Constraint;
      if (constraint?.contype !== "CONSTR_CHECK" || !constraint.raw_expr) {
        return [];
      }
      if (constraint.conname && constraintNames.has(constraint.conname)) {
        throw new ParserError(
          `PostgreSQL domain '${schema ? `${schema}.` : ""}${name}' declares constraint '${constraint.conname}' more than once`,
          filePath
        );
      }
      if (constraint.conname) constraintNames.add(constraint.conname);
      return [{
        ...(constraint.conname ? { name: constraint.conname } : {}),
        expression: deparseSync([constraint.raw_expr]).trim(),
        validated:
          constraint.skip_validation !== true &&
          constraint.initially_valid !== false,
      }];
    });
    const defaultConstraint = defaultConstraints[0]?.Constraint;
    const object = this.buildSqlObject("domain-type", stmt, name, schema);
    return {
      ...object,
      typeDefinition: {
        kind: "domain",
        baseType: extractDataType(domain.typeName),
        collation: extractColumnCollation(domain.collClause),
        ...(defaultConstraint?.raw_expr
          ? { default: deparseSync([defaultConstraint.raw_expr]).trim() }
          : {}),
        notNull: notNullConstraints.length === 1,
        constraints: checkConstraints,
      },
    };
  }

  private parseRangeSqlObject(stmt: any, filePath?: string): SqlObject | null {
    const range = stmt?.CreateRangeStmt;
    const typeName = range?.typeName || [];
    const names = typeName.map(function (item: any) {
      return item?.String?.sval;
    }).filter(Boolean);
    const name = names[names.length - 1];
    if (!name) {
      return null;
    }
    const schema = names.length > 1 ? names[names.length - 2] : undefined;
    const params = new Map<string, any>();
    const supportedOptions = new Set([
      "subtype",
      "subtype_opclass",
      "collation",
      "canonical",
      "subtype_diff",
      "multirange_type_name",
    ]);
    for (const item of range.params || []) {
      const parameter = item?.DefElem;
      if (!parameter?.defname) continue;
      if (!supportedOptions.has(parameter.defname)) {
        throw new ParserError(
          `PostgreSQL range '${schema ? `${schema}.` : ""}${name}' uses unsupported option '${parameter.defname}'`,
          filePath
        );
      }
      if (params.has(parameter.defname)) {
        throw new ParserError(
          `PostgreSQL range '${schema ? `${schema}.` : ""}${name}' declares option '${parameter.defname}' more than once`,
          filePath
        );
      }
      params.set(parameter.defname, parameter.arg);
    }
    const subtype = params.get("subtype")?.TypeName;
    if (!subtype) {
      throw new ParserError(
        `PostgreSQL range '${schema ? `${schema}.` : ""}${name}' requires a subtype`,
        filePath
      );
    }
    const object = this.buildSqlObject("range-type", stmt, name, schema);
    return {
      ...object,
      createStatement: this.deparseRangeStatement(stmt),
      typeDefinition: {
        kind: "range",
        subtype: extractDataType(subtype),
        ...this.parseRangeQualifiedOption(
          params,
          "subtype_opclass",
          "subtypeOperatorClass"
        ),
        ...this.parseRangeQualifiedOption(params, "collation", "collation"),
        ...this.parseRangeQualifiedOption(
          params,
          "canonical",
          "canonicalFunction"
        ),
        ...this.parseRangeQualifiedOption(
          params,
          "subtype_diff",
          "subtypeDiffFunction"
        ),
        ...this.parseRangeQualifiedOption(
          params,
          "multirange_type_name",
          "multirangeTypeName"
        ),
      },
    };
  }

  /**
   * The deparser renders a `pg_catalog`-qualified range option such as
   * `collation = pg_catalog."C"` without quoting the object name, which
   * PostgreSQL then folds to a different, usually missing, name. Other
   * qualifiers are quoted correctly, so the catalog schema is deparsed
   * under a placeholder and restored afterwards.
   */
  private deparseRangeStatement(stmt: any): string {
    const placeholder = "terradb_pg_catalog_placeholder";
    const copy = structuredClone(stmt);
    for (const item of copy?.CreateRangeStmt?.params || []) {
      const parameter = item?.DefElem;
      const names = parameter?.defname === "subtype"
        ? undefined
        : parameter?.arg?.TypeName?.names;
      const qualifier = names?.length === 2 ? names[0]?.String : undefined;
      if (qualifier?.sval === "pg_catalog") {
        qualifier.sval = placeholder;
      }
    }
    return this.statementToSql(copy).split(`${placeholder}.`).join("pg_catalog.");
  }

  private parseRangeQualifiedOption(
    params: Map<string, any>,
    option: string,
    property: string
  ): Record<string, QualifiedName> {
    const names = (params.get(option)?.TypeName?.names || [])
      .map(function getName(item: any) {
        return item?.String?.sval;
      })
      .filter(Boolean);
    const name = names.at(-1);
    if (!name) return {};
    return {
      [property]: {
        name,
        ...(names.length > 1 ? { schema: names.at(-2) } : {}),
      },
    };
  }

  private parseForeignServerSqlObject(
    stmt: any,
    filePath?: string,
    statementSource: string = ""
  ): SqlObject | null {
    const server = stmt?.CreateForeignServerStmt;
    const name = server?.servername;
    if (!name) {
      return null;
    }
    const optionNames = new Set<string>();
    const options = (server.options || []).map(function parseOption(item: any) {
      const option = item?.DefElem;
      const optionName = option?.defname;
      const optionValue = option?.arg?.String?.sval;
      if (typeof optionName !== "string" || typeof optionValue !== "string") {
        throw new ParserError(
          `PostgreSQL foreign server '${name}' contains an unsupported option value`,
          filePath
        );
      }
      if (optionNames.has(optionName)) {
        throw new ParserError(
          `PostgreSQL foreign server '${name}' option '${optionName}' is declared more than once`,
          filePath
        );
      }
      optionNames.add(optionName);
      return { name: optionName, value: optionValue };
    });
    const hasEmptyType = hasEmptyForeignServerClause(statementSource, "TYPE");
    const hasEmptyVersion = hasEmptyForeignServerClause(
      statementSource,
      "VERSION"
    );
    const type = resolveForeignServerString(server.servertype, hasEmptyType);
    const version = resolveForeignServerString(server.version, hasEmptyVersion);
    const foreignServerDefinition = {
      foreignDataWrapper: server.fdwname,
      ...(type !== undefined ? { type } : {}),
      ...(version !== undefined ? { version } : {}),
      options: sortPostgresForeignServerOptions(options),
    };
    const object = this.buildSqlObject(
      "foreign-server",
      stmt,
      name,
      undefined,
      `foreign-server:${name}`
    );
    return {
      ...object,
      createStatement: renderPostgresForeignServerCreate(
        name,
        foreignServerDefinition
      ),
      foreignServerDefinition,
    };
  }

  private parseConstraintTriggerSqlObject(stmt: any): SqlObject | null {
    const node = stmt?.CreateTrigStmt;
    const name = node?.trigname;
    const relation = node?.relation;
    const tableName = relation?.relname;
    if (!name || !tableName) {
      return null;
    }

    const schema = relation?.schemaname;
    const object = this.buildSqlObject(
      "constraint-trigger",
      stmt,
      name,
      schema,
      `constraint-trigger:${schema || "public"}.${tableName}.${name}`
    );
    object.triggerTable = { name: tableName, ...(schema ? { schema } : {}) };
    object.triggerFunction = qualifiedNameFromStringNodes(
      node.funcname,
      "public"
    );
    return object;
  }

  private parseEventTriggerSqlObject(stmt: any): SqlObject | null {
    const name = stmt?.CreateEventTrigStmt?.trigname;
    if (!name) {
      return null;
    }
    const object = this.buildSqlObject(
      "event-trigger",
      stmt,
      name,
      undefined,
      `event-trigger:${name}`
    );
    object.triggerFunction = qualifiedNameFromStringNodes(
      stmt.CreateEventTrigStmt.funcname,
      "public"
    );
    return object;
  }

  private parseRoleSqlObject(
    stmt: any,
    filePath?: string
  ): SqlObject | null {
    return parsePostgresRole(stmt, filePath);
  }

  private parseGrantSqlObjects(
    node: any,
    filePath?: string
  ): SqlObject[] {
    return parsePostgresGrants(node, filePath);
  }

  /**
   * Parse COMMENT ON statement
   */
  private parseCommentStmt(stmt: any, filePath?: string): Comment {
    if (typeof stmt.comment !== "string" || stmt.comment.length === 0) {
      throw new ParserError(
        "PostgreSQL COMMENT removal with IS NULL or an empty string is not supported in desired schemas; remove the COMMENT statement to declare that the object should have no comment",
        filePath
      );
    }

    const objectType = COMMENT_OBJECT_TYPE_MAP[stmt.objtype];
    if (!objectType) {
      const target = this.commentTargetName(stmt.objtype);
      throw new ParserError(
        `PostgreSQL COMMENT ON ${target} is not supported in desired schemas because TerraDB cannot identify and inspect that comment losslessly; supported targets are SCHEMA, TABLE, COLUMN, VIEW, MATERIALIZED VIEW, INDEX, SEQUENCE, TYPE, and DOMAIN`,
        filePath
      );
    }

    // For COLUMN comments, we need to extract table name, column name, and optionally schema
    if (objectType === 'COLUMN' && stmt.object) {
      const parts = this.extractObjectParts(stmt.object);

      if (parts.length === 2 && parts[0] && parts[1]) {
        // Format: table.column
        return {
          objectType,
          objectName: parts[0], // table name
          columnName: parts[1], // column name
          comment: stmt.comment
        };
      } else if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
        // Format: schema.table.column
        return {
          objectType,
          objectName: parts[1], // table name
          schemaName: parts[0], // schema name
          columnName: parts[2], // column name
          comment: stmt.comment
        };
      }

      throw this.invalidCommentTargetError(objectType, filePath);
    }

    // For other object types, extract name normally
    let objectName = '';
    let schemaName: string | undefined;

    if (stmt.object) {
      const parts = this.extractObjectParts(stmt.object);
      if (parts.length === 2 && objectType !== 'SCHEMA' && parts[0] && parts[1]) {
        // Format: schema.object
        schemaName = parts[0];
        objectName = parts[1];
      } else if (parts.length === 1 && parts[0]) {
        objectName = parts[0];
      }
    }

    if (!objectName) {
      throw this.invalidCommentTargetError(objectType, filePath);
    }

    return {
      objectType,
      objectName,
      schemaName,
      comment: stmt.comment
    };
  }

  private commentTargetName(objectType: unknown): string {
    if (typeof objectType !== "string") {
      return "UNKNOWN OBJECT";
    }
    return objectType.replace(/^OBJECT_/, "").replace(/_/g, " ");
  }

  private invalidCommentTargetError(
    objectType: Comment['objectType'],
    filePath?: string
  ): ParserError {
    return new ParserError(
      `PostgreSQL COMMENT ON ${objectType} has a target identity that TerraDB cannot represent losslessly`,
      filePath
    );
  }

  private rejectDuplicateComments(
    comments: Comment[],
    filePath?: string
  ): void {
    const identities = new Set<string>();
    for (const comment of comments) {
      const identity = comment.objectType === "COLUMN"
        ? `${comment.objectType}:${comment.schemaName || "public"}.${comment.objectName}.${comment.columnName}`
        : `${comment.objectType}:${comment.schemaName || "public"}.${comment.objectName}`;
      if (identities.has(identity)) {
        throw new ParserError(
          `PostgreSQL comment ${identity} is declared more than once; declare each object's final comment exactly once`,
          filePath
        );
      }
      identities.add(identity);
    }
  }

  private rejectDuplicateSchemas(
    schemas: SchemaDefinition[],
    filePath?: string
  ): void {
    const names = new Set<string>();
    for (const schema of schemas) {
      if (names.has(schema.name)) {
        throw new ParserError(
          `PostgreSQL schema ${schema.name} is declared more than once; declare each schema exactly once`,
          filePath
        );
      }
      names.add(schema.name);
    }
  }

  private rejectDuplicateExtensions(
    extensions: Extension[],
    filePath?: string
  ): void {
    const names = new Set<string>();
    for (const extension of extensions) {
      if (names.has(extension.name)) {
        throw new ParserError(
          `PostgreSQL extension ${extension.name} is declared more than once; declare each extension exactly once`,
          filePath
        );
      }
      names.add(extension.name);
    }
  }

  /**
   * Extract object parts from AST node (returns array of parts)
   */
  private extractObjectParts(obj: any): string[] {
    if (obj.String?.sval) {
      return [obj.String.sval];
    }

    if (obj.TypeName?.names) {
      return obj.TypeName.names
        .map(function (item: any) {
          return item.String?.sval;
        })
        .filter(Boolean);
    }

    if (obj.List?.items) {
      return obj.List.items.map(function getListItem(item: any) {
        return item.String?.sval;
      }).filter(function isString(value: unknown): value is string {
        return typeof value === "string";
      });
    }

    if (Array.isArray(obj)) {
      return obj.map(function getArrayItem(item: any) {
        return item.String?.sval;
      }).filter(function isString(value: unknown): value is string {
        return typeof value === "string";
      });
    }

    return [];
  }

}
