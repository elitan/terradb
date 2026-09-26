import type { View } from "../../../types/schema";
import type { MigrationContext } from "../../../types/migration";
import { ValidationError } from "../../../types/errors";
import { deparseSync, parseSync } from "pgsql-parser";
import { toPgAstNode } from "../parser/pgsql-ast";
import {
  generateCreateViewSQL,
  generateDropViewSQL,
  generateCreateOrReplaceViewSQL,
  generateRefreshMaterializedViewSQL,
  generateRenameViewColumnSQL,
  generateResetMaterializedViewStorageParametersSQL,
  generateSetMaterializedViewAccessMethodSQL,
  generateSetMaterializedViewStorageParametersSQL,
  generateSetMaterializedViewTablespaceSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";
import { SchemaDiffer } from "../differ";
import { normalizeSQLiteIdentifier } from "../../../utils/sqlite-identifier";
import { normalizeSQLiteSchemaDefinition } from "../../../providers/sqlite/sql-parser-utils";
import {
  postgresIndexMethodSupportsClustering,
  renderPostgresClustering,
} from "../../../utils/postgres-clustering";
import {
  remapPostgresColumnStatisticsByOrdinal,
  renderPostgresColumnStatisticsChanges,
  validatePostgresColumnStatistics,
  validatePostgresStatisticsTarget,
} from "../../../utils/postgres-statistics";
import { getPostgresIndexTerms } from "../../../utils/postgres-index";
import { SQLBuilder } from "../../../utils/sql-builder";

function postgresStringNodeValue(node: any): string | undefined {
  return typeof node?.String?.sval === "string"
    ? node.String.sval
    : undefined;
}

function removeLeadingLocalSchema(
  nodes: any[] | undefined,
  localSchema: string,
  minimumParts: number = 2
): void {
  if (
    !Array.isArray(nodes) ||
    nodes.length < minimumParts ||
    postgresStringNodeValue(nodes[0]) !== localSchema
  ) {
    return;
  }
  nodes.shift();
}

function simpleSelectSourceName(selectStatement: any): string | undefined {
  if (selectStatement?.fromClause?.length !== 1) {
    return undefined;
  }
  const rangeVariable = selectStatement.fromClause[0]?.RangeVar;
  if (!rangeVariable) {
    return undefined;
  }
  return rangeVariable.alias?.aliasname || rangeVariable.relname;
}

function removeSingleSourceColumnQualification(
  value: any,
  sourceName: string
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (value.SelectStmt) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      removeSingleSourceColumnQualification(item, sourceName);
    }
    return;
  }

  const fields = value.ColumnRef?.fields;
  if (
    Array.isArray(fields) &&
    fields.length > 1 &&
    postgresStringNodeValue(fields[0]) === sourceName
  ) {
    fields.shift();
  }
  for (const child of Object.values(value)) {
    removeSingleSourceColumnQualification(child, sourceName);
  }
}

function canonicalizePostgresViewAst(value: any, localSchema: string): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      canonicalizePostgresViewAst(item, localSchema);
    }
    return;
  }

  const rangeVariable = value.RangeVar;
  if (rangeVariable?.schemaname === localSchema) {
    delete rangeVariable.schemaname;
  }
  removeLeadingLocalSchema(value.FuncCall?.funcname, localSchema);
  removeLeadingLocalSchema(value.TypeName?.names, localSchema);
  removeLeadingLocalSchema(value.typeName?.names, localSchema);
  removeLeadingLocalSchema(value.CollateClause?.collname, localSchema);
  removeLeadingLocalSchema(value.A_Expr?.name, localSchema);
  removeLeadingLocalSchema(value.SortBy?.useOp, localSchema);
  removeLeadingLocalSchema(value.ColumnRef?.fields, localSchema, 3);

  for (const child of Object.values(value)) {
    canonicalizePostgresViewAst(child, localSchema);
  }

  const selectStatement = value.SelectStmt;
  const sourceName = simpleSelectSourceName(selectStatement);
  if (selectStatement && sourceName) {
    removeSingleSourceColumnQualification(selectStatement, sourceName);
  }
}

