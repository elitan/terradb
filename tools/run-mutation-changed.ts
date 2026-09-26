import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

type CliOptions = {
  baselinePath: string;
  reportPath: string;
  maxPerFile: number;
  timeoutMs: number;
  testCommandOverride?: string;
};

type BaselineFileAssessment = {
  file: string;
};

type BaselineReport = {
  targetFiles?: BaselineFileAssessment[];
  diffRef?: string | null;
};

type ChangedLineRange = {
  start: number;
  end: number;
};

type MutationOperator = {
  name: string;
  pattern: RegExp;
  replacement: string;
};

type MutationCandidate = {
  id: string;
  file: string;
  operator: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  line: number;
  column: number;
  command: string;
};

type MutationStatus = "killed" | "survived";

type MutationResult = {
  id: string;
  file: string;
  operator: string;
  line: number;
  column: number;
  original: string;
  replacement: string;
  command: string;
  status: MutationStatus;
  durationMs: number;
  failure?: string;
};

type MutationReport = {
  generatedAt: string;
  reportVersion: number;
  baselinePath: string;
  totalTargetFiles: number;
  totalMutants: number;
  killed: number;
  survived: number;
  score: number;
  maxPerFile: number;
  timeoutMs: number;
  durationMs: number;
  files: string[];
  diffRef: string | null;
  results: MutationResult[];
};

const OPERATORS: MutationOperator[] = [
  { name: "true_to_false", pattern: /\btrue\b/g, replacement: "false" },
  { name: "false_to_true", pattern: /\bfalse\b/g, replacement: "true" },
  { name: "strict_eq_to_neq", pattern: /===/g, replacement: "!==" },
  { name: "strict_neq_to_eq", pattern: /!==/g, replacement: "===" },
  { name: "and_to_or", pattern: /&&/g, replacement: "||" },
  { name: "or_to_and", pattern: /\|\|/g, replacement: "&&" },
];

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} "${value}"`);
  }
  return parsed;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baselinePath: "coverage/mutation/changed-files-baseline.json",
    reportPath: "coverage/mutation/mutation-report.json",
    maxPerFile: 4,
    timeoutMs: 120000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }

    if (name === "baseline") {
      options.baselinePath = value;
      index += 1;
      continue;
    }
    if (name === "report") {
      options.reportPath = value;
      index += 1;
      continue;
    }
    if (name === "max-per-file") {
      options.maxPerFile = parsePositiveInteger(value, "max-per-file");
      index += 1;
      continue;
    }
    if (name === "timeout-ms") {
      options.timeoutMs = parsePositiveInteger(value, "timeout-ms");
      index += 1;
      continue;
    }
    if (name === "test-command") {
      options.testCommandOverride = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument --${name}`);
  }

  const maxPerFileFromEnv = parsePositiveIntegerEnv(process.env.MUTATION_MAX_MUTANTS_PER_FILE);
  if (maxPerFileFromEnv !== undefined) {
    options.maxPerFile = maxPerFileFromEnv;
  }

  const timeoutFromEnv = parsePositiveIntegerEnv(process.env.MUTATION_TIMEOUT_MS);
  if (timeoutFromEnv !== undefined) {
    options.timeoutMs = timeoutFromEnv;
  }

  if (!options.testCommandOverride && process.env.MUTATION_TEST_COMMAND) {
    options.testCommandOverride = process.env.MUTATION_TEST_COMMAND;
  }

  return options;
}

function readBaseline(path: string): BaselineReport {
  const absolute = resolve(path);
  const content = readFileSync(absolute, "utf-8");
  return JSON.parse(content) as BaselineReport;
}

function lineColumnAt(content: string, index: number): { line: number; column: number } {
  const head = content.slice(0, index);
  const segments = head.split("\n");
  return {
    line: segments.length,
    column: segments[segments.length - 1].length + 1,
  };
}

function isCommentOnlyLine(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  const lineEndIndex = content.indexOf("\n", index);
  const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex;
  const line = content.slice(lineStart, lineEnd).trim();
  return (
    line.startsWith("//") ||
    line.startsWith("*") ||
    line.startsWith("/*") ||
    line.startsWith("*/")
  );
}

