import type { MigrationPlan } from "../../types/migration";
import { deparseSync, parseSync } from "pgsql-parser";
import {
  PullVerificationError,
  StrictModeError,
  ValidationError,
} from "../../types/errors";
import type {
  DatabaseProvider,
  DatabaseClient,
  ConnectionConfig,
  AdvisoryLockOptions,
  ParsedSchema,
} from "../../providers/types";
import type { Column, Extension, Function, Table, Trigger, View } from "../../types/schema";
import { Logger } from "../../utils/logger";
import {
  getCreatedPostgresServerName,
  getPostgresServerOwnerTransferName,
  isDestructiveStatement,
} from "../../utils/statement-classifier";
import { hasSQLiteTableRecreation } from "../../utils/sqlite-recreation";
import { collectSQLiteSchemaIdentifiers } from "../../utils/sqlite-identifier";
import { validatePostgresNumericModifiers } from "../../utils/postgres-numeric";
import { validatePostgresTemporalModifiers } from "../../utils/postgres-temporal";
import { validatePostgresLengthModifiers } from "../../utils/postgres-length";
import {
  CommentHandler,
  CompositeTypeHandler,
  EnumHandler,
  ExtensionHandler,
  FunctionHandler,
  ProcedureHandler,
  SchemaHandler,
  SequenceHandler,
  type SequenceStatementPlan,
  SqlObjectHandler,
  TriggerHandler,
  ViewHandler,
} from "./handlers";
import {
  orderPostgresTypeStatements,
  type PostgresTypeStatement,
} from "./handlers/postgres-type-ordering";
import { toPgAstNode } from "./parser/pgsql-ast";
import {
  createEmptySchemaState,
  normalizePulledSchema,
  renderPulledSchema,
  toDesiredStatements,
} from "./pull";

export interface PullResult {
  sql: string;
  statements: string[];
}

export interface SchemaManagementOptions {
  manageComments?: boolean;
  manageConstraintValidation?: boolean;
  managePrivileges?: boolean;
}

function reorderCanonicalWildcardView(
  desiredDefinition: string,
  canonical: { definition: string; columnNames: string[] },
  current: View
): { definition: string; columnNames: string[] } | undefined {
  if (
    !current.columnNames ||
    canonical.columnNames.length !== current.columnNames.length ||
    new Set(canonical.columnNames).size !== canonical.columnNames.length ||
    new Set(current.columnNames).size !== current.columnNames.length
  ) {
    return undefined;
  }
  const canonicalNames = new Set(canonical.columnNames);
  if (!current.columnNames.every(function hasCanonicalName(name) {
    return canonicalNames.has(name);
  })) {
    return undefined;
  }

  try {
    const desiredAst = parseSync(desiredDefinition);
    const desiredStatement = toPgAstNode(desiredAst.stmts?.[0]?.stmt);
    const desiredSelect = desiredStatement?.SelectStmt;
    const hasWildcardProjection = desiredSelect?.targetList?.some(
      function hasWildcard(target) {
        const targetNode = toPgAstNode(target);
        const valueNode = toPgAstNode(targetNode?.ResTarget?.val);
        return valueNode?.ColumnRef?.fields?.some(
          function isWildcard(field) {
            return Boolean(toPgAstNode(field)?.A_Star);
          }
        );
      }
    );
    if (
      !hasWildcardProjection ||
      desiredSelect?.larg ||
      desiredSelect?.rarg ||
      desiredSelect?.distinctClause ||
      desiredSelect?.groupClause ||
      desiredSelect?.havingClause ||
      desiredSelect?.sortClause
    ) {
      return undefined;
    }

    const canonicalAst = parseSync(canonical.definition);
    const canonicalStatement = toPgAstNode(canonicalAst.stmts?.[0]?.stmt);
    const canonicalSelect = canonicalStatement?.SelectStmt;
    if (
      !canonicalSelect?.targetList ||
      canonicalSelect.targetList.length !== canonical.columnNames.length
    ) {
      return undefined;
    }
    const targetByName = new Map<
      string,
      (typeof canonicalSelect.targetList)[number]
    >();
    for (const [index, name] of canonical.columnNames.entries()) {
      const target = canonicalSelect.targetList[index];
      if (!target) {
        return undefined;
      }
      targetByName.set(name, target);
    }
    const reorderedTargets: typeof canonicalSelect.targetList = [];
    for (const name of current.columnNames) {
      const target = targetByName.get(name);
      if (!target) {
        return undefined;
      }
      reorderedTargets.push(target);
    }
    canonicalSelect.targetList = reorderedTargets;
    const statements = canonicalAst.stmts?.flatMap(function getStatement(item) {
      return item.stmt ? [item.stmt] : [];
    });
    if (!statements || statements.length !== canonicalAst.stmts?.length) {
      return undefined;
    }
    return {
      definition: deparseSync(statements).trim(),
      columnNames: [...current.columnNames],
    };
  } catch {
    return undefined;
  }
}

export class SchemaService {
  private provider: DatabaseProvider;
  private config: ConnectionConfig;

  private schemaHandler: SchemaHandler;
  private commentHandler: CommentHandler;
  private extensionHandler: ExtensionHandler;
  private compositeTypeHandler: CompositeTypeHandler;
  private enumHandler: EnumHandler;
  private sequenceHandler: SequenceHandler;
  private functionHandler: FunctionHandler;
  private procedureHandler: ProcedureHandler;
  private viewHandler: ViewHandler;
  private triggerHandler: TriggerHandler;
  private sqlObjectHandler: SqlObjectHandler;

  constructor(provider: DatabaseProvider, config: ConnectionConfig) {
    this.provider = provider;
    this.config = config;

    this.schemaHandler = new SchemaHandler();
    this.commentHandler = new CommentHandler();
    this.extensionHandler = new ExtensionHandler();
    this.compositeTypeHandler = new CompositeTypeHandler();
    this.enumHandler = new EnumHandler();
    this.sequenceHandler = new SequenceHandler();
    this.functionHandler = new FunctionHandler();
    this.procedureHandler = new ProcedureHandler();
    this.viewHandler = new ViewHandler();
    this.triggerHandler = new TriggerHandler();
    this.sqlObjectHandler = new SqlObjectHandler();
  }