function normalizeDefinition(definition: string, schema?: string): string {
  try {
    const parsed = parseSync(definition);
    const statements = parsed.stmts?.flatMap(function getStatement(item) {
      if (!item.stmt) {
        return [];
      }
      canonicalizePostgresViewAst(item.stmt, schema || "public");
      return [item.stmt];
    });
    if (!statements || statements.length === 0) {
      return definition.trim();
    }
    return deparseSync(statements).trim();
  } catch {
    return definition.trim();
  }
}

function clearOutputAliases(selectStatement: any): void {
  if (Array.isArray(selectStatement?.targetList)) {
    for (const target of selectStatement.targetList) {
      if (target.ResTarget) {
        delete target.ResTarget.name;
      }
    }
  }
  if (selectStatement?.larg?.SelectStmt) {
    clearOutputAliases(selectStatement.larg.SelectStmt);
  }
  if (selectStatement?.rarg?.SelectStmt) {
    clearOutputAliases(selectStatement.rarg.SelectStmt);
  }
}

function definitionWithoutOutputAliases(definition: string): string {
  try {
    const parsed = parseSync(definition);
    const statements = parsed.stmts;
    const firstStatement = toPgAstNode(statements?.[0]?.stmt);
    const selectStatement = firstStatement?.SelectStmt;
    if (!selectStatement || !statements) {
      return definition;
    }
    clearOutputAliases(selectStatement);
    const statementNodes = statements.flatMap(function getStatement(item) {
      return item.stmt ? [item.stmt] : [];
    });
    if (statementNodes.length !== statements.length) {
      return definition;
    }
    return deparseSync(statementNodes).trim();
  } catch {
    return definition;
  }
}

function haveSameColumnNames(desired: View, current: View): boolean {
  return !desired.columnNames ||
    !current.columnNames ||
    (desired.columnNames.length === current.columnNames.length &&
      desired.columnNames.every(function hasSameName(name, index) {
        return name === current.columnNames?.[index];
      }));
}

function postgresViewDefinitionNeedsUpdate(
  desired: View,
  current: View
): boolean {
  const compareAliasesSeparately = Boolean(
    desired.columnNames && current.columnNames
  );
  const desiredDefinition = compareAliasesSeparately
    ? definitionWithoutOutputAliases(desired.definition)
    : desired.definition;
  const currentDefinition = compareAliasesSeparately
    ? definitionWithoutOutputAliases(current.definition)
    : current.definition;

  return desired.materialized !== current.materialized ||
    normalizeDefinition(desiredDefinition, desired.schema) !==
      normalizeDefinition(currentDefinition, current.schema);
}

function postgresViewOptionsNeedUpdate(
  desired: View,
  current: View
): boolean {
  return generateOrdinaryViewOptionAlterations(desired, current).length > 0;
}

type PostgresViewOptionValue = string | boolean;

function renderPostgresViewOptionValue(
  value: PostgresViewOptionValue
): string {
  return typeof value === "boolean" ? String(value) : value.toLowerCase();
}

function renderSetPostgresViewOptions(
  view: View,
  options: Array<[string, PostgresViewOptionValue]>
): string {
  const assignments = options.map(function renderAssignment([name, value]) {
    return `${name} = ${renderPostgresViewOptionValue(value)}`;
  });
  return new SQLBuilder()
    .p("ALTER VIEW")
    .table(view.name, view.schema)
    .p(`SET (${assignments.join(", ")})`)
    .p(";")
    .build();
}

function renderResetPostgresViewOptions(
  view: View,
  options: string[]
): string {
  return new SQLBuilder()
    .p("ALTER VIEW")
    .table(view.name, view.schema)
    .p(`RESET (${options.join(", ")})`)
    .p(";")
    .build();
}