function resolveTestCommand(file: string, override?: string): string {
  if (override) {
    return override;
  }

  const normalized = file.replace(/\\/g, "/");
  if (
    normalized.endsWith("/tools/run-mutation-changed.ts") ||
    normalized.endsWith("/tools/check-mutation-gate.ts")
  ) {
    return "bun --env-file=.env test src/test/mutation-tools.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/service.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 --timeout 120000 src/test/schema-service-private-coverage.test.ts src/test/pull.test.ts src/test/postgres-public-schema-bootstrap.test.ts src/test/sqlite/pull.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/pull.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 --timeout 120000 src/test/pull.test.ts src/test/sqlite/pull.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/differ.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 --timeout 120000 src/test/schema-differ-private-coverage.test.ts src/test/columns/postgres-generated-function-dependency.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/parser/sequence-parser.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/sequences/sequence-parsing.test.ts src/test/parser-module-coverage.test.ts";
  }
  if (normalized.includes("/src/core/schema/parser")) {
    return "bun --env-file=.env test --max-concurrency=1 --timeout 120000 src/test/schema-parser-private-coverage.test.ts src/test/postgres-comments-lossless.test.ts src/test/postgres-schema-authorization.test.ts src/test/postgres-extension-dependencies.test.ts src/test/parser-edge-coverage.test.ts src/test/parser-gap-coverage.test.ts src/test/parser-object-matrix-parity.test.ts src/test/parser-module-coverage.test.ts src/test/function-parser-private-coverage.test.ts src/test/procedure-parser-coverage.test.ts src/test/composite-type-parser-coverage.test.ts src/test/constraint-parser-coverage.test.ts src/test/table-parser-coverage.test.ts src/test/views/view-parsing.test.ts src/test/triggers/basic-triggers.test.ts src/test/postgres-unsupported-statements.test.ts src/test/tables/postgres-table-persistence.test.ts src/test/columns/postgres-column-statistics.test.ts src/test/indexes/postgres-index-keys.test.ts src/test/advanced-sql-object-parsing.test.ts src/test/postgres-foreign-server-lifecycle.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/enum-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/enums/enum-handler-schema-scope.test.ts src/test/enums/postgres-enum-evolution.test.ts src/test/enums/postgres-enum-dependencies.test.ts src/test/types/enum-types.test.ts src/test/types/postgres-type-ordering.test.ts";
  }
  if (normalized.includes("/src/core/schema/handlers/composite-type-")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/types/composite-type-evolution.test.ts src/test/types/composite-types.test.ts src/test/composite-type-parser-coverage.test.ts src/test/types/postgres-type-ordering.test.ts src/test/enums/postgres-enum-dependencies.test.ts src/test/types/postgres-type-catalog-dependencies.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/postgres-type-dependency-safety.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/enums/postgres-enum-dependencies.test.ts src/test/types/domain-range-lifecycle.test.ts src/test/types/composite-type-evolution.test.ts src/test/types/postgres-type-catalog-dependencies.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/postgres-type-ordering.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/types/postgres-type-ordering.test.ts src/test/types/domain-range-lifecycle.test.ts src/test/types/composite-type-evolution.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/postgres-type-object-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/types/domain-range-lifecycle.test.ts src/test/types/postgres-type-catalog-dependencies.test.ts src/test/sql-object-handler.test.ts src/test/advanced-sql-object-parsing.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/sql-object-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/sql-object-handler.test.ts src/test/schema-service-private-coverage.test.ts src/test/postgres-advanced-drop-safety.test.ts src/test/postgres-foreign-server-lifecycle.test.ts src/test/types/domain-range-lifecycle.test.ts src/test/types/postgres-type-ordering.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/sequence-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/handler-module-coverage.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/extension-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/postgres-extension-dependencies.test.ts src/test/handler-module-coverage.test.ts src/test/regressions/extension-schema-diff.test.ts src/test/regressions/extension-version-diff.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/schema-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/postgres-schema-authorization.test.ts src/test/handler-module-coverage.test.ts src/test/regressions/schema-owner-diff.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/handlers/view-handler.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/views/sql-generation.test.ts src/test/views/view-definition-normalization-matrix.test.ts src/test/views/postgres-view-column-names.test.ts src/test/views/postgres-view-options.test.ts src/test/views/materialized-views.test.ts src/test/tables/postgres-clustering.test.ts src/test/indexes/postgres-materialized-view-indexes.test.ts src/test/columns/postgres-column-statistics.test.ts src/test/indexes/postgres-index-keys.test.ts src/test/views/view-dependency-order.test.ts";
  }
  if (normalized.includes("/src/core/schema/handlers/")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/sql-object-handler.test.ts src/test/schema-service-private-coverage.test.ts";
  }
  if (normalized.endsWith("/src/core/schema/inspector.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/inspector-coverage.test.ts src/test/inspector-version-snapshots.test.ts src/test/postgres-extension-dependencies.test.ts src/test/postgres-advanced-drop-safety.test.ts src/test/postgres-foreign-server-lifecycle.test.ts src/test/advanced-sql-object-inspector.test.ts src/test/types/composite-type-evolution.test.ts src/test/types/domain-range-lifecycle.test.ts src/test/enums/postgres-enum-dependencies.test.ts src/test/types/postgres-type-catalog-dependencies.test.ts";
  }
  if (normalized.endsWith("/src/providers/sqlite/index.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/sqlite/table-recreation.test.ts src/test/sqlite/validation.test.ts";
  }
  if (
    normalized.endsWith("/src/providers/sqlite/differ.ts") ||
    normalized.endsWith("/src/providers/sqlite/parser.ts") ||
    normalized.endsWith("/src/providers/sqlite/sql-parser-utils.ts")
  ) {
    return "bun run test:sqlite";
  }
  if (normalized.endsWith("/src/providers/sqlite/inspector.ts")) {
    return "bun run test:sqlite";
  }
  if (normalized.endsWith("/src/providers/postgres/connection.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/postgres-connection-strings.test.ts src/test/database-config.test.ts";
  }
  if (normalized.endsWith("/src/utils/sql.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/utils/sql-generators-coverage.test.ts src/test/utils/sql-utils.test.ts src/test/types/composite-type-evolution.test.ts";
  }
  if (normalized.endsWith("/src/utils/statement-classifier.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 --timeout 120000 src/test/properties/destructive-diff-classification.property.test.ts src/test/cli/cli-contract.test.ts src/test/types/composite-type-evolution.test.ts";
  }
  if (normalized.endsWith("/src/utils/expression-comparator.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/utils/expression-comparator-coverage.test.ts src/test/postgres-expression-literal-semantics.test.ts";
  }
  if (normalized.endsWith("/src/utils/postgres-foreign-server.ts")) {
    return "bun --env-file=.env test --max-concurrency=1 src/test/postgres-foreign-server-lifecycle.test.ts src/test/advanced-sql-object-parsing.test.ts src/test/sql-object-handler.test.ts src/test/advanced-sql-object-inspector.test.ts";
  }
  return "bun --env-file=.env test --max-concurrency=1 src/test/schema-service-private-coverage.test.ts";
}

function isChangedLine(
  line: number,
  changedLines: readonly ChangedLineRange[] | undefined
): boolean {
  if (changedLines === undefined) {
    return true;
  }
  return changedLines.some(function (range) {
    return line >= range.start && line <= range.end;
  });
}

function generateCandidatesForFile(
  file: string,
  content: string,
  maxPerFile: number,
  command: string,
  changedLines?: readonly ChangedLineRange[]
): MutationCandidate[] {
  const collected: MutationCandidate[] = [];
  const seen = new Set<string>();
  let sequence = 1;

  for (const operator of OPERATORS) {
    operator.pattern.lastIndex = 0;
    let match = operator.pattern.exec(content);
    while (match && collected.length < maxPerFile) {
      const start = match.index;
      const end = start + match[0].length;
      const original = match[0];
      const key = `${start}:${end}:${operator.replacement}`;
      const location = lineColumnAt(content, start);
      if (
        !seen.has(key) &&
        original !== operator.replacement &&
        !isCommentOnlyLine(content, start) &&
        isChangedLine(location.line, changedLines)
      ) {
        seen.add(key);
        collected.push({
          id: `${file}#${sequence}`,
          file,
          operator: operator.name,
          start,
          end,
          original,
          replacement: operator.replacement,
          line: location.line,
          column: location.column,
          command,
        });
        sequence += 1;
      }
      match = operator.pattern.exec(content);
    }
    if (collected.length >= maxPerFile) {
      break;
    }
  }

  return collected;
}

function parseChangedLineRanges(diff: string): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(
      /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
    );
    if (!match?.[1]) {
      continue;
    }
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined
      ? 1
      : Number.parseInt(match[2], 10);
    if (count === 0) {
      continue;
    }
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function getChangedLineRanges(
  file: string,
  diffRef: string | null | undefined
): ChangedLineRange[] | undefined {
  if (!diffRef) {
    return undefined;
  }
  const filePath = relative(process.cwd(), file).replace(/\\/g, "/");
  try {
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--unified=0",
        "--no-color",
        "--end-of-options",
        diffRef,
        "--",
        filePath,
      ],
      { encoding: "utf-8" }
    );
    return parseChangedLineRanges(diff);
  } catch {
    return undefined;
  }
}

function extractFailure(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const record = error as Record<string, unknown>;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const message = stderr || stdout || String(error);
  return message.trim().slice(0, 500);
}

function runCommand(command: string, timeoutMs: number): { ok: boolean; failure?: string } {
  try {
    execSync(command, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 8,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: extractFailure(error) };
  }
}

function runMutant(candidate: MutationCandidate, content: string, timeoutMs: number): MutationResult {
  const before = content.slice(0, candidate.start);
  const after = content.slice(candidate.end);
  const mutated = `${before}${candidate.replacement}${after}`;
  writeFileSync(candidate.file, mutated, "utf-8");

  const startedAt = Date.now();
  const run = runCommand(candidate.command, timeoutMs);
  const durationMs = Date.now() - startedAt;
  writeFileSync(candidate.file, content, "utf-8");

  if (run.ok) {
    return {
      id: candidate.id,
      file: candidate.file,
      operator: candidate.operator,
      line: candidate.line,
      column: candidate.column,
      original: candidate.original,
      replacement: candidate.replacement,
      command: candidate.command,
      status: "survived",
      durationMs,
    };
  }

  return {
    id: candidate.id,
    file: candidate.file,
    operator: candidate.operator,
    line: candidate.line,
    column: candidate.column,
    original: candidate.original,
    replacement: candidate.replacement,
    command: candidate.command,
    status: "killed",
    durationMs,
    failure: run.failure,
  };
}

function writeReport(path: string, report: MutationReport): void {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function printSummary(report: MutationReport, reportPath: string): void {
  console.log(`mutation files: ${report.totalTargetFiles}`);
  console.log(`mutation mutants: ${report.totalMutants}`);
  console.log(`mutation killed: ${report.killed}`);
  console.log(`mutation survived: ${report.survived}`);
  console.log(`mutation score: ${report.score.toFixed(2)}`);
  console.log(`mutation report: ${reportPath}`);
}

function uniqueCommands(candidates: MutationCandidate[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.command)) {
      continue;
    }
    seen.add(candidate.command);
    output.push(candidate.command);
  }
  return output;
}

function resolveTargetFiles(baseline: BaselineReport): string[] {
  const deduped = new Set<string>();
  for (const entry of baseline.targetFiles || []) {
    deduped.add(resolve(entry.file));
  }
  return Array.from(deduped);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const baseline = readBaseline(options.baselinePath);
  const targetFiles = resolveTargetFiles(baseline);

  const candidates: MutationCandidate[] = [];
  const originals = new Map<string, string>();
  for (const file of targetFiles) {
    const content = readFileSync(file, "utf-8");
    originals.set(file, content);
    const command = resolveTestCommand(file, options.testCommandOverride);
    const changedLines = getChangedLineRanges(file, baseline.diffRef);
    const fileCandidates = generateCandidatesForFile(
      file,
      content,
      options.maxPerFile,
      command,
      changedLines
    );
    candidates.push(...fileCandidates);
  }

  if (candidates.length > 0) {
    const commands = uniqueCommands(candidates);
    for (const command of commands) {
      const preflight = runCommand(command, options.timeoutMs);
      if (!preflight.ok) {
        throw new Error(
          `Mutation preflight failed for command: ${command}\n${preflight.failure || ""}`
        );
      }
    }
  }

  const results: MutationResult[] = [];
  for (const candidate of candidates) {
    const original = originals.get(candidate.file);
    if (!original) {
      throw new Error(`Missing source content for ${candidate.file}`);
    }
    const result = runMutant(candidate, original, options.timeoutMs);
    results.push(result);
  }

  for (const entry of originals.entries()) {
    writeFileSync(entry[0], entry[1], "utf-8");
  }

  const killed = results.filter(function (result) {
    return result.status === "killed";
  }).length;
  const survived = results.filter(function (result) {
    return result.status === "survived";
  }).length;
  const totalMutants = results.length;
  const score = totalMutants === 0 ? 100 : (killed / totalMutants) * 100;

  const report: MutationReport = {
    generatedAt: new Date().toISOString(),
    reportVersion: 1,
    baselinePath: resolve(options.baselinePath),
    totalTargetFiles: targetFiles.length,
    totalMutants,
    killed,
    survived,
    score,
    maxPerFile: options.maxPerFile,
    timeoutMs: options.timeoutMs,
    durationMs: Date.now() - startedAt,
    files: targetFiles,
    diffRef: baseline.diffRef || null,
    results,
  };

  writeReport(options.reportPath, report);
  printSummary(report, options.reportPath);
}

main();
