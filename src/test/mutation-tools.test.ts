import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type SummarizedReport = {
  totalEscaped: number;
  modules: Array<Record<string, unknown>>;
  mutants: Array<Record<string, unknown>>;
};

type NativeMutationReport = {
  diffRef: string | null;
  shard?: string | null;
  allCandidates?: number;
  results: Array<{
    command: string;
    line: number;
    status: string;
  }>;
};

type MutationGateReport = {
  diffRef: string | null;
};

function summarizeEscapedMutants(input: unknown): SummarizedReport {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "terradb-mutation-rollup-"));
  const inputPath = join(temporaryDirectory, "mutation-report.json");
  const outputPath = join(temporaryDirectory, "escaped-mutants.json");

  try {
    writeFileSync(inputPath, JSON.stringify(input));
    execFileSync(
      process.execPath,
      [
        "run",
        resolve("tools/summarize-escaped-mutants.ts"),
        "--report",
        inputPath,
        "--out",
        outputPath,
      ],
      {
        cwd: process.cwd(),
        stdio: "pipe",
      }
    );
    return JSON.parse(readFileSync(outputPath, "utf-8")) as SummarizedReport;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runChangedLineMutationScenario(
  mode: "changed" | "deleted" | "whole-file",
  extraArgs: string[] = []
): NativeMutationReport {
  const temporaryDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "terradb-mutation-runner-"))
  );
  const sourceDirectory = join(
    temporaryDirectory,
    "src",
    "providers",
    "sqlite"
  );
  const sourcePath = join(sourceDirectory, "parser.ts");
  const verificationPath = join(temporaryDirectory, "candidate.test.ts");
  const baselinePath = join(temporaryDirectory, "baseline.json");
  const reportPath = join(temporaryDirectory, "mutation-report.json");
  const initialSource = [
    "export const first = true;",
    "export const second = false;",
    "export const changed = true;",
    "",
  ].join("\n");
  const changedSource = mode === "deleted"
    ? [
      "export const first = true;",
      "export const second = false;",
      "",
    ].join("\n")
    : [
      "export const first = true;",
      "export const second = false;",
      "export const changed = false;",
      "",
    ].join("\n");

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(sourcePath, initialSource);
    writeFileSync(join(temporaryDirectory, "package.json"), JSON.stringify({
      scripts: {
        "test:sqlite": "bun test candidate.test.ts",
      },
    }));
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryDirectory });
    execFileSync("git", ["config", "user.email", "test@terradb.local"], {
      cwd: temporaryDirectory,
    });
    execFileSync("git", ["config", "user.name", "TerraDB Test"], {
      cwd: temporaryDirectory,
    });
    execFileSync("git", ["add", "src/providers/sqlite/parser.ts"], {
      cwd: temporaryDirectory,
    });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: temporaryDirectory,
    });
    writeFileSync(sourcePath, changedSource);
    writeFileSync(verificationPath, `
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("keeps the expected changed literal", function () {
  const source = readFileSync(${JSON.stringify(sourcePath)}, "utf-8");
  expect(source).toContain("changed = false");
});
`);
    writeFileSync(baselinePath, JSON.stringify({
      targetFiles: [{ file: sourcePath, selected: true }],
      diffRef: mode === "whole-file" ? null : "HEAD",
    }));

    execFileSync(
      process.execPath,
      [
        "run",
        resolve("tools/run-mutation-changed.ts"),
        "--baseline",
        baselinePath,
        "--report",
        reportPath,
        "--max-per-file",
        "10",
        "--timeout-ms",
        "30000",
        ...extraArgs,
      ],
      {
        cwd: temporaryDirectory,
        stdio: "pipe",
      }
    );
    return JSON.parse(readFileSync(reportPath, "utf-8")) as NativeMutationReport;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runMutationGate(
  args: string[],
  environment: Record<string, string>
): MutationGateReport {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "terradb-mutation-gate-"));
  const reportPath = join(temporaryDirectory, "gate-report.json");

  try {
    execFileSync(
      process.execPath,
      [
        "run",
        resolve("tools/check-mutation-gate.ts"),
        "--mode",
        "report",
        "--out",
        reportPath,
        "--score",
        "100",
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MUTATION_BASE_REF: "",
          MUTATION_HEAD_REF: "",
          ...environment,
        },
        stdio: "pipe",
      }
    );
    return JSON.parse(readFileSync(reportPath, "utf-8")) as MutationGateReport;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("escaped mutant rollup reads native runner reports", function () {
  const sourcePath = resolve("src/providers/sqlite/index.ts");
  const report = summarizeEscapedMutants({
    results: [
      {
        id: `${sourcePath}#1`,
        file: sourcePath,
        operator: "false_to_true",
        line: 486,
        column: 46,
        replacement: "true",
        status: "survived",
      },
      {
        id: `${sourcePath}#2`,
        file: sourcePath,
        operator: "true_to_false",
        line: 504,
        column: 47,
        replacement: "false",
        status: "killed",
      },
    ],
  });

  expect(report.totalEscaped).toBe(1);
  expect(report.modules).toEqual([{
    module: "sqlite-provider",
    escapedCount: 1,
    files: [sourcePath],
    reasons: ["controls SQLite migration atomicity and integrity verification"],
  }]);
  expect(report.mutants).toEqual([{
    id: `${sourcePath}#1`,
    file: sourcePath,
    status: "survived",
    mutator: "false_to_true",
    replacement: "true",
    location: { line: 486, column: 46 },
    module: "sqlite-provider",
    reason: "controls SQLite migration atomicity and integrity verification",
  }]);
});