function addBooleanViewOptionChange(
  name: string,
  desired: boolean | undefined,
  current: boolean | undefined,
  optionsToSet: Array<[string, PostgresViewOptionValue]>,
  optionsToReset: string[]
): void {
  if ((desired ?? false) === (current ?? false)) {
    return;
  }
  if (desired === undefined) {
    optionsToReset.push(name);
  } else {
    optionsToSet.push([name, desired]);
  }
}

function generateOrdinaryViewOptionAlterations(
  desired: View,
  current: View
): string[] {
  if (desired.materialized) {
    return [];
  }

  const optionsToSet: Array<[string, PostgresViewOptionValue]> = [];
  const optionsToReset: string[] = [];
  if (desired.checkOption !== current.checkOption) {
    if (
      current.checkOption === "CASCADED" &&
      desired.checkOption === "LOCAL"
    ) {
      optionsToReset.push("check_option");
    }
    if (desired.checkOption === undefined) {
      optionsToReset.push("check_option");
    } else {
      optionsToSet.push(["check_option", desired.checkOption]);
    }
  }
  addBooleanViewOptionChange(
    "security_barrier",
    desired.securityBarrier,
    current.securityBarrier,
    optionsToSet,
    optionsToReset
  );
  addBooleanViewOptionChange(
    "security_invoker",
    desired.securityInvoker,
    current.securityInvoker,
    optionsToSet,
    optionsToReset
  );

  const statements: string[] = [];
  if (optionsToReset.length > 0) {
    statements.push(renderResetPostgresViewOptions(desired, optionsToReset));
  }
  if (optionsToSet.length > 0) {
    statements.push(renderSetPostgresViewOptions(desired, optionsToSet));
  }
  return statements;
}

function validateSecurityInvokerSupport(
  desiredViews: View[],
  context: MigrationContext
): void {
  const unsupportedView = desiredViews.find(function findSecurityInvoker(view) {
    return !view.materialized && view.securityInvoker !== undefined;
  });
  if (!unsupportedView) {
    return;
  }

  const qualifiedName = `${unsupportedView.schema || "public"}.${unsupportedView.name}`;
  if (context.postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely manage security_invoker view ${qualifiedName} without the PostgreSQL server version`,
      qualifiedName,
      "securityInvoker",
      unsupportedView.securityInvoker
    );
  }
  if (context.postgresVersionNum < 150000) {
    const serverMajor = Math.floor(context.postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} does not support security_invoker views; PostgreSQL 15 or newer is required for ${qualifiedName}`,
      qualifiedName,
      "securityInvoker",
      unsupportedView.securityInvoker
    );
  }
}

function postgresViewWillBeRecreated(desired: View, current: View): boolean {
  if (desired.materialized !== current.materialized) {
    return true;
  }
  if (
    desired.columnNames &&
    current.columnNames &&
    desired.columnNames.length < current.columnNames.length
  ) {
    return true;
  }
  return Boolean(
    desired.materialized && postgresViewDefinitionNeedsUpdate(desired, current)
  );
}

function stringRecordsEqual(
  desired: Record<string, string> | undefined,
  current: Record<string, string> | undefined
): boolean {
  const desiredEntries = Object.entries(desired || {}).sort();
  const currentEntries = Object.entries(current || {}).sort();
  return desiredEntries.length === currentEntries.length &&
    desiredEntries.every(function hasSameEntry(entry, index) {
      return currentEntries[index]?.[0] === entry[0] &&
        currentEntries[index]?.[1] === entry[1];
    });
}