  async plan(
    schemaFile: string,
    schemas: string[] = ['public'],
    managementOptions: SchemaManagementOptions = {}
  ): Promise<MigrationPlan> {
    const client = await this.provider.createClient(this.config);

    try {
      const parsedSchema = await this.parseSchemaInput(schemaFile);
      const validation = this.provider.validateSchema(parsedSchema);
      if (!validation.valid) {
        for (const error of validation.errors) {
          Logger.error(`${error.code}: ${error.message}`);
          if (error.suggestion) {
            Logger.info(`  Suggestion: ${error.suggestion}`);
          }
        }
        throw new ValidationError("Schema validation failed for target database");
      }

      let filtered = parsedSchema;
      if (this.provider.supportsFeature("schemas")) {
        filtered = this.filterUnmanagedSchemas(schemas, parsedSchema);
      }

      const result = await this.buildCombinedPlan(
        client,
        filtered,
        schemas,
        managementOptions
      );
      const plan = result.plan;

      if (!plan.hasChanges) {
        Logger.success("No changes needed - database is up to date");
      } else {
        const totalChanges = result.totalChanges;
        Logger.warning(`Found ${totalChanges} change(s) to apply:`);
        console.log();

        if (result.transactionalPreview.length > 0) {
          Logger.info("Transactional changes:");
          result.transactionalPreview.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

        if (result.concurrentPreview.length > 0) {
          Logger.info("Concurrent changes (non-transactional):");
          result.concurrentPreview.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

      }

      return plan;
    } finally {
      await client.end();
    }
  }

  async apply(
    schemaFile: string,
    schemas: string[] = ['public'],
    autoApprove: boolean = false,
    lockOptions?: AdvisoryLockOptions,
    dryRun: boolean = false,
    strict: boolean = false,
    managementOptions: SchemaManagementOptions = {}
  ): Promise<MigrationPlan> {
    const client = await this.provider.createClient(this.config);

    try {
      if (lockOptions && !dryRun && this.provider.acquireAdvisoryLock) {
        await this.provider.acquireAdvisoryLock(client, lockOptions);
      }

      const parsedSchema = await this.parseSchemaInput(schemaFile);
      const validation = this.provider.validateSchema(parsedSchema);
      if (!validation.valid) {
        for (const error of validation.errors) {
          Logger.error(`${error.code}: ${error.message}`);
          if (error.suggestion) {
            Logger.info(`  Suggestion: ${error.suggestion}`);
          }
        }
        throw new ValidationError("Schema validation failed for target database");
      }

      let filtered = parsedSchema;
      if (this.provider.supportsFeature("schemas")) {
        const originalCount = this.countObjects(parsedSchema);
        filtered = this.filterUnmanagedSchemas(schemas, parsedSchema);
        const filteredCount = this.countObjects(filtered);
        const ignoredCount = originalCount - filteredCount;
        if (ignoredCount > 0) {
          Logger.warning(`Ignored ${ignoredCount} object(s) from unmanaged schemas`);
        }
      }

      const result = await this.buildCombinedPlan(
        client,
        filtered,
        schemas,
        managementOptions
      );
      const combinedPlan = result.plan;
      const totalChanges = result.totalChanges;

      if (totalChanges === 0) {
        Logger.success("No changes needed - database is up to date");
        return {
          preTransactional: [],
          transactional: [],
          concurrent: [],
          deferred: [],
          hasChanges: false
        };
      }

      if (strict) {
        const destructiveStatements = this.getDestructiveStatements(combinedPlan);
        if (destructiveStatements.length > 0) {
          throw new StrictModeError(
            "Strict mode blocked destructive migration statements",
            destructiveStatements
          );
        }
      }

      const { OutputFormatter } = await import("../../utils/output-formatter");

      Logger.print(OutputFormatter.summary(`${totalChanges} changes`));

      if (result.preTransactionalPreview.length > 0) {
        Logger.print(
          OutputFormatter.warningSection(
            "Pre-transactional (committed before remaining changes)"
          )
        );
        Logger.print(OutputFormatter.box(result.preTransactionalPreview));
      }

      if (result.transactionalPreview.length > 0) {
        Logger.print(OutputFormatter.section("Transactional"));
        Logger.print(OutputFormatter.box(result.transactionalPreview));
      }

      if (result.concurrentPreview.length > 0) {
        Logger.print(OutputFormatter.warningSection("Concurrent (non-transactional)"));
        Logger.print(OutputFormatter.box(result.concurrentPreview));
      }

      console.log();

      if (dryRun) {
        Logger.info("Dry run complete - no changes were made");
        return combinedPlan;
      }

      if (!autoApprove) {
        if (!this.canPromptForConfirmation()) {
          throw new ValidationError(
            "Confirmation prompt requires interactive terminal. Use --auto-approve to continue",
            "apply",
            "auto-approve",
            autoApprove
          );
        }
        const confirmed = await this.promptForConfirmation();
        if (!confirmed) {
          Logger.info("Apply cancelled");
          return combinedPlan;
        }
      }

      await this.executePlan(client, combinedPlan, autoApprove);
      return combinedPlan;
    } finally {
      if (lockOptions && !dryRun && this.provider.releaseAdvisoryLock) {
        await this.provider.releaseAdvisoryLock(client, lockOptions.lockName);
      }
      await client.end();
    }
  }

  /**
   * Generates a desired schema that reproduces the managed state of the
   * database. The result is verified by planning it against the same
   * database, so a pulled file never implies a change on its first apply.
   */
  async pull(
    schemas: string[] = ['public'],
    managementOptions: SchemaManagementOptions = {}
  ): Promise<PullResult> {
    const client = await this.provider.createClient(this.config);
    const wasSilent = Logger.isSilent();
    Logger.setSilent(true);

    try {
      const inspected = await this.inspectCurrentState(
        client,
        schemas,
        managementOptions
      );
      const managed = normalizePulledSchema(
        this.selectManagedState(inspected, schemas),
        this.provider.dialect,
        {
          context: await this.provider.getMigrationContext?.(client),
          bootstrapPublicSchemaOwners:
            await this.getBootstrapPublicSchemaOwners(client),
        }
      );
      const creation = await this.buildCombinedPlan(
        client,
        managed,
        schemas,
        managementOptions,
        createEmptySchemaState(),
        true
      );
      const statements = toDesiredStatements([
        ...(creation.plan.preTransactional ?? []),
        ...creation.plan.transactional,
        ...creation.plan.concurrent,
        ...creation.plan.deferred,
      ]);
      const sql = renderPulledSchema(statements, {
        dialect: this.provider.dialect,
        schemas,
      });

      await this.verifyPulledSchema(
        client,
        sql,
        schemas,
        managementOptions,
        inspected
      );

      return { sql, statements };
    } finally {
      Logger.setSilent(wasSilent);
      await client.end();
    }
  }

  /**
   * initdb makes the public schema owned by pg_database_owner on PostgreSQL
   * 15 and later, and by the bootstrap superuser before that.
   */
  private async getBootstrapPublicSchemaOwners(
    client: DatabaseClient
  ): Promise<string[]> {
    if (this.provider.dialect !== "postgres") {
      return [];
    }
    const result = await client.query<{ name: string }>(
      "SELECT pg_get_userbyid(10) AS name"
    );
    return ["pg_database_owner", ...result.rows.map(function getName(row) {
      return row.name;
    })];
  }

  /**
   * The managed state is exactly what an empty desired schema would remove:
   * cluster-global objects, implicit ACL entries, and extension members stay
   * outside the pulled model just as they stay outside a plan.
   */
  private selectManagedState(
    inspected: ParsedSchema,
    schemas: string[]
  ): ParsedSchema {
    return {
      ...inspected,
      extensions: this.filterCurrentExtensions(
        inspected.extensions,
        [],
        schemas
      ),
      comments: this.filterCurrentComments(inspected.comments, []),
      sqlObjects: this.filterCurrentSqlObjects(
        inspected.sqlObjects || [],
        [],
        []
      ),
    };
  }

  private async verifyPulledSchema(
    client: DatabaseClient,
    sql: string,
    schemas: string[],
    managementOptions: SchemaManagementOptions,
    inspected: ParsedSchema
  ): Promise<void> {
    let parsed: ParsedSchema;
    try {
      parsed = await this.provider.parseSchema(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PullVerificationError(
        `The generated schema could not be parsed as a desired schema: ${message}`,
        []
      );
    }

    const validation = this.provider.validateSchema(parsed);
    if (!validation.valid) {
      throw new PullVerificationError(
        "The generated schema failed validation for the source database",
        validation.errors.map(function describe(error) {
          return `${error.code}: ${error.message}`;
        })
      );
    }

    const desired = this.provider.supportsFeature("schemas")
      ? this.filterUnmanagedSchemas(schemas, parsed)
      : parsed;
    const replan = await this.buildCombinedPlan(
      client,
      desired,
      schemas,
      managementOptions,
      inspected
    );
    if (replan.totalChanges > 0) {
      throw new PullVerificationError(
        "The generated schema does not reproduce the database: planning it against the source database still produces changes",
        [
          ...replan.preTransactionalPreview,
          ...replan.transactionalPreview,
          ...replan.concurrentPreview,
          ...replan.deferredPreview,
        ]
      );
    }
  }

  private async executePlan(
    client: DatabaseClient,
    plan: MigrationPlan,
    autoApprove: boolean
  ): Promise<void> {
    const preTransactional = plan.preTransactional ?? [];
    if (preTransactional.length > 0) {
      await this.provider.executeInTransaction(client, preTransactional);
    }

    if (plan.transactional.length > 0) {
      await this.provider.executeInTransaction(client, plan.transactional);
    }

    if (plan.concurrent.length > 0) {
      const statement = plan.concurrent[0]!;
      const creation = this.getConcurrentIndexCreation(statement);
      const existingTarget = creation
        ? await this.getPostgresIndexState(client, creation.index)
        : undefined;
      try {
        await client.query(statement);
        Logger.success(`Executed: ${statement.substring(0, 60)}...`);
      } catch (error) {
        await this.cleanupFailedConcurrentIndexCreate(
          client,
          creation?.index,
          existingTarget
        );
        Logger.error(`Failed: ${statement}`);
        throw error;
      }
    }

    if (plan.deferred.length > 0) {
      await this.provider.executeInTransaction(client, plan.deferred);
    }
  }

  private async promptForConfirmation(): Promise<boolean> {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('Do you want to apply these changes? (yes/no): ', (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === 'yes' || normalized === 'y');
      });
    });
  }

  private canPromptForConfirmation(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private async parseSchemaInput(input: string): Promise<ParsedSchema> {
    const trimmed = input.trim();

    if (trimmed === "") {
      return await this.provider.parseSchema(trimmed);
    }

    const looksLikeSql =
      input.includes(";") ||
      input.includes("\n") ||
      input.length > 500 ||
      /^\s*(create|alter|drop|comment|grant|revoke|insert|update|delete|with|select)\s/i.test(
        input
      );

    const looksLikePath =
      input.includes("/") || input.includes("\\") || /\.sql$/i.test(input);

    const fs = await import("fs/promises");

    if (looksLikePath && !looksLikeSql) {
      const content = await fs.readFile(input, "utf-8");
      return await this.provider.parseSchema(content, input);
    }

    if (looksLikeSql) {
      return await this.provider.parseSchema(input);
    }

    try {
      const content = await fs.readFile(input, 'utf-8');
      return await this.provider.parseSchema(content, input);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? ((error as { code: string }).code as string)
          : undefined;

      if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG") {
        return await this.provider.parseSchema(input);
      }

      throw error;
    }
  }

  private getDestructiveStatements(plan: MigrationPlan): string[] {
    const statements = [
      ...(plan.preTransactional ?? []),
      ...plan.transactional,
      ...plan.concurrent,
      ...plan.deferred,
    ];
    const createdServerNames = new Set<string>();
    for (const statement of statements) {
      const serverName = getCreatedPostgresServerName(statement);
      if (serverName) {
        createdServerNames.add(serverName);
      }
    }
    return statements.filter(function isUnapprovedDestructive(statement) {
      if (!isDestructiveStatement(statement)) {
        return false;
      }
      const serverName = getPostgresServerOwnerTransferName(statement);
      return !serverName || !createdServerNames.has(serverName);
    });
  }

