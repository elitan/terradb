import { Command } from "commander";
import { applyCommand, planCommand, pullCommand } from "./commands/index";
import packageJson from "../../package.json";
import { Logger } from "../utils/logger";

type GlobalCliOptions = {
  color?: boolean;
};

function collectSchemas(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function getConnectionString(urlOption?: string): string {
  const url = urlOption || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Database connection required. Provide -u/--url or set DATABASE_URL environment variable.\n" +
        "Examples:\n" +
        "  PostgreSQL: postgres://user:pass@localhost:5432/dbname\n" +
        "  SQLite:     sqlite:///path/to/database.db or ./database.sqlite"
    );
  }
  return url;
}

function configureOutput(options: GlobalCliOptions): void {
  Logger.setSilent(false);
  Logger.setColorEnabled(options.color !== false);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runCLI() {
  const program = new Command();

  program
    .name("terradb")
    .description("Declarative schema management for PostgreSQL and SQLite")
    .version(packageJson.version, "-v, --version")
    .option("--no-color", "Disable ANSI colors");

  program
    .command("plan")
    .description("Preview schema changes")
    .requiredOption("-f, --file <file>", "Schema file path")
    .option(
      "-u, --url <url>",
      "Database connection string (overrides DATABASE_URL)"
    )
    .option(
      "-s, --schema <schema>",
      "Database schema to manage (can be specified multiple times, defaults to 'public')",
      collectSchemas,
      []
    )
    .option(
      "--ignore-privileges",
      "Leave grants and default privileges unmanaged"
    )
    .option("--ignore-comments", "Leave database comments unmanaged")
    .option(
      "--ignore-constraint-validation",
      "Leave existing constraint validation state unmanaged"
    )
    .option("--format <format>", "Output format (text|json)", "text")
    .action(async function action(options) {
      configureOutput(program.opts<GlobalCliOptions>());
      const connectionString = getConnectionString(options.url);
      const output = await planCommand(options, connectionString);
      if (output) {
        printJson(output);
      }
    });

  program
    .command("apply")
    .description("Apply schema changes to database")
    .requiredOption("-f, --file <file>", "Schema file path")
    .option(
      "-u, --url <url>",
      "Database connection string (overrides DATABASE_URL)"
    )
    .option(
      "-s, --schema <schema>",
      "Database schema to manage (can be specified multiple times, defaults to 'public')",
      collectSchemas,
      []
    )
    .option(
      "--ignore-privileges",
      "Leave grants and default privileges unmanaged"
    )
    .option("--ignore-comments", "Leave database comments unmanaged")
    .option(
      "--ignore-constraint-validation",
      "Leave existing constraint validation state unmanaged"
    )
    .option("--auto-approve", "Skip confirmation prompt")
    .option("--dry-run", "Show migration plan without executing changes")
    .option("--strict", "Fail if migration plan contains destructive statements")
    .option(
      "--lock-name <name>",
      "Advisory lock name to prevent concurrent migrations",
      "terradb_migrate_execute"
    )
    .option(
      "--lock-timeout <seconds>",
      "Maximum time to wait for advisory lock in seconds",
      "10"
    )
    .option("--format <format>", "Output format (text|json)", "text")
    .action(async function action(options) {
      configureOutput(program.opts<GlobalCliOptions>());
      const connectionString = getConnectionString(options.url);
      const output = await applyCommand(options, connectionString);
      if (output) {
        printJson(output);
      }
    });

  program
    .command("pull")
    .description(
      "Generate a schema file from an existing database, verified to plan no changes"
    )
    .option(
      "-f, --file <file>",
      "Write the schema to this file instead of standard output"
    )
    .option("--overwrite", "Replace the file if it already exists")
    .option(
      "-u, --url <url>",
      "Database connection string (overrides DATABASE_URL)"
    )
    .option(
      "-s, --schema <schema>",
      "Database schema to pull (can be specified multiple times, defaults to 'public')",
      collectSchemas,
      []
    )
    .option(
      "--ignore-privileges",
      "Leave grants and default privileges out of the schema file"
    )
    .option("--ignore-comments", "Leave database comments out of the schema file")
    .option(
      "--ignore-constraint-validation",
      "Leave existing constraint validation state unmanaged"
    )
    .option("--format <format>", "Output format (text|json)", "text")
    .action(async function action(options) {
      configureOutput(program.opts<GlobalCliOptions>());
      const connectionString = getConnectionString(options.url);
      const output = await pullCommand(options, connectionString);
      if (output) {
        printJson(output);
      }
    });

  await program.parseAsync();
}
