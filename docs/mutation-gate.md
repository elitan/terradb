# mutation gate

scripts:

1. baseline + changed-file mutation run: `bun run test:mutation:changed:report`
2. threshold gate with generated report: `bun run test:mutation:changed:gate`
3. escaped mutant rollup: `bun run test:mutation:escaped:report`

defaults:

1. threshold: `85`
2. minimum risk level: `high`
3. manifest: `tools/mutation-risk-manifest.ts`
4. output: `coverage/mutation/changed-files-baseline.json`

score sources:

1. `--score <value>`
2. `MUTATION_SCORE_CHANGED=<value>`
3. `--report <path>` with `score` or `mutationScore`
4. default generated report: `coverage/mutation/mutation-report.json`

changed-file mutation runner:

1. tool: `tools/run-mutation-changed.ts`
2. input baseline report: `coverage/mutation/changed-files-baseline.json`
3. output report: `coverage/mutation/mutation-report.json`
4. default operators: boolean flip, strict equality flip, logical and/or flip
5. defaults: `max-per-file=4`, `timeout-ms=120000`
6. env overrides: `MUTATION_MAX_MUTANTS_PER_FILE`, `MUTATION_TIMEOUT_MS`, `MUTATION_TEST_COMMAND`
7. when a git diff reference is available, candidates are selected only from added or modified hunk lines; deletion-only hunks produce no candidates
8. reports include the exact `diffRef` used and each selected mutant's final-file line and column

sharding:

1. `run-mutation-changed.ts --shard k/N` runs a contiguous, command-ordered slice of the candidates, so shards preflight as few distinct commands as possible
2. `bun run test:mutation:changed:report --shard k/N` passes the flag through to the runner
3. `tools/merge-mutation-reports.ts --out <path> <report>...` combines shard reports and fails when a shard is missing or a mutant appears twice
4. CI runs four shards and gates the merged report in `test:mutation:changed`

changed file sources:

1. `--files file1,file2`
2. `--files-from <path>`
3. `--base <ref> --head <ref>`
4. `MUTATION_BASE_REF` plus optional `MUTATION_HEAD_REF` (defaults to `HEAD`)
5. fallback: `git diff --name-only --diff-filter=ACMRTUXB HEAD`
6. CI checks out full history and supplies the event base and head SHAs, so committed pull-request and push changes are visible from a clean worktree
7. explicit `--files` and `--files-from` inputs have no hunk reference, so their candidate selection covers the whole target file

gate behavior:

1. if no target files match risk threshold: pass
2. if target files exist and score is missing:
3. `report` mode: pass and write baseline report
4. `gate` mode: fail
5. if score exists and score < threshold: fail
6. otherwise: pass

escaped mutant report output:

1. file: `coverage/mutation/escaped-mutants.json`
2. top-level fields: `totalEscaped`, `modules`, `mutants`
3. module rollup groups escaped mutants by owner/path mapping from `tools/mutation-risk-manifest.ts`
4. accepts native changed-file runner `results`, Stryker `files.*.mutants`, and generic top-level `mutants` reports
5. normalizes native `operator` plus direct line/column fields and both absolute and repository-relative source paths