  private getConcurrentIndexCreation(statement: string):
    | {
      index: { schema: string; name: string };
      table: { schema: string; name: string };
    }
    | undefined {
    if (this.provider.dialect !== "postgres") {
      return undefined;
    }
    let node:
      | {
        concurrent?: boolean;
        idxname?: string;
        relation?: { schemaname?: string; relname?: string };
      }
      | undefined;
    try {
      const parsed = parseSync(statement) as unknown as {
        stmts?: Array<{ stmt?: { IndexStmt?: unknown } }>;
      };
      node = parsed.stmts?.[0]?.stmt?.IndexStmt as typeof node;
    } catch {
      return undefined;
    }
    if (!node?.concurrent || !node.idxname || !node.relation?.relname) {
      return undefined;
    }
    return {
      index: {
        schema: node.relation.schemaname || "public",
        name: node.idxname,
      },
      table: {
        schema: node.relation.schemaname || "public",
        name: node.relation.relname,
      },
    };
  }

  private transactionalizeNewTableConcurrentIndexes(
    statements: string[],
    currentTables: { name: string; schema?: string }[]
  ): { transactional: string[]; concurrent: string[] } {
    const currentTableKeys = new Set(currentTables.map(function (table) {
      return `${table.schema || "public"}.${table.name}`;
    }));
    const transactional: string[] = [];
    const concurrent: string[] = [];

    for (const statement of statements) {
      const creation = this.getConcurrentIndexCreation(statement);
      const tableKey = creation && `${creation.table.schema}.${creation.table.name}`;
      if (creation && tableKey && !currentTableKeys.has(tableKey)) {
        transactional.push(statement.replace(/\s+CONCURRENTLY\b/i, ""));
      } else {
        concurrent.push(statement);
      }
    }
    return { transactional, concurrent };
  }

  private isConcurrentIndexDrop(statement: string): boolean {
    if (this.provider.dialect !== "postgres") {
      return false;
    }
    try {
      const parsed = parseSync(statement) as unknown as {
        stmts?: Array<{
          stmt?: {
            DropStmt?: { concurrent?: boolean; removeType?: string };
          };
        }>;
      };
      const node = parsed.stmts?.[0]?.stmt?.DropStmt;
      return node?.concurrent === true && node.removeType === "OBJECT_INDEX";
    } catch {
      return false;
    }
  }

  private transactionalizeMixedConcurrentIndexDrops(
    statements: string[],
    hasOtherMigrationWork: boolean
  ): { transactional: string[]; concurrent: string[] } {
    const transactional: string[] = [];
    const concurrent: string[] = [];

    for (const statement of statements) {
      if (hasOtherMigrationWork && this.isConcurrentIndexDrop(statement)) {
        transactional.push(statement.replace(/\s+CONCURRENTLY\b/i, ""));
      } else {
        concurrent.push(statement);
      }
    }
    return { transactional, concurrent };
  }

  private async getPostgresIndexState(
    client: DatabaseClient,
    target: { schema: string; name: string }
  ): Promise<{ invalid: boolean } | undefined> {
    const result = await client.query<{ invalid: boolean }>(
      `SELECT NOT index_catalog.indisvalid AS invalid
       FROM pg_class index_relation
       JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
       JOIN pg_index index_catalog ON index_catalog.indexrelid = index_relation.oid
       WHERE namespace.nspname = $1 AND index_relation.relname = $2`,
      [target.schema, target.name]
    );
    return result.rows[0];
  }

  private async cleanupFailedConcurrentIndexCreate(
    client: DatabaseClient,
    target: { schema: string; name: string } | undefined,
    existingTarget: { invalid: boolean } | undefined
  ): Promise<void> {
    if (!target || existingTarget) {
      return;
    }
    const state = await this.getPostgresIndexState(client, target);
    if (!state?.invalid) {
      return;
    }
    await client.query(
      `DROP INDEX CONCURRENTLY ${this.quoteIdentifier(target.schema)}.${this.quoteIdentifier(target.name)};`
    );
  }

  private filterUnmanagedSchemas(
    managedSchemas: string[],
    parsed: ParsedSchema
  ): ParsedSchema {
    function isManaged(schema: string | undefined): boolean {
      return managedSchemas.includes(schema || 'public');
    }

    return {
      tables: parsed.tables.filter(t => isManaged(t.schema)),
      enums: parsed.enums.filter(e => isManaged(e.schema)),
      compositeTypes: (parsed.compositeTypes || []).filter(t => isManaged(t.schema)),
      views: parsed.views.filter(v => isManaged(v.schema)),
      functions: parsed.functions.filter(f => isManaged(f.schema)),
      procedures: parsed.procedures.filter(p => isManaged(p.schema)),
      triggers: parsed.triggers.filter(t => isManaged(t.schema)),
      sequences: parsed.sequences.filter(s => isManaged(s.schema)),
      extensions: parsed.extensions,
      schemas: parsed.schemas.filter(s => managedSchemas.includes(s.name)),
      comments: parsed.comments.filter(function isManagedComment(comment) {
        if (comment.objectType === "SCHEMA") {
          return managedSchemas.includes(comment.objectName);
        }
        return isManaged(comment.schemaName);
      }),
      sqlObjects: (parsed.sqlObjects || []).filter(function (object) {
        return object.schema === undefined || isManaged(object.schema);
      }),
    };
  }

  private countObjects(parsed: ParsedSchema): number {
    return parsed.tables.length + parsed.enums.length + (parsed.compositeTypes || []).length + parsed.views.length +
      parsed.functions.length + parsed.procedures.length + parsed.triggers.length +
      parsed.sequences.length + (parsed.sqlObjects || []).length;
  }

  private filterCurrentSqlObjects(
    currentObjects: NonNullable<ParsedSchema["sqlObjects"]>,
    desiredObjects: NonNullable<ParsedSchema["sqlObjects"]>,
    desiredSchemas: ParsedSchema["schemas"] = []
  ) {
    const desiredKeys = new Set(desiredObjects.map(function (item) {
      return item.key;
    }));
    const desiredForeignServers = new Set(
      desiredObjects
        .filter(function isForeignServer(item) {
          return item.kind === "foreign-server";
        })
        .map(function getForeignServerName(item) {
          return item.name;
        })
    );
    const desiredRoles = new Set(
      desiredObjects
        .filter(function isRole(item) {
          return item.kind === "role";
        })
        .map(function getRoleName(item) {
          return item.name;
        })
    );
    const desiredSchemaNames = new Set(
      desiredSchemas.map(function getSchemaName(schema) {
        return schema.name;
      })
    );

    return currentObjects.filter(function (item) {
      if (item.kind === "default-privilege") {
        const definition = item.defaultPrivilegeDefinition;
        return definition !== undefined &&
          desiredRoles.has(definition.owner) &&
          (!definition.schema || desiredSchemaNames.has(definition.schema));
      }
      if (
        item.kind === "grant" &&
        item.grantDefinition?.implicitDefault === true &&
        !desiredKeys.has(item.key)
      ) {
        return false;
      }
      if (item.schema) {
        return true;
      }
      if (
        item.kind === "grant" &&
        item.grantDefinition?.objectType === "FOREIGN SERVER" &&
        desiredForeignServers.has(item.grantDefinition.objectName)
      ) {
        return true;
      }
      return desiredKeys.has(item.key);
    });
  }

  /**
   * initdb gives the standard public schema a stock comment. Like an implicit
   * ACL entry, it is database bootstrap state rather than a managed comment,
   * so it is reconciled only when the desired schema declares that comment.
   */
  private filterCurrentComments(
    currentComments: ParsedSchema["comments"],
    desiredComments: ParsedSchema["comments"]
  ): ParsedSchema["comments"] {
    if (this.provider.dialect !== "postgres") {
      return currentComments;
    }
    const declaresPublicSchemaComment = desiredComments.some(isPublicSchemaComment);
    if (declaresPublicSchemaComment) {
      return currentComments;
    }
    return currentComments.filter(function isManagedComment(comment) {
      return !isPublicSchemaComment(comment) ||
        comment.comment !== POSTGRES_PUBLIC_SCHEMA_BOOTSTRAP_COMMENT;
    });
  }