test("escaped mutant rollup retains Stryker report compatibility", function () {
  const sourcePath = "src/core/schema/differ.ts";
  const report = summarizeEscapedMutants({
    files: {
      [sourcePath]: {
        mutants: [
          {
            id: "stryker-survivor",
            status: "Survived",
            mutatorName: "ConditionalExpression",
            replacement: "false",
            location: { start: { line: 17, column: 4 } },
          },
          {
            id: "stryker-killed",
            status: "Killed",
            mutatorName: "BooleanLiteral",
            replacement: "true",
            location: { start: { line: 20, column: 2 } },
          },
        ],
      },
    },
  });

  expect(report.totalEscaped).toBe(1);
  expect(report.modules).toEqual([{
    module: "core-schema",
    escapedCount: 1,
    files: [sourcePath],
    reasons: ["directly controls migration safety and idempotency"],
  }]);
  expect(report.mutants).toEqual([expect.objectContaining({
    id: "stryker-survivor",
    mutator: "ConditionalExpression",
    location: { line: 17, column: 4 },
  })]);
});

test("changed mutation candidates stay inside added and modified lines", function () {
  const changedReport = runChangedLineMutationScenario("changed");
  const deletionReport = runChangedLineMutationScenario("deleted");
  const wholeFileReport = runChangedLineMutationScenario("whole-file");

  expect(changedReport.diffRef).toBe("HEAD");
  expect(changedReport.results).toEqual([
    expect.objectContaining({
      command: "bun run test:sqlite",
      line: 3,
      status: "killed",
    }),
  ]);
  expect(deletionReport.results).toEqual([]);
  expect(wholeFileReport.diffRef).toBeNull();
  expect(wholeFileReport.results.map(function (result) {
    return result.line;
  })).toEqual([1, 2, 3]);
});

test("mutation runner --shard runs only its slice of the candidates", function () {
  const first = runChangedLineMutationScenario("whole-file", ["--shard", "1/2"]);
  const second = runChangedLineMutationScenario("whole-file", ["--shard", "2/2"]);

  expect(first.shard).toBe("1/2");
  expect(first.allCandidates).toBe(3);
  expect(first.results.map(function (result) {
    return result.line;
  })).toEqual([1]);
  expect(second.shard).toBe("2/2");
  expect(second.results.map(function (result) {
    return result.line;
  })).toEqual([2, 3]);
});

