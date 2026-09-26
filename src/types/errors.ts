/**
 * Terra Error Types
 *
 * Structured error classes for better error handling and user experience.
 */

/**
 * Base error class for all Terra errors
 */
export class TerraError extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'TerraError';
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Parser errors - issues parsing SQL schema definitions
 */
export class ParserError extends TerraError {
  constructor(
    message: string,
    public filePath?: string,
    public line?: number,
    public column?: number,
    public sqlSnippet?: string
  ) {
    super(
      'PARSER_ERROR',
      message,
      { filePath, line, column, sqlSnippet }
    );
    this.name = 'ParserError';
  }
}

/**
 * Migration errors - issues executing migrations against the database
 */
export class MigrationError extends TerraError {
  constructor(
    message: string,
    public statement?: string,
    public pgError?: {
      code?: string;
      detail?: string;
      hint?: string;
      position?: string;
    }
  ) {
    super(
      'MIGRATION_ERROR',
      message,
      { statement, pgError }
    );
    this.name = 'MigrationError';
  }
}

/**
 * Dependency errors - circular dependencies or unresolvable references
 */
export class DependencyError extends TerraError {
  constructor(
    message: string,
    public tables?: string[],
    public dependencyGraph?: Record<string, string[]>
  ) {
    super(
      'DEPENDENCY_ERROR',
      message,
      { tables, dependencyGraph }
    );
    this.name = 'DependencyError';
  }
}

/**
 * Validation errors - schema validation issues
 */
export class ValidationError extends TerraError {
  constructor(
    message: string,
    public entity?: string,
    public field?: string,
    public value?: any
  ) {
    super(
      'VALIDATION_ERROR',
      message,
      { entity, field, value }
    );
    this.name = 'ValidationError';
  }
}

export class StrictModeError extends TerraError {
  constructor(
    message: string,
    public statements: string[]
  ) {
    super(
      'STRICT_MODE_ERROR',
      message,
      { statements }
    );
    this.name = 'StrictModeError';
  }
}

/**
 * Pull errors - a generated schema file does not reproduce the database
 */
export class PullVerificationError extends TerraError {
  constructor(
    message: string,
    public statements: string[]
  ) {
    super(
      'PULL_VERIFICATION_ERROR',
      message,
      { statements }
    );
    this.name = 'PullVerificationError';
  }
}