  private filterCurrentExtensions(
    currentExtensions: Extension[],
    desiredExtensions: Extension[],
    managedSchemas: string[]
  ): Extension[] {
    const byName = new Map(currentExtensions.map(function mapExtension(extension) {
      return [extension.name, extension] as const;
    }));
    const desiredNames = new Set(desiredExtensions.map(function mapName(extension) {
      return extension.name;
    }));
    const managedSchemaNames = new Set(managedSchemas);
    const includedNames = new Set<string>();

    function includeWithDependencies(name: string): void {
      if (includedNames.has(name)) {
        return;
      }
      const extension = byName.get(name);
      if (!extension) {
        return;
      }
      includedNames.add(name);
      for (const dependency of extension.dependencies || []) {
        includeWithDependencies(dependency);
      }
    }

    for (const extension of currentExtensions) {
      const schema = extension.schema || "public";
      if (managedSchemaNames.has(schema) || desiredNames.has(extension.name)) {
        includeWithDependencies(extension.name);
      }
    }

    const externallyRequiredNames = new Set<string>();

    function protectDependencies(name: string): void {
      const extension = byName.get(name);
      if (!extension) {
        return;
      }
      for (const dependency of extension.dependencies || []) {
        if (externallyRequiredNames.has(dependency)) {
          continue;
        }
        externallyRequiredNames.add(dependency);
        protectDependencies(dependency);
      }
    }

    for (const extension of currentExtensions) {
      if (!includedNames.has(extension.name)) {
        protectDependencies(extension.name);
      }
    }

    return currentExtensions.filter(function isIncluded(extension) {
      return includedNames.has(extension.name) &&
        (desiredNames.has(extension.name) ||
          !externallyRequiredNames.has(extension.name));
    });
  }

  /**
   * Reads every object family the planner reconciles, honoring the
   * management options that exclude comments or privileges from the model.
   */
  private async inspectCurrentState(
    client: DatabaseClient,
    schemas: string[],
    managementOptions: SchemaManagementOptions = {}
  ): Promise<ParsedSchema> {
    const tables = await this.provider.getCurrentSchema(client, schemas);
    const enums = await this.provider.getCurrentEnums(client, schemas);
    const compositeTypes = await this.provider.getCurrentCompositeTypes?.(client, schemas) || [];
    const views = await this.provider.getCurrentViews(client, schemas);
    const functions = await this.provider.getCurrentFunctions(client, schemas);
    const procedures = await this.provider.getCurrentProcedures(client, schemas);
    const triggers = await this.provider.getCurrentTriggers(client, schemas);
    const sequences = await this.provider.getCurrentSequences(client, schemas);
    const getCurrentExtensions = this.provider.getCurrentExtensions.bind(this.provider);
    const extensions = await getCurrentExtensions(client, schemas);
    const currentSchemas = await this.provider.getCurrentSchemas(client, schemas);
    const comments = managementOptions.manageComments === false
      ? []
      : await this.provider.getCurrentComments(client, schemas);
    const inspectedSqlObjects =
      await this.provider.getCurrentSqlObjects?.(client, schemas) || [];
    const sqlObjects = inspectedSqlObjects.filter(function isManagedSqlObject(object) {
      return managementOptions.managePrivileges !== false ||
        (object.kind !== "grant" && object.kind !== "default-privilege");
    });

    return {
      tables,
      enums,
      compositeTypes,
      views,
      functions,
      procedures,
      triggers,
      sequences,
      extensions,
      schemas: currentSchemas,
      comments,
      sqlObjects,
    };
  }

