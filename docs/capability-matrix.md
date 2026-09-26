# capability matrix

This is the concise support contract for TerraDB. `README.md` is the public
feature claim; `docs/test-matrix.md` contains the operation-level test detail;
this document joins them so an audit can distinguish a supported feature from a
safe rejection.

## scope and evidence

- PostgreSQL: one portable declarative contract for versions 14 through 18.
  Normal CI executes the endpoint versions (14 and 18); the version-matrix
  commands and variance map cover the complete range.
- SQLite: the pinned `libsql` 0.5.29 runtime, which embeds SQLite 3.45.1 with
  FTS5 and RTree. TerraDB does not imply support for a system SQLite binary.
- `P/I/D/E` means parser, inspector, differ, and executor have real test
  coverage. `CLI` means JSON/text plan or apply behavior is covered. Links are
  intentionally repository-local evidence rather than aspirational checkmarks.
- A `Yes` here means lossless management or a pre-mutation, actionable
  rejection. It never means a feature can be silently ignored.

| public capability and meaningful subfeatures | PostgreSQL | SQLite | P/I/D/E and CLI evidence | safety, variance, and exclusions |
| --- | --- | --- | --- | --- |
| tables and columns: schema-qualified tables, inheritance/partitions, persistence, storage, tablespaces, `STRICT`, `WITHOUT ROWID`, ROWID and AUTOINCREMENT | 14–18 | 3.45.1 | `src/test/tables/`, `src/test/columns/`, `src/test/sqlite/table-recreation.test.ts`, `src/test/cli/cli-contract.test.ts` | destructive drops and physical rewrites are strict-blocked; PostgreSQL unlogged partition hierarchies are rejected; SQLite recreation preserves rows, dependencies, and PRAGMA state |
| generated columns | stored: 14–18; virtual: 18 | virtual and stored | `src/test/columns/generated-columns.test.ts`, `src/test/columns/postgres-generated-function-dependency.test.ts`, `src/test/tables/postgres-table-inheritance.test.ts`, `src/test/sqlite/generated-columns.test.ts` | PostgreSQL same-apply functions referenced from stored generated expressions are created before their tables; local-schema function qualification normalizes on re-plan. Generated expressions that read a generated column or prohibited system column, generated columns declaring `DEFAULT` or identity, generated columns referenced directly or in an expression by a partition key, and incompatible generated inheritance declarations reject before mutation on 14–18; `tableoid` remains permitted. Virtual definitions reject before mutation on 14–17; on 18, desired or inspected user-defined function/type references—including declared enum, composite/table-row, domain, or range types, expression casts, and referenced user-typed columns—plus non-`pg_catalog` qualified operators and unqualified operators with no built-in counterpart reject during planning because PostgreSQL virtual expressions permit built-in functions/types only |
| primary, unique, check, and foreign-key constraints: names, deferral, actions, validation, collations | 14–18 | 3.45.1 | `src/test/constraints/`, `src/test/properties/constraint-properties.property.test.ts`, `src/test/sqlite/constraints.test.ts` | unsafe constraint weakening/removal is destructive; an invalid later routine rolls back an earlier ordinary check-constraint addition, preserving table OID/data and leaving no constraint artifact; unsupported PostgreSQL 18 temporal/unenforced forms and SQLite unenforced `MATCH` modes reject |
| indexes: expression, partial, collation, ordering, INCLUDE/opclass/options, concurrent builds | 14–18 | 3.45.1 | `src/test/indexes/`, `src/test/postgres-concurrent-index-safety.test.ts`, `src/test/properties/index-properties.property.test.ts`, `src/test/sqlite/advanced-indexes.test.ts` | PostgreSQL explicit concurrent work is one standalone statement; mixed plans reject before mutation and failed creates remove their own invalid artifact. A later invalid routine also rolls back an earlier ordinary transactional index creation, preserving table OID/data and leaving no index artifact. New-table concurrent declarations and their dependent assignments become one transaction; implicit drops sharing other work are transactional, while a sole drop remains concurrent. All other matching is lexical/AST-aware |
| views | ordinary: 14–18 | 3.45.1 | `src/test/views/`, `src/test/sqlite/indexes-views.test.ts`, `src/test/cli/cli-contract.test.ts` | PostgreSQL parsed query equivalence preserves literal content; SQLite rebuild restores dependent views |
| materialized views, population, indexes, physical metadata | 14–18 | not an SQLite feature | `src/test/views/materialized-views.test.ts`, `src/test/views/postgres-materialized-view-*.test.ts` | depopulation, physical rewrites, and metadata resets are strict-blocked where destructive |
| PostgreSQL types: enums, composites, domains, ranges, multiranges | 14–18 | not an SQLite feature | `src/test/enums/`, `src/test/types/`, `src/test/postgres-type-*.test.ts` | enum label additions are standalone committed migrations; mixed plans reject before mutation, and unsupported type evolution rejects before mutation |
| sequences and identity/serial dependencies | 14–18 | not an SQLite feature | `src/test/sequences/`, `src/test/columns/identity-columns.test.ts`, `src/test/edge-cases/column-serial.test.ts` | live counters are runtime state; unsafe serial transitions and version-inexpressible drift reject. A failed later routine definition rolls back an in-place sequence alteration, including its OID, options, and live counter. |
| functions and procedures: signatures, overloads, bodies, options, configuration | 14–18 | not an SQLite feature | `src/test/functions/`, `src/test/regressions/function-*.test.ts`, `src/test/regressions/procedure-*.test.ts` | drops use `RESTRICT`; dependency-breaking or unmodelled routine forms reject. A failed later procedure replacement rolls back an earlier function replacement and leaves both original bodies converged. |
| triggers: table, constraint, event, transition tables, execution modes | 14–18 | 3.45.1 | `src/test/triggers/`, `src/test/sqlite/schema-object-recreation.test.ts` | disabling/replica weakening is destructive; trigger bodies retain lexical content. A failed later trigger creation rolls an earlier trigger replacement back and preserves runtime firing behavior. |
| schemas and roles | 14–18 | not an SQLite feature | `src/test/postgres-schema-authorization.test.ts`, `src/test/postgres-role*.test.ts` | global state remains scoped to declarations; owner/capability removals and role drops are strict-blocked. A failed later routine definition rolls an in-place role alteration back to its original managed attributes. |
| grants and default privileges | 14–18 | not an SQLite feature | `src/test/postgres-grant-lifecycle.test.ts`, `src/test/postgres-default-privilege.test.ts` | only losslessly inspected privilege families are declarative; omissions revoke only managed grants |
| comments | 14–18 | not an SQLite feature | `src/test/comments.test.ts`, `src/test/postgres-comments-lossless.test.ts` | comment removal is destructive; unmodelled comment targets reject |
| extensions and foreign servers | 14–18 | not an SQLite feature | `src/test/extensions/`, `src/test/postgres-extension-dependencies.test.ts`, `src/test/postgres-foreign-server-lifecycle.test.ts` | database-wide extensions replan correctly even when the managed schema is non-`public`; dependency-aware `RESTRICT` removal; server type/wrapper changes and unsafe cascade operations reject |
| row-level security and policies | 14–18 | not an SQLite feature | `src/test/postgres-row-security.test.ts` | policy expressions are compared lexically safely; unmanaged policies are preserved |
| SQLite virtual tables: FTS5 and RTree | not applicable | 3.45.1 with required compile features | `src/test/sqlite/virtual-tables.test.ts`, `src/test/sqlite/runtime-contract.test.ts` | implementation-owned shadow tables stay unmanaged; unavailable runtime features fail the runtime contract |
| CLI plan/apply contract: JSON schema, deterministic ordering, categories, risk, exit/error behavior | 14–18 | 3.45.1 | `src/test/cli/cli-contract.test.ts`, `src/test/migration-executor-coverage.test.ts`, `src/test/properties/destructive-diff-classification.property.test.ts` | successful plan/apply JSON is byte-snapshotted through creation and empty re-plan; all advertised PostgreSQL object families retain a managed category and lexical-safe risk in ordered metadata; strict mode and error JSON are also contract-tested |
| CLI pull: generate a desired schema from an existing database, verified by re-planning it against that database before anything is written | 14–18 | 3.45.1 | `src/test/pull.test.ts`, `src/test/sqlite/pull.test.ts`, `src/test/cli/pull-cli.test.ts` | the pulled scope is exactly what an empty desired schema would reconcile; a file that would still plan changes fails with `PULL_VERIFICATION_ERROR` and is not written; existing files are replaced only with `--overwrite` |