function materializedViewPhysicalPropertiesNeedUpdate(
  desired: View,
  current: View,
  context: MigrationContext
): boolean {
  if (!desired.materialized || !current.materialized) {
    return false;
  }

  const defaultAccessMethod = context.defaultTableAccessMethod || "heap";
  const storageParametersChanged = !stringRecordsEqual(
    desired.storageParameters,
    current.storageParameters
  );
  const tablespaceChanged = (desired.tablespace || "pg_default") !==
    (current.tablespace || "pg_default");
  const accessMethodChanged =
    (desired.accessMethod || defaultAccessMethod) !==
    (current.accessMethod || defaultAccessMethod);
  return storageParametersChanged || tablespaceChanged || accessMethodChanged;
}

function generateMaterializedViewAccessMethodAlteration(
  desired: View,
  current: View,
  context: MigrationContext
): string | undefined {
  const defaultAccessMethod = context.defaultTableAccessMethod || "heap";
  const desiredAccessMethod = desired.accessMethod || defaultAccessMethod;
  const currentAccessMethod = current.accessMethod || defaultAccessMethod;
  if (desiredAccessMethod === currentAccessMethod) {
    return undefined;
  }

  const qualifiedName = `${desired.schema || "public"}.${desired.name}`;
  if (context.postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely change the access method of existing materialized view ${qualifiedName} without the PostgreSQL server version`,
      qualifiedName,
      "accessMethod",
      desiredAccessMethod
    );
  }
  if (context.postgresVersionNum < 150000) {
    const serverMajor = Math.floor(context.postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} cannot change the access method of existing materialized view ${qualifiedName}; PostgreSQL 15 or newer is required for an in-place change`,
      qualifiedName,
      "accessMethod",
      desiredAccessMethod
    );
  }
  return generateSetMaterializedViewAccessMethodSQL(
    desired,
    desiredAccessMethod
  );
}

function generateMaterializedViewPhysicalAlterations(
  desired: View,
  current: View,
  context: MigrationContext
): string[] {
  if (!desired.materialized || !current.materialized) {
    return [];
  }

  const statements: string[] = [];
  const desiredParameters = desired.storageParameters || {};
  const currentParameters = current.storageParameters || {};
  const parametersToSet = Object.fromEntries(
    Object.entries(desiredParameters).filter(function filterChanged([name, value]) {
      return currentParameters[name] !== value;
    })
  );
  const parametersToReset = Object.keys(currentParameters).filter(
    function filterRemoved(name) {
      return desiredParameters[name] === undefined;
    }
  );

  if (Object.keys(parametersToSet).length > 0) {
    statements.push(
      generateSetMaterializedViewStorageParametersSQL(
        desired,
        parametersToSet
      )
    );
  }
  if (parametersToReset.length > 0) {
    statements.push(
      generateResetMaterializedViewStorageParametersSQL(
        desired,
        parametersToReset
      )
    );
  }

  const desiredTablespace = desired.tablespace || "pg_default";
  const currentTablespace = current.tablespace || "pg_default";
  if (desiredTablespace !== currentTablespace) {
    statements.push(
      generateSetMaterializedViewTablespaceSQL(desired, desiredTablespace)
    );
  }

  const accessMethodAlteration = generateMaterializedViewAccessMethodAlteration(
    desired,
    current,
    context
  );
  if (accessMethodAlteration) {
    statements.push(accessMethodAlteration);
  }
  return statements;
}

function generateViewColumnRenameStatements(
  desired: View,
  current: View
): string[] {
  if (!desired.columnNames || !current.columnNames) {
    return [];
  }

  const changes: Array<{
    currentName: string;
    desiredName: string;
    temporaryName: string;
  }> = [];
  const reservedNames = new Set([
    ...desired.columnNames,
    ...current.columnNames,
  ]);
  const commonLength = Math.min(
    desired.columnNames.length,
    current.columnNames.length
  );

  for (let index = 0; index < commonLength; index++) {
    const currentName = current.columnNames[index];
    const desiredName = desired.columnNames[index];
    if (!currentName || !desiredName || currentName === desiredName) {
      continue;
    }

    let temporaryName = `__terradb_view_column_${index + 1}`;
    let suffix = 1;
    while (reservedNames.has(temporaryName)) {
      temporaryName = `__terradb_view_column_${index + 1}_${suffix}`;
      suffix++;
    }
    reservedNames.add(temporaryName);
    changes.push({ currentName, desiredName, temporaryName });
  }

  const statements = changes.map(function renameToTemporary(change) {
    return generateRenameViewColumnSQL(
      current,
      change.currentName,
      change.temporaryName
    );
  });
  statements.push(
    ...changes.map(function renameToDesired(change) {
      return generateRenameViewColumnSQL(
        desired,
        change.temporaryName,
        change.desiredName
      );
    })
  );
  return statements;
}