  private async buildCombinedPlan(
    client: DatabaseClient,
    filtered: ParsedSchema,
    schemas: string[],
    managementOptions: SchemaManagementOptions = {},
    currentState?: ParsedSchema,
    renderDesiredSchema: boolean = false
  ): Promise<{
    plan: MigrationPlan;
    totalChanges: number;
    preTransactionalPreview: string[];
    transactionalPreview: string[];
    deferredPreview: string[];
    concurrentPreview: string[];
  }> {
    const desiredSchema = filtered.tables;
    const desiredEnums = filtered.enums;
    const desiredCompositeTypes = filtered.compositeTypes || [];
    const desiredViews = filtered.views;
    const desiredFunctions = filtered.functions;
    const desiredProcedures = filtered.procedures;
    const desiredTriggers = filtered.triggers;
    const desiredSequences = filtered.sequences;
    const desiredExtensions = filtered.extensions;
    const desiredSchemas = filtered.schemas || [];
    const desiredComments = managementOptions.manageComments === false
      ? []
      : filtered.comments || [];
    const desiredSqlObjects = (filtered.sqlObjects || []).filter(
      function isManagedSqlObject(object) {
        return managementOptions.managePrivileges !== false ||
          (object.kind !== "grant" && object.kind !== "default-privilege");
      }
    );

    const inspected = currentState ??
      await this.inspectCurrentState(client, schemas, managementOptions);
    const currentSchema = inspected.tables;
    const currentEnums = inspected.enums;
    const currentCompositeTypes = inspected.compositeTypes || [];
    const currentViews = inspected.views;
    const currentFunctions = inspected.functions;
    const currentProcedures = inspected.procedures;
    const currentTriggers = inspected.triggers;
    const currentSequences = inspected.sequences;
    const currentExtensions = this.filterCurrentExtensions(
      inspected.extensions,
      desiredExtensions,
      schemas
    );
    const currentSchemas = inspected.schemas;
    const currentComments = this.filterCurrentComments(
      inspected.comments,
      desiredComments
    );
    const currentSqlObjects = this.filterCurrentSqlObjects(
      inspected.sqlObjects || [],
      desiredSqlObjects,
      desiredSchemas
    );
    const sqliteIdentifiers = this.provider.dialect === "sqlite"
      ? collectSQLiteSchemaIdentifiers(
        [...desiredSchema, ...currentSchema],
        [...desiredViews, ...currentViews],
        [...desiredTriggers, ...currentTriggers]
      )
      : [];
    const inspectedMigrationContext =
      await this.provider.getMigrationContext?.(client);
    const migrationContext = {
      ...inspectedMigrationContext,
      constraintValidationManaged:
        managementOptions.manageConstraintValidation !== false,
      ...(renderDesiredSchema ? { renderDesiredSchema } : {}),
    };
    if (this.provider.dialect === "postgres") {
      const desiredTypeModifierSchema = {
        tables: desiredSchema,
        compositeTypes: desiredCompositeTypes,
        sqlObjects: desiredSqlObjects,
      };
      validatePostgresNumericModifiers(
        desiredTypeModifierSchema,
        migrationContext?.postgresVersionNum
      );
      validatePostgresTemporalModifiers(desiredTypeModifierSchema);
      validatePostgresLengthModifiers(desiredTypeModifierSchema);
    }

    let schemaStatements: string[] = [];
    let extensionCreateStatements: string[] = [];
    let extensionDropStatements: string[] = [];
    let enumTypeCreateOperations: PostgresTypeStatement[] = [];
    let enumPreTransactionalStatements: string[] = [];
    let compositeTypeCreateOperations: PostgresTypeStatement[] = [];
    let sequencePlan: SequenceStatementPlan = {
      beforeTables: [],
      afterTables: [],
    };
    let functionStatements: string[] = [];
    let procedureStatements: string[] = [];
    let triggerStatements: string[] = [];
    let commentStatements: string[] = [];

    if (this.provider.supportsFeature("schemas")) {
      schemaStatements = this.schemaHandler.generateStatements(desiredSchemas, currentSchemas);
    }

    if (this.provider.supportsFeature("extensions")) {
      const extResult = this.extensionHandler.generateStatements(desiredExtensions, currentExtensions);
      extensionCreateStatements = extResult.create;
      extensionDropStatements = extResult.drop;
    }

    if (this.provider.supportsFeature("enums")) {
      const enumResult = this.enumHandler.generateStatements(desiredEnums, currentEnums);
      enumTypeCreateOperations = enumResult.typeStatements;
      enumPreTransactionalStatements = enumResult.preTransactional;
    }

    if (this.provider.supportsFeature("composite_types")) {
      const compositeTypeResult = this.compositeTypeHandler.generateStatements(
        desiredCompositeTypes,
        currentCompositeTypes
      );
      compositeTypeCreateOperations = compositeTypeResult.typeStatements;
    }

    const tablePlan = this.provider.generateMigrationPlan(
      desiredSchema,
      currentSchema,
      migrationContext
    );
    const tableStatements = tablePlan.transactional;
    let deferredTableStatements = tablePlan.deferred;
    let concurrentStatements = tablePlan.concurrent;

    if (this.provider.supportsFeature("sequences")) {
      sequencePlan = this.sequenceHandler.generateStatementPlan(
        desiredSequences,
        currentSequences,
        migrationContext
      );
    }
    const plannedTriggerRemovals = this.getRemovedTriggerDescriptions(
      desiredTriggers,
      currentTriggers
    );

    if (this.provider.supportsFeature("stored_functions")) {
      functionStatements = this.functionHandler.generateStatements(
        desiredFunctions,
        currentFunctions,
        plannedTriggerRemovals
      );
    }
    this.validateGeneratedColumnReferences(desiredSchema);
    this.validateGeneratedColumnInheritance(desiredSchema, currentSchema);

    let virtualGeneratedOperatorInfo = {
      userDefinedKeys: new Set<string>(),
      builtInNames: new Set<string>(),
    };
    if (hasVirtualGeneratedColumns(desiredSchema)) {
      virtualGeneratedOperatorInfo = await this.getVirtualGeneratedOperatorInfo(
        client,
        schemas
      );
    }
    this.validateVirtualGeneratedFunctionDependencies(
      desiredSchema,
      desiredFunctions,
      desiredEnums,
      desiredCompositeTypes,
      desiredSqlObjects,
      currentEnums,
      currentCompositeTypes,
      currentSqlObjects,
      currentFunctions,
      currentSchema,
      virtualGeneratedOperatorInfo.userDefinedKeys,
      virtualGeneratedOperatorInfo.builtInNames
    );
    const generatedColumnFunctionStatements =
      this.getGeneratedColumnFunctionStatements(
        functionStatements,
        desiredSchema,
        currentSchema
      );
    functionStatements = generatedColumnFunctionStatements.remaining;

    if (this.provider.supportsFeature("stored_procedures")) {
      procedureStatements = this.procedureHandler.generateStatements(
        desiredProcedures,
        currentProcedures,
        plannedTriggerRemovals
      );
    }

    const normalizedDesiredViews = await this.canonicalizeDesiredViews(
      client,
      desiredViews,
      currentViews
    );
    let viewStatements = this.viewHandler.generateStatements(
      normalizedDesiredViews,
      currentViews,
      migrationContext,
      sqliteIdentifiers
    );

    if (this.provider.supportsFeature("triggers")) {
      triggerStatements = this.triggerHandler.generateStatements(
        desiredTriggers,
        currentTriggers,
        sqliteIdentifiers
      );
    }

    let preTableTriggerStatements: string[] = [];
    let preTableViewStatements: string[] = [];
    if (this.provider.dialect === "sqlite") {
      const recreatesTable = hasSQLiteTableRecreation(tableStatements);
      const replacesOrDropsView = viewStatements.some(function (statement) {
        return /^DROP VIEW\s+/i.test(statement.trim());
      });

      if (recreatesTable) {
        preTableTriggerStatements = this.triggerHandler.generateStatements(
          [],
          currentTriggers,
          sqliteIdentifiers
        );
        preTableViewStatements = this.viewHandler.generateStatements(
          [],
          currentViews,
          migrationContext,
          sqliteIdentifiers
        );
        viewStatements = this.viewHandler.generateStatements(
          normalizedDesiredViews,
          [],
          migrationContext,
          sqliteIdentifiers
        );
        triggerStatements = this.triggerHandler.generateStatements(
          desiredTriggers,
          [],
          sqliteIdentifiers
        );
      } else if (replacesOrDropsView && this.provider.supportsFeature("triggers")) {
        preTableTriggerStatements = this.triggerHandler.generateStatements(
          [],
          currentTriggers,
          sqliteIdentifiers
        );
        triggerStatements = this.triggerHandler.generateStatements(
          desiredTriggers,
          [],
          sqliteIdentifiers
        );
      }
    } else if (this.provider.dialect === "postgres") {
      preTableTriggerStatements = triggerStatements.filter(function isDrop(
        statement
      ) {
        return /^DROP\s+TRIGGER\b/i.test(statement.trim());
      });
      triggerStatements = triggerStatements.filter(function isNotDrop(
        statement
      ) {
        return !/^DROP\s+TRIGGER\b/i.test(statement.trim());
      });
      preTableViewStatements = viewStatements.filter(isPostgresViewDrop);
      viewStatements = viewStatements.filter(function isNotDrop(statement) {
        return !isPostgresViewDrop(statement);
      });
    }

    commentStatements = this.commentHandler.generateStatements(desiredComments, currentComments);

    let enumTypeRemovalOperations: PostgresTypeStatement[] = [];
    let compositeTypeRemovalOperations: PostgresTypeStatement[] = [];
    if (this.provider.supportsFeature("enums")) {
      enumTypeRemovalOperations = this.enumHandler.generateRemovalTypeStatements(
        desiredEnums,
        currentEnums,
        {
          desiredTables: desiredSchema,
          desiredCompositeTypes,
          desiredViews: normalizedDesiredViews,
          desiredSqlObjects,
          desiredFunctions,
          desiredProcedures,
          desiredTriggers,
          managedSchemas: schemas,
        }
      );
    }

    if (this.provider.supportsFeature("composite_types")) {
      compositeTypeRemovalOperations =
        this.compositeTypeHandler.generateRemovalTypeStatements(
          desiredCompositeTypes,
          currentCompositeTypes,
          desiredSchema,
          schemas,
          desiredSqlObjects,
          normalizedDesiredViews,
          desiredFunctions,
          desiredProcedures,
          desiredTriggers
        );
    }

    const sqlObjectPlan = await this.sqlObjectHandler.generateStatements(
      desiredSqlObjects,
      currentSqlObjects,
      {
        desiredTables: desiredSchema,
        desiredViews: normalizedDesiredViews,
        desiredCompositeTypes,
        desiredFunctions,
        currentFunctions,
        desiredProcedures,
        desiredTriggers,
        managedSchemas: schemas,
        currentUser: migrationContext?.currentUser,
        sessionUser: migrationContext?.sessionUser,
      }
    );

    const typeCreateStatements = orderPostgresTypeStatements(
      [
        ...enumTypeCreateOperations,
        ...compositeTypeCreateOperations,
        ...sqlObjectPlan.typeCreateOperations,
      ],
      desiredEnums,
      desiredCompositeTypes,
      desiredSqlObjects
    );
    const typeRemovalStatements = orderPostgresTypeStatements(
      [
        ...enumTypeRemovalOperations,
        ...compositeTypeRemovalOperations,
        ...sqlObjectPlan.typeDropOperations,
      ],
      currentEnums,
      currentCompositeTypes,
      currentSqlObjects,
      true
    );
    const hasPartitionDrops = sqlObjectPlan.partitionDrop.length > 0;
    const prePartitionTriggerStatements = hasPartitionDrops
      ? preTableTriggerStatements
      : [];
    const postPartitionTriggerStatements = hasPartitionDrops
      ? []
      : preTableTriggerStatements;
    const prePartitionViewStatements = hasPartitionDrops
      ? preTableViewStatements
      : [];
    const postPartitionViewStatements = hasPartitionDrops
      ? []
      : preTableViewStatements;
    const prePartitionTableStatements = hasPartitionDrops
      ? tableStatements.filter(isPostgresConstraintDrop)
      : [];
    const postPartitionTableStatements = hasPartitionDrops
      ? tableStatements.filter(function isNotConstraintDrop(statement) {
          return !isPostgresConstraintDrop(statement);
        })
      : tableStatements;

    let transactionalPreview = [
      ...sqlObjectPlan.bootstrapCreate,
      ...sqlObjectPlan.preSchemaCreate,
      ...schemaStatements,
      ...sqlObjectPlan.postSchemaCreate,
      ...extensionCreateStatements,
      ...sqlObjectPlan.typeReplaceDrop,
      ...typeCreateStatements,
      ...sqlObjectPlan.typeAlter,
      ...sequencePlan.beforeTables,
      ...generatedColumnFunctionStatements.beforeTables,
      ...sqlObjectPlan.earlyDrop,
      ...prePartitionTriggerStatements,
      ...prePartitionViewStatements,
      ...prePartitionTableStatements,
      ...sqlObjectPlan.partitionDrop,
      ...sqlObjectPlan.preTableCreate,
      ...postPartitionTriggerStatements,
      ...postPartitionViewStatements,
      ...postPartitionTableStatements,
      ...sqlObjectPlan.postTableCreate,
      ...sequencePlan.afterTables,
      ...functionStatements,
      ...procedureStatements,
      ...viewStatements,
      ...triggerStatements,
      ...sqlObjectPlan.postRoutineCreate,
      ...commentStatements,
      ...sqlObjectPlan.finalCreate,
      ...typeRemovalStatements,
      ...sqlObjectPlan.lateDrop,
      ...extensionDropStatements,
    ];

    const normalizedConcurrent = this.transactionalizeNewTableConcurrentIndexes(
      concurrentStatements,
      currentSchema
    );
    transactionalPreview = [
      ...transactionalPreview,
      ...normalizedConcurrent.transactional,
    ];
    concurrentStatements = normalizedConcurrent.concurrent;

    const normalizedDrops = this.transactionalizeMixedConcurrentIndexDrops(
      concurrentStatements,
      enumPreTransactionalStatements.length > 0 ||
        transactionalPreview.length > 0 ||
        deferredTableStatements.length > 0 ||
        concurrentStatements.length > 1
    );
    transactionalPreview = [
      ...transactionalPreview,
      ...normalizedDrops.transactional,
    ];
    concurrentStatements = normalizedDrops.concurrent;

    if (concurrentStatements.length === 0 && deferredTableStatements.length > 0) {
      transactionalPreview = [
        ...transactionalPreview,
        ...deferredTableStatements,
      ];
      deferredTableStatements = [];
    }

    if (enumPreTransactionalStatements.length > 0 && (
      transactionalPreview.length > 0 ||
      deferredTableStatements.length > 0 ||
      concurrentStatements.length > 0
    )) {
      throw new ValidationError(
        "PostgreSQL enum label additions must be applied in a standalone migration before other schema changes so a later failure cannot leave a committed label behind",
        "enum",
        "label addition",
        enumPreTransactionalStatements
      );
    }

    if (concurrentStatements.length > 0 && (
      concurrentStatements.length !== 1 ||
      enumPreTransactionalStatements.length > 0 ||
      transactionalPreview.length > 0 ||
      deferredTableStatements.length > 0
    )) {
      throw new ValidationError(
        "PostgreSQL concurrent index work must be applied as one standalone statement so a later failure cannot leave committed index state behind",
        "concurrent index",
        "standalone migration",
        concurrentStatements
      );
    }

    const totalChanges =
      enumPreTransactionalStatements.length +
      transactionalPreview.length +
      deferredTableStatements.length +
      concurrentStatements.length;

    if (totalChanges === 0) {
      return {
        plan: {
          preTransactional: [],
          transactional: [],
          concurrent: [],
          deferred: [],
          hasChanges: false,
        },
        totalChanges: 0,
        preTransactionalPreview: [],
        transactionalPreview: [],
        deferredPreview: [],
        concurrentPreview: [],
      };
    }

    return {
      plan: {
        preTransactional: enumPreTransactionalStatements,
        transactional: transactionalPreview,
        concurrent: concurrentStatements,
        deferred: deferredTableStatements,
        hasChanges: true,
      },
      totalChanges,
      preTransactionalPreview: enumPreTransactionalStatements,
      transactionalPreview,
      deferredPreview: deferredTableStatements,
      concurrentPreview: concurrentStatements,
    };
  }

