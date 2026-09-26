/**
 * Error Formatter
 *
 * Formats Terra errors for display in the CLI with context and suggestions.
 */

import chalk from "chalk";
import {
  TerraError,
  ParserError,
  MigrationError,
  DependencyError,
  PullVerificationError,
  ValidationError,
} from "../types/errors";

export class ErrorFormatter {
  /**
   * Format any error for CLI display
   */
  static format(error: unknown): string {
    if (error instanceof ParserError) {
      return this.formatParserError(error);
    }

    if (error instanceof MigrationError) {
      return this.formatMigrationError(error);
    }

    if (error instanceof DependencyError) {
      return this.formatDependencyError(error);
    }

    if (error instanceof ValidationError) {
      return this.formatValidationError(error);
    }

    if (error instanceof PullVerificationError) {
      return this.formatPullVerificationError(error);
    }

    if (error instanceof TerraError) {
      return this.formatTerraError(error);
    }

    if (error instanceof Error) {
      return this.formatGenericError(error);
    }

    return `Error: ${String(error)}`;
  }

  /**
   * Format parser errors with file location and SQL context
   */
  private static formatParserError(error: ParserError): string {
    const lines: string[] = [];

    // Header
    lines.push("");
    lines.push(chalk.red.bold("Parser Error"));

    // Location
    if (error.filePath) {
      let location = error.filePath;
      if (error.line) {
        location += `:${error.line}`;
        if (error.column) {
          location += `:${error.column}`;
        }
      }
      lines.push(chalk.gray(`  in ${location}`));
    }

    lines.push("");

    // Message
    lines.push(this.wrapText(error.message, "  "));

    // SQL snippet if available
    if (error.sqlSnippet) {
      lines.push("");
      lines.push(chalk.gray("  SQL:"));
      lines.push(chalk.yellow(`    ${error.sqlSnippet}`));
    }

    // Suggestions for common errors
    const suggestion = this.getParserSuggestion(error);
    if (suggestion) {
      lines.push("");
      lines.push(chalk.cyan("  Suggestion:"));
      lines.push(chalk.cyan(`    ${suggestion}`));
    }

    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format migration errors with database context
   */
  private static formatMigrationError(error: MigrationError): string {
    const lines: string[] = [];

    // Header
    lines.push("");
    lines.push(chalk.red.bold("Migration Error"));
    lines.push("");

    // Message
    lines.push(this.wrapText(error.message, "  "));

    // Statement that failed
    if (error.statement) {
      lines.push("");
      lines.push(chalk.gray("  Failed statement:"));
      lines.push(chalk.yellow(`    ${error.statement}`));
    }

    // PostgreSQL error details
    if (error.pgError) {
      lines.push("");

      if (error.pgError.code) {
        lines.push(chalk.gray(`  PostgreSQL Error Code: ${error.pgError.code}`));
      }

      if (error.pgError.detail) {
        lines.push(chalk.gray("  Detail:"));
        lines.push(this.wrapText(error.pgError.detail, "    "));
      }

      if (error.pgError.hint) {
        lines.push("");
        lines.push(chalk.cyan("  Hint:"));
        lines.push(chalk.cyan(this.wrapText(error.pgError.hint, "    ")));
      }
    }

    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format dependency errors
   */
  private static formatDependencyError(error: DependencyError): string {
    const lines: string[] = [];

    lines.push("");
    lines.push(chalk.red.bold("Dependency Error"));
    lines.push("");
    lines.push(this.wrapText(error.message, "  "));

    if (error.tables && error.tables.length > 0) {
      lines.push("");
      lines.push(chalk.gray("  Affected tables:"));
      error.tables.forEach((table) => {
        lines.push(chalk.yellow(`    - ${table}`));
      });
    }

    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format validation errors
   */
  private static formatValidationError(error: ValidationError): string {
    const lines: string[] = [];

    lines.push("");
    lines.push(chalk.red.bold("Validation Error"));
    lines.push("");
    lines.push(this.wrapText(error.message, "  "));

    if (error.entity) {
      lines.push("");
      lines.push(chalk.gray(`  Entity: ${error.entity}`));
      if (error.field) {
        lines.push(chalk.gray(`  Field: ${error.field}`));
      }
      if (error.value !== undefined) {
        lines.push(chalk.gray(`  Value: ${error.value}`));
      }
    }

    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format pull verification errors with the drift that remained
   */
  private static formatPullVerificationError(error: PullVerificationError): string {
    const lines: string[] = [];

    lines.push("");
    lines.push(chalk.red.bold("Pull Verification Error"));
    lines.push("");
    lines.push(this.wrapText(error.message, "  "));

    if (error.statements.length > 0) {
      lines.push("");
      lines.push(chalk.gray("  Remaining changes:"));
      for (const statement of error.statements) {
        lines.push(chalk.gray(`    ${statement.split("\n").join("\n    ")}`));
      }
    }

    lines.push("");
    lines.push(
      chalk.gray(
        "  No file was written. The database contains state that TerraDB cannot yet express losslessly as a desired schema."
      )
    );
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format generic Terra errors
   */
  private static formatTerraError(error: TerraError): string {
    const lines: string[] = [];

    lines.push("");
    lines.push(chalk.red.bold(error.name || 'Terra Error'));
    lines.push("");
    lines.push(this.wrapText(error.message, "  "));

    if (error.context) {
      lines.push("");
      lines.push(chalk.gray("  Context:"));
      Object.entries(error.context).forEach(([key, value]) => {
        lines.push(chalk.gray(`    ${key}: ${JSON.stringify(value)}`));
      });
    }

    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format generic JavaScript errors
   */
  private static formatGenericError(error: Error): string {
    return `\n${chalk.red.bold("Error")}\n\n  ${error.message}\n`;
  }

  /**
   * Get suggestion based on error message
   */
  private static getParserSuggestion(error: ParserError): string | null {
    const msg = error.message.toLowerCase();

    if (msg.includes("alter table")) {
      return "Use CREATE TABLE statements to define your desired schema. Terra will generate the ALTER statements automatically.";
    }

    if (msg.includes("drop")) {
      return "Simply remove the table/index from your schema file. Terra will handle the DROP automatically.";
    }

    if (msg.includes("unexpected end of input")) {
      return "Check for missing closing parentheses, semicolons, or incomplete SQL statements.";
    }

    if (msg.includes("syntax error")) {
      return "Review the SQL syntax. Common issues: missing commas, typos in keywords, or incorrect data types.";
    }

    return null;
  }

  /**
   * Wrap text to fit terminal width
   */
  private static wrapText(text: string, indent: string = ""): string {
    const maxWidth = 80;
    const lines: string[] = [];
    const words = text.split(' ');
    let currentLine = indent;

    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth && currentLine !== indent) {
        lines.push(currentLine);
        currentLine = indent + word;
      } else {
        if (currentLine === indent) {
          currentLine += word;
        } else {
          currentLine += ' ' + word;
        }
      }
    }

    if (currentLine !== indent) {
      lines.push(currentLine);
    }

    return lines.join('\n');
  }
}