function recreateView(desired: View, current: View): string {
  return `${generateDropViewSQL(
    current.name,
    current.materialized,
    current.schema
  )}\n${generateCreateViewSQL(desired)}`;
}

function generatePostgresViewUpdateStatements(
  desired: View,
  current: View,
  context: MigrationContext
): string | string[] {
  if (postgresViewWillBeRecreated(desired, current)) {
    return recreateView(desired, current);
  }

  const statements = generateViewColumnRenameStatements(desired, current);
  if (postgresViewDefinitionNeedsUpdate(desired, current)) {
    const replacementView = postgresViewOptionsNeedUpdate(desired, current)
      ? {
          ...desired,
          checkOption: current.checkOption,
          securityBarrier: current.securityBarrier,
          securityInvoker: current.securityInvoker,
        }
      : desired;
    statements.push(generateCreateOrReplaceViewSQL(replacementView));
  }
  statements.push(...generateOrdinaryViewOptionAlterations(desired, current));
  statements.push(
    ...generateMaterializedViewPhysicalAlterations(desired, current, context)
  );
  return statements;
}

function getViewKey(view: View): string {
  return `${view.schema || "public"}.${view.name}`;
}

function mapViewsByKey(views: View[]): Map<string, View> {
  return new Map(
    views.map(function mapView(view) {
      return [getViewKey(view), view] as const;
    })
  );
}

function hasCreateStatement(view: View): boolean {
  return typeof view.createStatement === "string" && view.createStatement.trim().length > 0;
}

function cleanCreateStatement(statement: string): string {
  return statement.trim().replace(/;+\s*$/g, "");
}

function quoteSQLiteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function generateSQLiteDropView(view: View): string {
  return `DROP VIEW IF EXISTS ${quoteSQLiteIdentifier(view.name)};`;
}

function generateSQLiteCreateView(view: View): string {
  return `${cleanCreateStatement(view.createStatement || "")};`;
}

function getSQLiteViewKey(view: View): string {
  return [view.schema || "public", view.name]
    .map(normalizeSQLiteIdentifier)
    .join(".");
}

function createSQLiteConfig(
  identifiers: readonly string[]
): HandlerConfig<View> {
  return {
    name: "view",
    getKey: getSQLiteViewKey,
    generateDrop: generateSQLiteDropView,
    generateCreate: generateSQLiteCreateView,
    needsUpdate: function sqliteViewNeedsUpdate(desired, current) {
      return normalizeSQLiteSchemaDefinition(
        desired.createStatement || "",
        identifiers
      ) !== normalizeSQLiteSchemaDefinition(
        current.createStatement || "",
        identifiers
      );
    },
  };
}

function createPostgresConfig(
  context: MigrationContext
): HandlerConfig<View> {
  return {
    name: "view",
    getKey: getViewKey,
    generateDrop: function generatePostgresViewDrop(view) {
      return generateDropViewSQL(view.name, view.materialized, view.schema);
    },
    generateCreate: generateCreateViewSQL,
    generateUpdate: function generatePostgresViewUpdate(desired, current) {
      return generatePostgresViewUpdateStatements(desired, current, context);
    },
    needsUpdate: function postgresViewNeedsUpdate(desired, current) {
      return postgresViewDefinitionNeedsUpdate(desired, current) ||
        postgresViewOptionsNeedUpdate(desired, current) ||
        !haveSameColumnNames(desired, current) ||
        materializedViewPhysicalPropertiesNeedUpdate(
          desired,
          current,
          context
        );
    },
  };
}