  private getGeneratedColumnFunctionStatements(
    statements: string[],
    desiredTables: Table[],
    currentTables: Table[]
  ): { beforeTables: string[]; remaining: string[] } {
    if (this.provider.dialect !== "postgres") {
      return { beforeTables: [], remaining: statements };
    }

    const currentTableKeys = new Set(currentTables.map(function getTableKey(table) {
      return `${table.schema || "public"}.${table.name}`;
    }));
    const requiredFunctions = new Set<string>();

    for (const table of desiredTables) {
      const tableKey = `${table.schema || "public"}.${table.name}`;
      if (currentTableKeys.has(tableKey)) {
        continue;
      }
      for (const column of table.columns) {
        if (!column.generated) {
          continue;
        }
        for (const functionKey of getGeneratedExpressionFunctionKeys(
          column.generated.expression,
          table.schema || "public"
        )) {
          requiredFunctions.add(functionKey);
        }
      }
    }

    if (requiredFunctions.size === 0) {
      return { beforeTables: [], remaining: statements };
    }

    const beforeTables: string[] = [];
    const remaining: string[] = [];
    for (const statement of statements) {
      const functionKey = getCreatedFunctionKey(statement);
      if (functionKey && requiredFunctions.has(functionKey)) {
        beforeTables.push(statement);
      } else {
        remaining.push(statement);
      }
    }
    return { beforeTables, remaining };
  }

  private validateVirtualGeneratedFunctionDependencies(
    tables: Table[],
    functions: Function[],
    enums: Array<{ name: string; schema?: string }>,
    compositeTypes: Array<{ name: string; schema?: string }>,
    sqlObjects: Array<{ kind: string; name: string; schema?: string }>,
    currentEnums: Array<{ name: string; schema?: string }> = [],
    currentCompositeTypes: Array<{ name: string; schema?: string }> = [],
    currentSqlObjects: Array<{ kind: string; name: string; schema?: string }> = [],
    currentFunctions: Function[] = [],
    currentTables: Table[] = [],
    userDefinedOperatorKeys: Set<string> = new Set(),
    builtInOperatorNames: Set<string> = new Set()
  ): void {
    if (this.provider.dialect !== "postgres") {
      return;
    }

    const userDefinedFunctions = new Set([...functions, ...currentFunctions].map(function getFunctionKey(func) {
      return `${func.schema || "public"}.${func.name}`;
    }));
    const userDefinedTypes = new Set([
      ...enums,
      ...compositeTypes,
      ...currentEnums,
      ...currentCompositeTypes,
      ...tables,
      ...currentTables,
      ...sqlObjects,
      ...currentSqlObjects,
    ].filter(function isTypeObject(object) {
      return !('kind' in object) ||
        object.kind === "domain-type" || object.kind === "range-type";
    }).map(function getTypeKey(type) {
      return `${type.schema || "public"}.${type.name}`;
    }));
    for (const table of tables) {
      for (const column of table.columns) {
        if (!column.generated || column.generated.stored) {
          continue;
        }
        const typeKey = getDeclaredTypeKey(
          column.type,
          table.schema || "public"
        );
        if (typeKey && userDefinedTypes.has(typeKey)) {
          const tableName = `${table.schema || "public"}.${table.name}`;
          throw new ValidationError(
            `PostgreSQL virtual generated column ${tableName}.${column.name} cannot use user-defined type ${typeKey}; virtual generated expressions may use only built-in functions and types`,
            tableName,
            column.name,
            column.type
          );
        }
        const expressionTypeKey = getGeneratedExpressionTypeKeys(
          column.generated.expression,
          table.schema || "public"
        ).find(function findUserDefinedType(key) {
          return userDefinedTypes.has(key);
        });
        if (expressionTypeKey) {
          const tableName = `${table.schema || "public"}.${table.name}`;
          throw new ValidationError(
            `PostgreSQL virtual generated column ${tableName}.${column.name} cannot reference user-defined type ${expressionTypeKey}; virtual generated expressions may use only built-in functions and types`,
            tableName,
            column.name,
            column.generated.expression
          );
        }
        const expressionColumnNames = new Set(
          getGeneratedExpressionColumnNames(column.generated.expression)
        );
        const userDefinedExpressionColumn = table.columns.find(
          function findUserDefinedExpressionColumn(candidate) {
            const candidateTypeKey = getDeclaredTypeKey(
              candidate.type,
              table.schema || "public"
            );
            return expressionColumnNames.has(candidate.name) &&
              Boolean(candidateTypeKey && userDefinedTypes.has(candidateTypeKey));
          }
        );
        if (userDefinedExpressionColumn) {
          const tableName = `${table.schema || "public"}.${table.name}`;
          const referencedTypeKey = getDeclaredTypeKey(
            userDefinedExpressionColumn.type,
            table.schema || "public"
          )!;
          throw new ValidationError(
            `PostgreSQL virtual generated column ${tableName}.${column.name} cannot reference user-defined type ${referencedTypeKey} through column ${userDefinedExpressionColumn.name}; virtual generated expressions may use only built-in functions and types`,
            tableName,
            column.name,
            column.generated.expression
          );
        }
        const qualifiedOperatorKey = getGeneratedExpressionQualifiedOperatorKeys(
          column.generated.expression
        )[0];
        if (qualifiedOperatorKey && !qualifiedOperatorKey.startsWith("pg_catalog.")) {
          const tableName = `${table.schema || "public"}.${table.name}`;
          throw new ValidationError(
            `PostgreSQL virtual generated column ${tableName}.${column.name} cannot reference user-defined operator ${qualifiedOperatorKey}; virtual generated expressions may use only built-in functions and types`,
            tableName,
            column.name,
            column.generated.expression
          );
        }
        const defaultSchema = table.schema || "public";
        const unqualifiedOperatorKey = getGeneratedExpressionUnqualifiedOperatorNames(
          column.generated.expression
        ).map(function getOperatorKey(name) {
          const matchingSchema = [defaultSchema, "public"].find(
            function findOperatorSchema(schema) {
              return userDefinedOperatorKeys.has(`${schema}.${name}`) &&
                !builtInOperatorNames.has(name);
            }
          );
          return matchingSchema ? `${matchingSchema}.${name}` : undefined;
        }).find(function hasUserDefinedOperator(key) {
          return key !== undefined;
        });
        if (unqualifiedOperatorKey) {
          const tableName = `${table.schema || "public"}.${table.name}`;
          throw new ValidationError(
            `PostgreSQL virtual generated column ${tableName}.${column.name} cannot reference user-defined operator ${unqualifiedOperatorKey}; virtual generated expressions may use only built-in functions and types`,
            tableName,
            column.name,
            column.generated.expression
          );
        }
        const functionKey = getGeneratedExpressionFunctionKeys(
          column.generated.expression,
          table.schema || "public"
        ).find(function findUserDefinedFunction(key) {
          return userDefinedFunctions.has(key);
        });
        if (functionKey) {
          const tableName = `${table.schema || "public"}.${table.name}`;
          throw new ValidationError(
            `PostgreSQL virtual generated column ${tableName}.${column.name} cannot reference user-defined function ${functionKey}; virtual generated expressions may use only built-in functions and types`,
            tableName,
            column.name,
            column.generated.expression
          );
        }
      }
    }
  }

