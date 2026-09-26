import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type MutationResult = {
  id: string;
  status: "killed" | "survived";
  durationMs: number;
};

type ShardReport = {
  totalTargetFiles: number;
  maxPerFile: number;
  timeoutMs: number;
  durationMs: number;
  files: string[];
  diffRef: string | null;
  shard?: string | null;
  allCandidates?: number;
  results: MutationResult[];
};

/**
 * Combines the reports of `run-mutation-changed.ts --shard k/N` runs into a
 * single report whose score covers every candidate, and fails when a shard
 * report is missing so a lost shard cannot raise the score.
 */
export function mergeMutationReports(reports: ShardReport[]) {
  if (reports.length === 0) {
    throw new Error("No mutation reports to merge");
  }
  const expected = reports[0]!.allCandidates;
  const shardCounts = new Set(
    reports.map(function getShardCount(report) {
      return report.shard ? Number(report.shard.split("/")[1]) : 1;
    })
  );
  if (shardCounts.size !== 1 || [...shardCounts][0] !== reports.length) {
    throw new Error(
      `Expected one report per shard, received ${reports.length} report(s) for shard counts ${[...shardCounts].join(", ")}`
    );
  }
  const seen = new Set<string>();
  const results: MutationResult[] = [];
  for (const report of reports) {
    for (const result of report.results) {
      if (seen.has(result.id)) {
        throw new Error(`Mutant ${result.id} appears in more than one shard report`);
      }
      seen.add(result.id);
      results.push(result);
    }
  }
  if (expected !== undefined && results.length !== expected) {
    throw new Error(
      `Shard reports cover ${results.length} of ${expected} mutation candidates`
    );
  }
  const killed = results.filter(function isKilled(result) {
    return result.status === "killed";
  }).length;
  const totalMutants = results.length;
  return {
    generatedAt: new Date().toISOString(),
    reportVersion: 1,
    totalTargetFiles: reports[0]!.totalTargetFiles,
    totalMutants,
    killed,
    survived: totalMutants - killed,
    score: totalMutants === 0 ? 100 : (killed / totalMutants) * 100,
    maxPerFile: reports[0]!.maxPerFile,
    timeoutMs: reports[0]!.timeoutMs,
    durationMs: Math.max(...reports.map(function getDuration(report) {
      return report.durationMs;
    })),
    files: reports[0]!.files,
    diffRef: reports[0]!.diffRef,
    shard: null,
    allCandidates: totalMutants,
    results,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex === -1 || !args[outIndex + 1]) {
    throw new Error("Usage: merge-mutation-reports.ts --out <path> <report>...");
  }
  const outPath = resolve(args[outIndex + 1]!);
  const inputs = args.filter(function isInput(_arg, index) {
    return index !== outIndex && index !== outIndex + 1;
  });
  const merged = mergeMutationReports(
    inputs.map(function readReport(path) {
      return JSON.parse(readFileSync(path, "utf-8")) as ShardReport;
    })
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  console.log(`mutation mutants: ${merged.totalMutants}`);
  console.log(`mutation killed: ${merged.killed}`);
  console.log(`mutation survived: ${merged.survived}`);
  console.log(`mutation score: ${merged.score.toFixed(2)}`);
}