const materializedViewIndexDiffer = new SchemaDiffer({
  useConcurrentIndexes: false,
  useConcurrentDrops: false,
});

function generateMaterializedViewIndexStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);

  for (const desired of desiredViews) {
    if (!desired.materialized) {
      continue;
    }

    const current = currentMap.get(getViewKey(desired));
    const currentIndexes =
      current && !postgresViewWillBeRecreated(desired, current)
        ? current.indexes || []
        : [];
    statements.push(
      ...materializedViewIndexDiffer.generateStandaloneIndexStatements(
        desired.indexes || [],
        currentIndexes
      )
    );
  }
  return statements;
}

function validateMaterializedViewStatistics(views: View[]): void {
  for (const view of views) {
    const qualifiedName = `${view.schema || "public"}.${view.name}`;
    if ((view.columnStatistics || []).length > 0) {
      if (!view.materialized) {
        throw new ValidationError(
          `PostgreSQL column statistics for ${qualifiedName} require a materialized view`,
          qualifiedName,
          "columnStatistics",
          view.columnStatistics
        );
      }
      if (!view.columnNames) {
        throw new ValidationError(
          `Materialized view ${qualifiedName} must declare an explicit output-column list before TerraDB can validate column statistics`,
          qualifiedName,
          "columnStatistics",
          view.columnStatistics
        );
      }
      validatePostgresColumnStatistics(
        view.columnStatistics,
        qualifiedName,
        new Set(view.columnNames)
      );
    }

    for (const index of view.indexes || []) {
      if (index.concurrent === true) {
        throw new ValidationError(
          `PostgreSQL materialized-view index ${qualifiedName}.${index.name} cannot be created concurrently`,
          `${qualifiedName}.${index.name}`,
          "concurrent",
          true
        );
      }
      for (const [position, term] of getPostgresIndexTerms(index).entries()) {
        if (term.statisticsTarget === undefined) {
          continue;
        }
        validatePostgresStatisticsTarget(
          term.statisticsTarget,
          `${qualifiedName}.${index.name} position ${position + 1}`
        );
        if (!term.expression) {
          throw new ValidationError(
            `PostgreSQL index statistics target for ${qualifiedName}.${index.name} position ${position + 1} requires an expression key`,
            `${qualifiedName}.${index.name}`,
            "terms",
            term
          );
        }
      }
    }
  }
}

function generateMaterializedViewStatisticsStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);
  for (const desired of desiredViews) {
    if (!desired.materialized) continue;
    const current = currentMap.get(getViewKey(desired));
    const recreated = Boolean(
      current && postgresViewWillBeRecreated(desired, current)
    );
    const currentStatistics = recreated
      ? undefined
      : remapPostgresColumnStatisticsByOrdinal(
          current?.columnStatistics,
          current?.columnNames,
          desired.columnNames
        );
    statements.push(
      ...renderPostgresColumnStatisticsChanges(
        { name: desired.name, schema: desired.schema },
        desired.columnStatistics,
        currentStatistics,
        "materialized-view"
      )
    );
  }
  return statements;
}

function generateMaterializedViewIndexStatisticsStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);
  for (const desired of desiredViews) {
    if (!desired.materialized) continue;
    const current = currentMap.get(getViewKey(desired));
    const currentIndexes =
      current && !postgresViewWillBeRecreated(desired, current)
        ? current.indexes || []
        : [];
    const statistics =
      materializedViewIndexDiffer.generateStandaloneIndexStatisticsStatements(
        desired.indexes || [],
        currentIndexes,
        false
      );
    statements.push(...statistics.statements, ...statistics.deferred);
  }
  return statements;
}