test("mutation gate resolves clean-checkout base and head refs", function () {
  const pullRequestReport = runMutationGate([], {
    MUTATION_BASE_REF: "HEAD",
    MUTATION_HEAD_REF: "HEAD^0",
  });
  const defaultHeadReport = runMutationGate([], {
    MUTATION_BASE_REF: "HEAD",
  });
  const commandLineReport = runMutationGate([
    "--base",
    "HEAD^0",
    "--head",
    "HEAD",
  ], {
    MUTATION_BASE_REF: "HEAD",
    MUTATION_HEAD_REF: "HEAD^0",
  });

  expect(pullRequestReport.diffRef).toBe(
    "HEAD...HEAD^0"
  );
  expect(defaultHeadReport.diffRef).toBe("HEAD...HEAD");
  expect(commandLineReport.diffRef).toBe("HEAD^0...HEAD");
  expect(runMutationGate([], {}).diffRef).toBe("HEAD");
  expect(runMutationGate([
    "--files",
    "src/core/schema/differ.ts",
  ], {}).diffRef).toBeNull();
});

test("mutation shards partition candidates by command without overlap", async function () {
  const { parseShard, selectShardCandidates } = await import("../../tools/mutation-shard");
  const candidates = [
    { id: "b#1", command: "test b" },
    { id: "a#1", command: "test a" },
    { id: "b#2", command: "test b" },
    { id: "a#2", command: "test a" },
    { id: "c#1", command: "test c" },
  ];

  const shards = [1, 2, 3].map(function select(index) {
    return selectShardCandidates(candidates, { index, count: 3 });
  });

  expect(shards.map(function ids(shard) {
    return shard.map(function id(candidate) {
      return candidate.id;
    });
  })).toEqual([["a#1"], ["a#2", "b#1"], ["b#2", "c#1"]]);
  expect(shards.flat()).toHaveLength(candidates.length);
  expect(selectShardCandidates(candidates, undefined)).toEqual(candidates);
  expect(parseShard("2/4")).toEqual({ index: 2, count: 4 });
  expect(function invalidShard() {
    return parseShard("5/4");
  }).toThrow('Invalid shard "5/4"');
});

test("merged mutation reports score every shard and reject missing shards", async function () {
  const { mergeMutationReports } = await import("../../tools/merge-mutation-reports");
  function shardReport(shard: string, results: Array<{ id: string; status: "killed" | "survived" }>) {
    return {
      totalTargetFiles: 2,
      maxPerFile: 4,
      timeoutMs: 1000,
      durationMs: 10,
      files: ["a.ts", "b.ts"],
      diffRef: "base...head",
      shard,
      allCandidates: 3,
      results: results.map(function withDuration(result) {
        return { ...result, durationMs: 1 };
      }),
    };
  }

  const merged = mergeMutationReports([
    shardReport("1/2", [{ id: "a#1", status: "killed" }]),
    shardReport("2/2", [
      { id: "a#2", status: "survived" },
      { id: "b#1", status: "killed" },
    ]),
  ]);
  expect(merged).toMatchObject({ totalMutants: 3, killed: 2, survived: 1 });
  expect(merged.score).toBeCloseTo(66.67, 2);

  expect(function missingShard() {
    return mergeMutationReports([
      shardReport("1/2", [{ id: "a#1", status: "killed" }]),
    ]);
  }).toThrow("Expected one report per shard");
  expect(function duplicatedMutant() {
    return mergeMutationReports([
      shardReport("1/2", [{ id: "a#1", status: "killed" }]),
      shardReport("2/2", [
        { id: "a#1", status: "killed" },
        { id: "b#1", status: "killed" },
      ]),
    ]);
  }).toThrow("appears in more than one shard report");
});