  private validateGeneratedColumnReferences(tables: Table[]): void {
    if (this.provider.dialect !== "postgres") {
      return;
    }

    for (const table of tables) {
      const generatedColumnNames = new Set(table.columns.filter(
        function isGeneratedColumn(column) {
          return Boolean(column.generated);
        }
      ).map(function getColumnName(column) {
        return column.name;
      }));
      if (generatedColumnNames.size === 0) {
        continue;
      }

      for (const column of table.columns) {
        if (!column.generated) {
          continue;
        }
        const tableName = `${table.schema || "public"}.${table.name}`;
        if (column.default !== undefined) {
          throw new ValidationError(
            `PostgreSQL generated column ${tableName}.${column.name} cannot declare a default`,
            tableName,
            column.name,
            column.default
          );
        }
        if (column.identity) {
          throw new ValidationError(
            `PostgreSQL generated column ${tableName}.${column.name} cannot declare an identity`,
            tableName,
            column.name,
            column.identity.generation
          );
        }
        const referencedColumnNames = getGeneratedExpressionColumnNames(
          column.generated.expression
        );
        const prohibitedSystemColumn = referencedColumnNames.find(
          function findProhibitedSystemColumn(name) {
            return POSTGRES_GENERATED_PROHIBITED_SYSTEM_COLUMNS.has(name);
          }
        );
        if (prohibitedSystemColumn) {
          throw new ValidationError(
            `PostgreSQL generated column ${tableName}.${column.name} cannot reference system column ${prohibitedSystemColumn}; only tableoid is permitted`,
            tableName,
            column.name,
            column.generated.expression
          );
        }
        const referencedGeneratedColumn = referencedColumnNames.find(function findGeneratedColumn(name) {
          return generatedColumnNames.has(name);
        });
        if (!referencedGeneratedColumn) {
          continue;
        }

        throw new ValidationError(
          `PostgreSQL generated column ${tableName}.${column.name} cannot reference generated column ${referencedGeneratedColumn}; generation expressions may reference only non-generated columns`,
          tableName,
          column.name,
          column.generated.expression
        );
      }
    }
  }

  private validateGeneratedColumnInheritance(
    desiredTables: Table[],
    currentTables: Table[]
  ): void {
    if (this.provider.dialect !== "postgres") {
      return;
    }

    const tableKey = function getTableKey(table: Pick<Table, "name" | "schema">): string {
      return `${table.schema || "public"}.${table.name}`;
    };
    const tablesByKey = new Map<string, Table>();
    for (const table of [...currentTables, ...desiredTables]) {
      tablesByKey.set(tableKey(table), table);
    }
    const effectiveColumns = new Map<string, Map<string, Column>>();
    const visiting = new Set<string>();
    const getEffectiveColumns = function resolveEffectiveColumns(table: Table): Map<string, Column> {
      const key = tableKey(table);
      const existing = effectiveColumns.get(key);
      if (existing) {
        return existing;
      }
      if (visiting.has(key)) {
        return new Map();
      }

      visiting.add(key);
      const columns = new Map<string, Column>();
      for (const parent of table.inherits || []) {
        const parentTable = tablesByKey.get(`${parent.schema || table.schema || "public"}.${parent.name}`);
        if (!parentTable) {
          continue;
        }
        for (const [name, column] of getEffectiveColumns(parentTable)) {
          columns.set(name, column);
        }
      }
      for (const column of table.inheritedColumns || []) {
        columns.set(column.name, column);
      }
      for (const column of table.columns) {
        columns.set(column.name, column);
      }
      visiting.delete(key);
      effectiveColumns.set(key, columns);
      return columns;
    };

    for (const table of desiredTables) {
      if (!table.inherits || table.inherits.length === 0) {
        continue;
      }

      const inheritedColumns = new Map<string, Column[]>();
      for (const parent of table.inherits) {
        const parentTable = tablesByKey.get(`${parent.schema || table.schema || "public"}.${parent.name}`);
        if (!parentTable) {
          continue;
        }
        for (const [name, column] of getEffectiveColumns(parentTable)) {
          const columns = inheritedColumns.get(name) || [];
          columns.push(column);
          inheritedColumns.set(name, columns);
        }
      }

      for (const [name, parentColumns] of inheritedColumns) {
        const generatedModes = new Set(parentColumns.map(function getGeneratedMode(column) {
          if (!column.generated) {
            return "ordinary";
          }
          return column.generated.stored ? "stored" : "virtual";
        }));
        const tableName = `${table.schema || "public"}.${table.name}`;
        if (generatedModes.size > 1) {
          throw new ValidationError(
            `PostgreSQL inherited column ${tableName}.${name} has incompatible generated definitions across its parents`,
            tableName,
            name
          );
        }

        const childColumn = table.columns.find(function findChildColumn(column) {
          return column.name === name;
        });
        if (!childColumn) {
          continue;
        }
        const parentColumn = parentColumns[0]!;
        if (Boolean(parentColumn.generated) !== Boolean(childColumn.generated)) {
          throw new ValidationError(
            `PostgreSQL inherited column ${tableName}.${name} must ${parentColumn.generated ? "remain generated" : "not become generated"}`,
            tableName,
            name
          );
        }
        if (
          parentColumn.generated &&
          childColumn.generated &&
          parentColumn.generated.stored !== childColumn.generated.stored
        ) {
          throw new ValidationError(
            `PostgreSQL inherited generated column ${tableName}.${name} must use the same storage kind as its parent`,
            tableName,
            name
          );
        }
      }
    }
  }

  private async canonicalizeDesiredViews(
    client: DatabaseClient,
    desiredViews: View[],
    currentViews: View[]
  ): Promise<View[]> {
    if (this.provider.dialect !== "postgres") {
      return desiredViews;
    }

    const currentViewsByKey = new Map(
      currentViews.map((view) => [this.getViewKey(view), view] as const)
    );

    if (currentViewsByKey.size === 0) {
      return desiredViews;
    }

    const normalizedViews: View[] = [];

    for (const view of desiredViews) {
      const currentView = currentViewsByKey.get(this.getViewKey(view));
      if (!currentView) {
        normalizedViews.push(view);
        continue;
      }

      const canonical = await this.canonicalizeViewDefinition(client, view);
      const reordered = canonical
        ? this.reorderCanonicalWildcardView(
            view.definition,
            canonical,
            currentView
          )
        : undefined;
      normalizedViews.push(
        canonical ? { ...view, ...(reordered || canonical) } : view
      );
    }

    return normalizedViews;
  }

  private reorderCanonicalWildcardView(
    desiredDefinition: string,
    canonical: { definition: string; columnNames: string[] },
    current: View
  ): { definition: string; columnNames: string[] } | undefined {
    return reorderCanonicalWildcardView(
      desiredDefinition,
      canonical,
      current
    );
  }

  private async canonicalizeViewDefinition(
    client: DatabaseClient,
    view: View
  ): Promise<{ definition: string; columnNames: string[] } | undefined> {
    const schemaName = view.schema || "public";
    const tempViewName = `terradb_view_compare_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const columnList = view.columnNames && view.columnNames.length > 0
      ? ` (${view.columnNames.map(this.quoteIdentifier).join(", ")})`
      : "";

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${this.buildViewSearchPath(schemaName)}`);
      await client.query(
        `CREATE TEMP VIEW ${this.quoteIdentifier(tempViewName)}${columnList} AS ${view.definition}`
      );

      const result = await client.query<{
        definition: string;
        column_names: string[];
      }>(
        `
          SELECT
            pg_get_viewdef($1::regclass, false) AS definition,
            ARRAY(
              SELECT attribute.attname::text
              FROM pg_attribute attribute
              WHERE attribute.attrelid = $1::regclass
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
              ORDER BY attribute.attnum
            ) AS column_names
        `,
        [`pg_temp.${tempViewName}`]
      );

      const row = result.rows[0];
      if (!row?.definition) {
        return undefined;
      }
      return {
        definition: row.definition.trim(),
        columnNames: row.column_names,
      };
    } catch {
      return undefined;
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
    }
  }

  private buildViewSearchPath(schemaName: string): string {
    if (schemaName === "public") {
      return "pg_temp, public";
    }

    return `pg_temp, ${this.quoteIdentifier(schemaName)}, public`;
  }

  private getViewKey(view: View): string {
    return `${view.schema || "public"}.${view.name}`;
  }

  private getRemovedTriggerDescriptions(
    desiredTriggers: Trigger[],
    currentTriggers: Trigger[]
  ): Set<string> {
    const desiredKeys = new Set(desiredTriggers.map(function getKey(trigger) {
      return `${trigger.schema || "public"}.${trigger.tableName}.${trigger.name}`;
    }));
    const descriptions = new Set<string>();

    for (const trigger of currentTriggers) {
      const schema = trigger.schema || "public";
      const key = `${schema}.${trigger.tableName}.${trigger.name}`;
      if (desiredKeys.has(key)) {
        continue;
      }

      const triggerNames = this.getDescriptionIdentifiers(trigger.name);
      const tableNames = this.getDescriptionQualifiedNames(
        schema,
        trigger.tableName
      );
      for (const triggerName of triggerNames) {
        for (const tableName of tableNames) {
          descriptions.add(`trigger ${triggerName} on table ${tableName}`);
        }
      }
    }

    return descriptions;
  }

  private async getVirtualGeneratedOperatorInfo(
    client: DatabaseClient,
    schemas: string[]
  ): Promise<{ userDefinedKeys: Set<string>; builtInNames: Set<string> }> {
    if (this.provider.dialect !== "postgres") {
      return { userDefinedKeys: new Set(), builtInNames: new Set() };
    }

    const managedSchemas = Array.from(new Set([...schemas, "public"]));
    const [userDefinedOperators, builtInOperators] = await Promise.all([
      client.query<{ schema_name: string; operator_name: string }>(`
        SELECT namespace.nspname AS schema_name, op.oprname AS operator_name
        FROM pg_operator op
        JOIN pg_namespace namespace ON namespace.oid = op.oprnamespace
        WHERE namespace.nspname = ANY($1::text[])
      `, [managedSchemas]),
      client.query<{ operator_name: string }>(`
        SELECT op.oprname AS operator_name
        FROM pg_operator op
        JOIN pg_namespace namespace ON namespace.oid = op.oprnamespace
        WHERE namespace.nspname = 'pg_catalog'
      `),
    ]);

    return {
      userDefinedKeys: new Set(userDefinedOperators.rows.map(
        function getOperatorKey(operator) {
          return `${operator.schema_name}.${operator.operator_name}`;
        }
      )),
      builtInNames: new Set(builtInOperators.rows.map(
        function getOperatorName(operator) {
          return operator.operator_name;
        }
      )),
    };
  }

  private getDescriptionIdentifiers(value: string): string[] {
    return Array.from(new Set([value, this.quoteIdentifier(value)]));
  }

  private getDescriptionQualifiedNames(
    schema: string,
    name: string
  ): string[] {
    const schemaNames = this.getDescriptionIdentifiers(schema);
    const objectNames = this.getDescriptionIdentifiers(name);
    const values = new Set<string>();
    if (schema === "public") {
      for (const objectName of objectNames) {
        values.add(objectName);
      }
    }
    for (const schemaName of schemaNames) {
      for (const objectName of objectNames) {
        values.add(`${schemaName}.${objectName}`);
      }
    }
    return Array.from(values);
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}