function validateMaterializedViewClustering(views: View[]): void {
  for (const view of views) {
    if (!view.clusterIndex) {
      continue;
    }
    const qualifiedName = `${view.schema || "public"}.${view.name}`;
    if (!view.materialized) {
      throw new ValidationError(
        `PostgreSQL clustering choice for '${qualifiedName}' is invalid: ordinary views cannot have indexes`,
        qualifiedName,
        "clusterIndex",
        view.clusterIndex
      );
    }
    const index = (view.indexes || []).find(function findClusterIndex(
      candidate
    ) {
      return candidate.name === view.clusterIndex;
    });
    if (!index) {
      throw materializedViewClusteringError(
        view,
        `index '${view.clusterIndex}' is not declared on the materialized view`
      );
    }
    if (index.where) {
      throw materializedViewClusteringError(
        view,
        `index '${view.clusterIndex}' is partial`
      );
    }
    const method = (index.type || "btree").toLowerCase();
    if (!postgresIndexMethodSupportsClustering(method)) {
      throw materializedViewClusteringError(
        view,
        `index '${view.clusterIndex}' uses access method '${method}', which TerraDB cannot prove is clusterable`
      );
    }
  }
}

function materializedViewClusteringError(
  view: View,
  reason: string
): ValidationError {
  const qualifiedName = `${view.schema || "public"}.${view.name}`;
  return new ValidationError(
    `PostgreSQL clustering index for materialized view '${qualifiedName}' is invalid: ${reason}. Use a non-partial index whose access method supports clustering`,
    qualifiedName,
    "clusterIndex",
    view.clusterIndex
  );
}

function materializedViewClusterIndexWillChange(
  desired: View,
  current: View | undefined
): boolean {
  if (!desired.clusterIndex || !current) {
    return false;
  }
  const desiredIndex = (desired.indexes || []).find(function findDesired(
    index
  ) {
    return index.name === desired.clusterIndex;
  });
  const currentIndex = (current.indexes || []).find(function findCurrent(
    index
  ) {
    return index.name === desired.clusterIndex;
  });
  if (!desiredIndex || !currentIndex) {
    return false;
  }
  return materializedViewIndexDiffer.generateStandaloneIndexStatements(
    [desiredIndex],
    [currentIndex]
  ).length > 0;
}

function generateMaterializedViewClusteringStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);

  for (const desired of desiredViews) {
    if (!desired.materialized) {
      continue;
    }
    const current = currentMap.get(getViewKey(desired));
    const recreated = Boolean(
      current && postgresViewWillBeRecreated(desired, current)
    );
    const currentIndex = recreated ? undefined : current?.clusterIndex;
    const selectedIndexChanged = desired.clusterIndex !== currentIndex;
    const selectedIndexWillChange = materializedViewClusterIndexWillChange(
      desired,
      recreated ? undefined : current
    );
    if (!selectedIndexChanged && !selectedIndexWillChange) {
      continue;
    }
    statements.push(
      renderPostgresClustering(
        { name: desired.name, schema: desired.schema },
        desired.clusterIndex,
        "materialized-view"
      )
    );
  }
  return statements;
}

function generateMaterializedViewPopulationStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);

  for (const desired of desiredViews) {
    if (!desired.materialized || desired.populated === undefined) {
      continue;
    }

    const current = currentMap.get(getViewKey(desired));
    if (
      !current ||
      current.populated === undefined ||
      current.populated === desired.populated ||
      postgresViewWillBeRecreated(desired, current)
    ) {
      continue;
    }

    statements.push(
      generateRefreshMaterializedViewSQL(
        desired.name,
        false,
        desired.schema,
        desired.populated
      )
    );
  }

  return statements;
}

