export type MutationRiskLevel = "low" | "medium" | "high" | "critical";

export interface MutationRiskEntry {
  path: string;
  owner: string;
  level: MutationRiskLevel;
  reason: string;
}

export interface MutationRiskManifest {
  version: number;
  entries: MutationRiskEntry[];
}

export const mutationRiskManifest: MutationRiskManifest = {
  version: 1,
  entries: [
    {
      path: "tools/run-mutation-changed.ts",
      owner: "quality-gates",
      level: "high",
      reason: "mutation candidate selection and execution determine gate trustworthiness",
    },
    {
      path: "tools/check-mutation-gate.ts",
      owner: "quality-gates",
      level: "high",
      reason: "changed-file discovery and score enforcement determine gate coverage",
    },
    {
      path: "src/core/schema/differ.ts",
      owner: "core-schema",
      level: "critical",
      reason: "directly controls migration safety and idempotency",
    },
    {
      path: "src/core/schema/service.ts",
      owner: "core-service",
      level: "critical",
      reason: "applies plans and controls lock/prompt/strict behavior",
    },
    {
      path: "src/core/schema/pull.ts",
      owner: "core-service",
      level: "high",
      reason: "pulled schemas become the desired state that later applies reconcile against",
    },
    {
      path: "src/core/schema/parser",
      owner: "core-parser",
      level: "high",
      reason: "parser drift causes false diffs and migration risk",
    },
    {
      path: "src/core/schema/handlers",
      owner: "core-schema",
      level: "critical",
      reason: "object handlers control lifecycle ordering and destructive-change safety",
    },
    {
      path: "src/core/schema/inspector.ts",
      owner: "core-inspector",
      level: "high",
      reason: "introspection drift causes incorrect change plans",
    },
    {
      path: "src/providers/sqlite/index.ts",
      owner: "sqlite-provider",
      level: "critical",
      reason: "controls SQLite migration atomicity and integrity verification",
    },
    {
      path: "src/providers/sqlite/differ.ts",
      owner: "sqlite-provider",
      level: "critical",
      reason: "controls SQLite recreation, preservation, and idempotency",
    },
    {
      path: "src/providers/sqlite/inspector.ts",
      owner: "sqlite-provider",
      level: "high",
      reason: "SQLite introspection drift causes incorrect recreation plans",
    },
    {
      path: "src/providers/sqlite/sql-parser-utils.ts",
      owner: "sqlite-provider",
      level: "high",
      reason: "lossless SQLite definition parsing controls semantic comparison",
    },
    {
      path: "src/providers/sqlite/parser.ts",
      owner: "sqlite-provider",
      level: "high",
      reason: "SQLite desired-schema preflight prevents silent or imperative mutations",
    },
    {
      path: "src/providers/postgres/connection.ts",
      owner: "postgres-provider",
      level: "high",
      reason: "connection parsing controls endpoint, credentials, and TLS semantics",
    },
    {
      path: "src/utils/statement-classifier.ts",
      owner: "cli-contract",
      level: "high",
      reason: "statement classification controls strict-mode safety and CLI risk metadata",
    },
    {
      path: "src/utils/expression-comparator.ts",
      owner: "core-schema",
      level: "critical",
      reason: "expression equivalence controls semantic drift and replacement decisions across managed objects",
    },
  ],
};
