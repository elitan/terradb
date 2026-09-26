# core invariants

## idempotency

1. applying the same schema twice must produce zero statements on second run.
2. equivalent sql forms must not produce drift.
3. idempotency must hold for postgres and sqlite.

## deterministic output

1. json output must include `schemaVersion`.
2. statement ordering must be stable across repeated runs.
3. statement metadata must include `order`, `channel`, `category`, `risk`.

## destructive safety

1. destructive statements must be detectable from generated plan.
2. `--strict` must block destructive apply execution.
3. strict failures must return stable error code `STRICT_MODE_ERROR`.

## transaction and rollback

1. transactional statements must execute atomically.
2. failures must leave database in previous consistent state.
3. concurrent statements must report exact failing statement.
4. pre-transactional enum additions must be the only planned change; mixed plans fail before mutation.
5. concurrent statements must finish before deferred transactional statements that depend on them.
6. PostgreSQL explicit concurrent index work must be one standalone statement; failed creates remove only their newly-created invalid artifact. Once no concurrent statement remains, every deferred statement joins the main transaction.

## error contract

1. cli json error output must include `schemaVersion`.
2. cli json error output must include `error.code`, `error.name`, `error.message`.
3. all terra error subclasses must expose stable `code`.

## schema filtering

1. unmanaged schemas must be ignored for managed-object reconciliation.
2. external fk references must remain valid.
3. extension-owned objects must not be treated as user-managed objects.

## type normalization

1. type aliases that are semantically equal must not produce diffs.
2. precision/scale compatible forms must normalize deterministically.
3. normalization must be stable across pg14 to pg18.

## pull

1. a pulled schema must plan zero changes against its source database.
2. pull must write nothing when that verification fails, and must not replace an existing file without `--overwrite`.
3. the pulled scope must equal what an empty desired schema would reconcile for the same schemas and management flags.