function collectRelationReferences(node: unknown, references: Set<string>, defaultSchema: string): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRelationReferences(item, references, defaultSchema);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const rangeVar = (node as { RangeVar?: { relname?: string; schemaname?: string } }).RangeVar;
  if (rangeVar?.relname) {
    references.add(`${rangeVar.schemaname || defaultSchema}.${rangeVar.relname}`);
  }
  for (const value of Object.values(node)) {
    collectRelationReferences(value, references, defaultSchema);
  }
}

function getPostgresViewReferences(view: View): Set<string> {
  const references = new Set<string>();
  try {
    collectRelationReferences(
      parseSync(view.definition),
      references,
      view.schema || "public"
    );
  } catch {
    return references;
  }
  return references;
}

/**
 * Orders views so that every view follows the views it selects from, or,
 * for removals, precedes them. Views are otherwise kept in input order, and
 * a view whose definition cannot be parsed or that belongs to a cycle keeps
 * its relative position after the resolvable views.
 */
function orderPostgresViewsByDependencies(
  views: View[],
  direction: "dependencies-first" | "dependents-first"
): View[] {
  const keys = new Set(views.map(getViewKey));
  const edges = new Map<string, Set<string>>();
  for (const view of views) {
    const key = getViewKey(view);
    const references = getPostgresViewReferences(view);
    for (const reference of references) {
      if (reference === key || !keys.has(reference)) {
        continue;
      }
      const [before, after] = direction === "dependencies-first"
        ? [reference, key]
        : [key, reference];
      const prerequisites = edges.get(after) ?? new Set<string>();
      prerequisites.add(before);
      edges.set(after, prerequisites);
    }
  }
  if (edges.size === 0) {
    return views;
  }

  const ordered: View[] = [];
  const emitted = new Set<string>();
  const remaining = [...views];
  while (remaining.length > 0) {
    const index = remaining.findIndex(function isReady(view) {
      const prerequisites = edges.get(getViewKey(view));
      return !prerequisites || [...prerequisites].every(function isEmitted(key) {
        return emitted.has(key);
      });
    });
    if (index === -1) {
      ordered.push(...remaining);
      break;
    }
    const [view] = remaining.splice(index, 1);
    ordered.push(view!);
    emitted.add(getViewKey(view!));
  }
  return ordered;
}

export class ViewHandler {
  generateStatements(
    desiredViews: View[],
    currentViews: View[],
    context: MigrationContext = {},
    sqliteIdentifiers: readonly string[] = []
  ): string[] {
    const usesCreateStatements = desiredViews.some(hasCreateStatement) ||
      currentViews.some(hasCreateStatement);
    if (!usesCreateStatements) {
      validateSecurityInvokerSupport(desiredViews, context);
      validateMaterializedViewClustering(desiredViews);
      validateMaterializedViewStatistics(desiredViews);
    }
    const statements = generateStatements(
      usesCreateStatements
        ? desiredViews
        : orderPostgresViewsByDependencies(desiredViews, "dependencies-first"),
      usesCreateStatements
        ? currentViews
        : orderPostgresViewsByDependencies(currentViews, "dependents-first"),
      usesCreateStatements
        ? createSQLiteConfig(sqliteIdentifiers)
        : createPostgresConfig(context)
    );
    if (usesCreateStatements) {
      return statements;
    }
    statements.push(
      ...generateMaterializedViewStatisticsStatements(
        desiredViews,
        currentViews
      )
    );
    statements.push(
      ...generateMaterializedViewIndexStatements(desiredViews, currentViews)
    );
    statements.push(
      ...generateMaterializedViewIndexStatisticsStatements(
        desiredViews,
        currentViews
      )
    );
    statements.push(
      ...generateMaterializedViewClusteringStatements(
        desiredViews,
        currentViews
      )
    );
    statements.push(
      ...generateMaterializedViewPopulationStatements(
        desiredViews,
        currentViews
      )
    );
    return statements;
  }
}
