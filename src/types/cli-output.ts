import type { DatabaseDialect } from "../providers/types";

export type CliOutputFormat = "text" | "json";
export const CLI_OUTPUT_SCHEMA_VERSION = 2;

export interface CliPlanCounts {
  preTransactional: number;
  transactional: number;
  deferred: number;
  concurrent: number;
  total: number;
}

export interface CliPlanStatements {
  preTransactional: string[];
  transactional: string[];
  deferred: string[];
  concurrent: string[];
}

export type CliStatementChannel =
  | "pre-transactional"
  | "transactional"
  | "deferred"
  | "concurrent";
export type CliStatementRisk = "safe" | "destructive" | "concurrent";
export type CliStatementCategory =
  | "table"
  | "index"
  | "constraint"
  | "view"
  | "materialized-view"
  | "enum"
  | "sequence"
  | "schema"
  | "extension"
  | "function"
  | "procedure"
  | "trigger"
  | "role"
  | "grant"
  | "default-privilege"
  | "policy"
  | "foreign-server"
  | "comment"
  | "type"
  | "other";

export interface CliStatementMetadata {
  order: number;
  channel: CliStatementChannel;
  category: CliStatementCategory;
  risk: CliStatementRisk;
  sql: string;
}

export interface CliPlanOutput {
  schemaVersion: number;
  command: "plan";
  dialect: DatabaseDialect;
  file: string;
  schemas: string[];
  hasChanges: boolean;
  counts: CliPlanCounts;
  statements: CliPlanStatements;
  statementMetadata: CliStatementMetadata[];
}

export interface CliApplyOutput {
  schemaVersion: number;
  command: "apply";
  dialect: DatabaseDialect;
  file: string;
  schemas: string[];
  dryRun: boolean;
  strict: boolean;
  hasChanges: boolean;
  counts: CliPlanCounts;
  statements: CliPlanStatements;
  statementMetadata: CliStatementMetadata[];
}

export interface CliPullOutput {
  schemaVersion: number;
  command: "pull";
  dialect: DatabaseDialect;
  file: string | null;
  schemas: string[];
  statementCount: number;
  sql: string;
}