## deliberate exclusions that fail safely

| excluded surface | rationale and behavior |
| --- | --- |
| another database engine or an unpinned SQLite runtime | outside the declared support contract; do not infer portability from shared SQL syntax |
| SQLite PostgreSQL-only objects (schemas, roles, grants, comments, extensions, server objects, PostgreSQL types/routines/materialized views/RLS) | unsupported by SQLite itself or outside TerraDB's SQLite model; parser/provider rejects instead of ignoring them |
| SQLite temporary/attached/external-database objects, top-level imperative SQL, and CTAS | they are connection-, external-file-, or data-state-dependent rather than persistent desired schema; reject before planning/mutation |
| PostgreSQL temporary objects, CTAS/`SELECT INTO`, `LIKE`/typed table shorthand, and untracked top-level commands | their copied/session/data state cannot be reconstructed declaratively; reject before mutation |
| PostgreSQL syntax not portable across 14–18, including virtual generated columns before 18, `MAINTAIN`, large-object default privileges, and advanced PostgreSQL 18 constraint forms | retained external state is preserved where it can be scoped; desired syntax rejects with an actionable version/model error |
| PostgreSQL DDL whose catalog state cannot be inspected losslessly, including unsafe server type/wrapper changes and unmodelled routine forms | fail before any mutation; never emulate with drop-and-recreate or `CASCADE` |

## audit procedure

For each row, prove a real lifecycle rather than merely a parser acceptance:

1. parse desired SQL and inspect the live catalog/runtime representation;
2. plan deterministic changes and classify destructive work;
3. apply against the relevant engine/version, then re-plan empty;
4. inject a failure and prove schema, data, dependent objects, settings, locks,
   and temporary artifacts are restored; and
5. add a focused regression/property test and update `docs/test-matrix.md` when
   the behavior changes.

Primary engine references: [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html), [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html), [SQLite CREATE TABLE](https://sqlite.org/lang_createtable.html), [SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html), and [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html).