const POSTGRES_GENERATED_PROHIBITED_SYSTEM_COLUMNS = new Set([
  "ctid",
  "xmin",
  "cmin",
  "xmax",
  "cmax",
]);

const POSTGRES_PUBLIC_SCHEMA_BOOTSTRAP_COMMENT = "standard public schema";

function isPublicSchemaComment(comment: ParsedSchema["comments"][number]): boolean {
  return comment.objectType === "SCHEMA" && comment.objectName === "public";
}

function isPostgresViewDrop(statement: string): boolean {
  return /^DROP\s+(?:MATERIALIZED\s+)?VIEW\b/i.test(statement.trim());
}

function hasVirtualGeneratedColumns(tables: Table[]): boolean {
  return tables.some(function hasVirtualGeneratedColumn(table) {
    return table.columns.some(function isVirtualGeneratedColumn(column) {
      return Boolean(column.generated && !column.generated.stored);
    });
  });
}

function getGeneratedExpressionFunctionKeys(
  expression: string,
  defaultSchema: string
): string[] {
  try {
    const parsed = parseSync(`SELECT ${expression} AS terradb_generated_expression`) as {
      stmts?: Array<{ stmt?: unknown }>;
    };
    const keys = new Set<string>();
    collectFunctionCallKeys(parsed.stmts, defaultSchema, keys);
    return Array.from(keys);
  } catch {
    return [];
  }
}

function getGeneratedExpressionTypeKeys(
  expression: string,
  defaultSchema: string
): string[] {
  try {
    const parsed = parseSync(`SELECT ${expression} AS terradb_generated_expression`) as {
      stmts?: Array<{ stmt?: unknown }>;
    };
    const keys = new Set<string>();
    collectTypeNameKeys(parsed.stmts, defaultSchema, keys);
    return Array.from(keys);
  } catch {
    return [];
  }
}

function getGeneratedExpressionColumnNames(expression: string): string[] {
  try {
    const parsed = parseSync(`SELECT ${expression} AS terradb_generated_expression`) as {
      stmts?: Array<{ stmt?: unknown }>;
    };
    const names = new Set<string>();
    collectColumnReferenceNames(parsed.stmts, names);
    return Array.from(names);
  } catch {
    return [];
  }
}

function getGeneratedExpressionQualifiedOperatorKeys(expression: string): string[] {
  try {
    const parsed = parseSync(`SELECT ${expression} AS terradb_generated_expression`) as {
      stmts?: Array<{ stmt?: unknown }>;
    };
    const keys = new Set<string>();
    collectQualifiedOperatorKeys(parsed.stmts, keys);
    return Array.from(keys);
  } catch {
    return [];
  }
}

function getGeneratedExpressionUnqualifiedOperatorNames(expression: string): string[] {
  try {
    const parsed = parseSync(`SELECT ${expression} AS terradb_generated_expression`) as {
      stmts?: Array<{ stmt?: unknown }>;
    };
    const names = new Set<string>();
    collectUnqualifiedOperatorNames(parsed.stmts, names);
    return Array.from(names);
  } catch {
    return [];
  }
}

function getDeclaredTypeKey(type: string, defaultSchema: string): string | undefined {
  const match = type.trim().match(
    /^(?:(?:"([^"]+)"|([a-z_][a-z0-9_$]*))\.)?(?:"([^"]+)"|([a-z_][a-z0-9_$]*))/i
  );
  if (!match) {
    return undefined;
  }
  const schema = match[1] || match[2] || defaultSchema;
  const name = match[3] || match[4];
  return name ? `${schema}.${name}` : undefined;
}

function collectFunctionCallKeys(
  value: unknown,
  defaultSchema: string,
  keys: Set<string>
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFunctionCallKeys(item, defaultSchema, keys);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;
  const functionCall = node.FuncCall as Record<string, unknown> | undefined;
  if (functionCall) {
    const nameParts = getPostgresNameParts(functionCall.funcname);
    if (nameParts.length > 0) {
      const name = nameParts[nameParts.length - 1]!;
      const schema = nameParts.length > 1
        ? nameParts[nameParts.length - 2]!
        : defaultSchema;
      keys.add(`${schema}.${name}`);
    }
  }

  for (const child of Object.values(node)) {
    collectFunctionCallKeys(child, defaultSchema, keys);
  }
}

function collectTypeNameKeys(
  value: unknown,
  defaultSchema: string,
  keys: Set<string>
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTypeNameKeys(item, defaultSchema, keys);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;
  const typeName = (node.TypeName || node.typeName) as
    | Record<string, unknown>
    | undefined;
  if (typeName) {
    const nameParts = getPostgresNameParts(typeName.names);
    if (nameParts.length > 0) {
      const name = nameParts[nameParts.length - 1]!;
      const schema = nameParts.length > 1
        ? nameParts[nameParts.length - 2]!
        : defaultSchema;
      keys.add(`${schema}.${name}`);
    }
  }

  for (const child of Object.values(node)) {
    collectTypeNameKeys(child, defaultSchema, keys);
  }
}

function collectColumnReferenceNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectColumnReferenceNames(item, names);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;
  const columnRef = node.ColumnRef as Record<string, unknown> | undefined;
  if (columnRef) {
    const nameParts = getPostgresNameParts(columnRef.fields);
    if (nameParts.length > 0) {
      names.add(nameParts[nameParts.length - 1]!);
    }
  }

  for (const child of Object.values(node)) {
    collectColumnReferenceNames(child, names);
  }
}

function collectQualifiedOperatorKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectQualifiedOperatorKeys(item, keys);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;
  const expression = node.A_Expr as Record<string, unknown> | undefined;
  if (expression) {
    const nameParts = getPostgresNameParts(expression.name);
    if (nameParts.length > 1) {
      const schema = nameParts[nameParts.length - 2]!;
      const name = nameParts[nameParts.length - 1]!;
      keys.add(`${schema}.${name}`);
    }
  }

  for (const child of Object.values(node)) {
    collectQualifiedOperatorKeys(child, keys);
  }
}

function collectUnqualifiedOperatorNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUnqualifiedOperatorNames(item, names);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;
  const expression = node.A_Expr as Record<string, unknown> | undefined;
  if (expression) {
    const nameParts = getPostgresNameParts(expression.name);
    if (nameParts.length === 1) {
      names.add(nameParts[0]!);
    }
  }

  for (const child of Object.values(node)) {
    collectUnqualifiedOperatorNames(child, names);
  }
}

function getCreatedFunctionKey(statement: string): string | undefined {
  try {
    const parsed = parseSync(statement) as {
      stmts?: Array<{
        stmt?: {
          CreateFunctionStmt?: { funcname?: unknown };
        };
      }>;
    };
    const nameParts = getPostgresNameParts(
      parsed.stmts?.[0]?.stmt?.CreateFunctionStmt?.funcname
    );
    if (nameParts.length === 0) {
      return undefined;
    }
    const name = nameParts[nameParts.length - 1]!;
    const schema = nameParts.length > 1
      ? nameParts[nameParts.length - 2]!
      : "public";
    return `${schema}.${name}`;
  } catch {
    return undefined;
  }
}

function getPostgresNameParts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of value) {
    const stringNode = (item as { String?: { sval?: unknown } }).String;
    if (!stringNode || typeof stringNode.sval !== "string") {
      return [];
    }
    parts.push(stringNode.sval);
  }
  return parts;
}

function isPostgresConstraintDrop(statement: string): boolean {
  return (parseSync(statement).stmts || []).some(
    function hasConstraintDrop(statementNode) {
      const node = statementNode.stmt!;
      if (!("AlterTableStmt" in node)) {
        return false;
      }
      return (node.AlterTableStmt.cmds || []).some(
        function isConstraintDrop(commandNode) {
          return (
            "AlterTableCmd" in commandNode &&
            commandNode.AlterTableCmd.subtype === "AT_DropConstraint"
          );
        }
      );
    }
  );
}
