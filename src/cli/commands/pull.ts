import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { SchemaService } from "../../core/schema/service";
import { createProvider, parseConnectionString } from "../../providers";
import {
  CLI_OUTPUT_SCHEMA_VERSION,
  type CliOutputFormat,
  type CliPullOutput,
} from "../../types/cli-output";
import { ValidationError } from "../../types/errors";
import { Logger } from "../../utils/logger";

export type PullCliOptions = {
  file?: string;
  schema: string[];
  format: string;
  overwrite?: boolean;
  ignorePrivileges?: boolean;
  ignoreComments?: boolean;
  ignoreConstraintValidation?: boolean;
};

function normalizeFormat(format: string): CliOutputFormat {
  if (format === "text" || format === "json") {
    return format;
  }
  throw new Error(`Invalid format: ${format}. Expected text or json`);
}

function getSchemas(schemaOption: string[]): string[] {
  if (schemaOption && schemaOption.length > 0) {
    return schemaOption;
  }
  return ["public"];
}

export async function pullCommand(
  options: PullCliOptions,
  connectionString: string
): Promise<CliPullOutput | undefined> {
  const config = parseConnectionString(connectionString);
  const format = normalizeFormat(options.format);

  if (options.file && existsSync(options.file) && options.overwrite !== true) {
    throw new ValidationError(
      `Refusing to overwrite existing file '${options.file}'. Use --overwrite to replace it`,
      "pull",
      "file",
      options.file
    );
  }

  const schemas = getSchemas(options.schema);
  const provider = await createProvider(config.dialect);
  const schemaService = new SchemaService(provider, config);
  const result = await schemaService.pull(schemas, {
    managePrivileges: options.ignorePrivileges !== true,
    manageComments: options.ignoreComments !== true,
    manageConstraintValidation: options.ignoreConstraintValidation !== true,
  });

  if (options.file) {
    await writeFile(options.file, result.sql, "utf-8");
  }

  if (format === "json") {
    return {
      schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
      command: "pull",
      dialect: config.dialect,
      file: options.file ?? null,
      schemas,
      statementCount: result.statements.length,
      sql: result.sql,
    };
  }

  if (!options.file) {
    process.stdout.write(result.sql);
    return;
  }

  Logger.success(
    `Wrote ${result.statements.length} statement(s) to ${options.file}; planning it against this database produces no changes`
  );
  return;
}
