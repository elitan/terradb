export interface MigrationPlan {
  // Statements committed before the main transaction, such as enum labels used by later DDL.
  preTransactional?: string[];
  transactional: string[];
  concurrent: string[];
  // Transactional statements that depend on concurrent work and therefore run last.
  deferred: string[];
  hasChanges: boolean;
}

export interface MigrationContext {
  postgresVersionNum?: number;
  defaultTableAccessMethod?: string;
  currentUser?: string;
  sessionUser?: string;
  constraintValidationManaged?: boolean;
  /**
   * Render creation statements in the form a desired schema declares them,
   * rather than in executable migration order: column storage and
   * compression inline in CREATE TABLE, and sequence ownership inline in
   * CREATE SEQUENCE.
   */
  renderDesiredSchema?: boolean;
}

export interface MigrationOptions {
  /** Use CREATE INDEX CONCURRENTLY by default for production safety (default: true) */
  useConcurrentIndexes?: boolean;
  /** Use DROP INDEX CONCURRENTLY by default for production safety (default: true) */
  useConcurrentDrops?: boolean;
  /** Timeout for concurrent operations in milliseconds (default: 30000) */
  concurrentTimeout?: number;
  /** Whether to provide progress feedback for long-running operations (default: true) */
  showProgress?: boolean;
  /** Fallback to non-concurrent operations if concurrent fails (default: true) */
  allowFallback?: boolean;
}

export const DEFAULT_MIGRATION_OPTIONS: MigrationOptions = {
  useConcurrentIndexes: true,
  useConcurrentDrops: true,
  concurrentTimeout: 30000, // 30 seconds
  showProgress: true,
  allowFallback: true,
};
