# terradb

Declarative schema management for PostgreSQL and SQLite.

## Install

```bash
npm install -g terradb
```

## Quick Start

### PostgreSQL

```sql
-- schema.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);
```

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
terradb plan -f schema.sql   # preview changes
terradb apply -f schema.sql  # apply changes
```

### SQLite

```sql
-- schema.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
```

```bash
export DATABASE_URL="sqlite:///absolute/path/to/database.db"
terradb plan -f schema.sql
terradb apply -f schema.sql
```

### Existing databases

```bash
terradb pull -f schema.sql   # write the current schema as CREATE statements
terradb plan -f schema.sql   # "No changes needed"
```

`pull` generates the desired schema for a database you already have, so you
can start managing it without hand-writing a file that exactly matches
production. Before anything is written, TerraDB parses the generated file and
plans it against the same database; if that plan is not empty, `pull` fails
with the remaining changes and writes nothing. A pulled file is therefore a
verified no-op baseline: applying it right away changes nothing.

The file contains exactly the objects that `plan` and `apply` manage, for the
same `--schema` scope and `--ignore-*` flags. Cluster-wide roles, grants
PostgreSQL creates implicitly, extension members, and undeclared foreign
servers stay out of it, just as they stay out of a plan. Canonical `serial`
expansions are written back as `SERIAL`, and options equal to PostgreSQL's
defaults are omitted so the file reads like hand-written DDL. Without `-f`,
the schema is printed to standard output; an existing file is replaced only
with `--overwrite`.

## How It Works

1. Write your desired schema as CREATE statements (or `terradb pull` them)
2. Run `terradb plan` to see what changes are needed
3. Run `terradb apply` to execute the changes

terradb compares your schema file against the current database state and generates the necessary ALTER/DROP/CREATE statements.

## Configuration

### PostgreSQL

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
```

PostgreSQL URLs may use either the `postgres://` or `postgresql://` scheme.
Percent-encode special characters in the user, password, database name, or
Unix-socket host. TerraDB preserves driver parameters such as
`application_name`, `connect_timeout`, `keepalives`, and TLS certificate paths.
The supported TLS modes follow `node-postgres`: `disable`, `prefer`, `require`,
`verify-ca`, `verify-full`, and `no-verify`; other values fail before a
connection is attempted. Multi-host libpq URLs are not supported by the driver,
so use a single load-balanced or failover endpoint.

Or individual variables:

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=mydb
export DB_USER=postgres
export DB_PASSWORD=password
```

### SQLite

```bash
export DATABASE_URL="sqlite:///absolute/path/to/database.db"
# or an absolute/relative filename
export DATABASE_URL="/path/to/database.db"
# or an official SQLite file URI (including supported URI parameters)
export DATABASE_URL="file:/path/to/database.db?mode=rwc"
# or in-memory
export DATABASE_URL=":memory:"
```

## Feature Support

| Feature | PostgreSQL | SQLite |
|---------|------------|--------|
| Tables & Columns | Yes | Yes |
| Generated Columns | Yes | Yes |
| Primary Keys | Yes | Yes |
| Foreign Keys | Yes | Yes |
| Indexes | Yes | Yes |
| Unique Constraints | Yes | Yes |
| Check Constraints | Yes | Yes |
| Views | Yes | Yes |
| ENUM Types | Yes | No |
| Composite Types | Yes | No |
| Domain Types | Yes | No |
| Range & Multirange Types | Yes | No |
| Sequences | Yes | No |
| Functions | Yes | No |
| Procedures | Yes | No |
| Triggers | Yes | Yes |
| Materialized Views | Yes | No |
| Schemas | Yes | No |
| Roles | Yes | No |
| Object Privileges (`GRANT`) | Yes | No |
| Object Comments (`COMMENT ON`) | Yes | No |
| Extensions | Yes | No |
| Row-Level Security & Policies | Yes | No |

PostgreSQL 14 through 18 are supported. Stored generated columns work across
that range; virtual generated columns are supported on PostgreSQL 18 and fail
before mutation on older servers.
PostgreSQL `smallserial`/`serial2`, `serial`/`serial4`, and
`bigserial`/`serial8` are supported when creating tables, adding whole columns,
retaining existing serial columns, and removing whole columns. The documented
aliases normalize to the same implicit `NOT NULL` serial definitions.
Existing-column transitions to or from a serial pseudo-type, or between serial
sizes, fail before mutation because PostgreSQL expands serial to an owned
sequence, a `nextval` default, and `NOT NULL` rather than a true type.
Use an identity column, add a new serial column, or migrate the column and its
sequence explicitly before managing the resulting schema with TerraDB.
Owned serial sequences must retain PostgreSQL's canonical start, increment,
minimum, maximum, cache, no-cycle, and version-appropriate persistence
definition. On PostgreSQL 15 and later, a serial sequence must have the same
logged or unlogged persistence as its owning table; PostgreSQL 14 retains its
logged serial-sequence behavior for unlogged tables. Definition drift fails
before mutation because a serial declaration cannot express those changes; use
an identity column or an explicit sequence when custom options are required.
Live counter values, including `ALTER SEQUENCE ... RESTART`, are runtime state
and do not cause schema drift.
Because serial already supplies `NOT NULL` and a sequence-backed default,
desired serial declarations with an explicit `NULL`, `DEFAULT`, identity, or
generated clause fail during parsing before any database mutation. An explicit
`NOT NULL` clause and ordinary key, check, unique, or reference constraints
remain compatible with serial.
Serial pseudo-types must also use scalar syntax without a type modifier, array
bounds, or `pg_catalog` qualification. Those forms fail during parsing instead
of being reinterpreted or reaching database execution. PostgreSQL's valid
quoted-lowercase `"serial"` spelling remains equivalent, while other
schema-qualified names ending in `serial` remain custom type references rather
than pseudo-types.
Catalog inspection preserves the schema identity of custom types named
`smallserial`, `serial2`, `serial`, `serial4`, `bigserial`, or `serial8`,
including their arrays and use in composite attributes, so those valid
schema-qualified types do not drift into integer pseudo-type semantics.
Catalog namespace identity is also retained whenever PostgreSQL renders another
visible custom type without its explicit schema. Explicitly qualified scalar
and array references therefore replan idempotently in ordinary and partitioned
table columns, composite attributes, domain base types, and range subtypes,
while a different schema or scalar/array shape remains a real type change.
PostgreSQL array size bounds and declared dimensionality are decorative rather
than distinct schema types. TerraDB normalizes `type[n]`, repeated bounded or
unbounded dimensions, and SQL-standard `type ARRAY[n]` to the element's single
catalog array type across columns, partitions, composites, domains, ranges,
functions, and procedures; stored array values retain their actual dimensions.
PostgreSQL's SQL-standard `float` precision aliases follow the documented binary
precision boundaries: `float(1)` through `float(24)` normalize to `real`, while
`float(25)` through `float(53)` and precision-less `float` normalize to `double
precision`. The boundary forms converge across columns, arrays, composite
attributes, domain bases, and range subtypes; precision outside `1` through `53`
fails during parsing before any preceding schema change is applied.
PostgreSQL `numeric`/`decimal` modifiers require precision from `1` through
`1000`. PostgreSQL 14 additionally requires scale from `0` through precision;
PostgreSQL 15–18 accept scale from `-1000` through `1000`, including negative
scale and scale above precision. TerraDB validates these version-specific bounds
before mutation across ordinary and partitioned columns, arrays, composite
attributes, and domain bases.
Numeric modifiers on range subtypes are rejected because PostgreSQL accepts but
does not retain the modifier in its range catalog; use an unconstrained numeric
subtype or a domain when the constraint must remain declarative.
PostgreSQL `time`, `timestamp`, and `interval` fractional precision is validated
from `0` through `6` before planning, preventing the server from silently
clamping larger values to 6. Zero remains explicit rather than becoming omitted,
and all documented `interval` field restrictions, from `YEAR` through `MINUTE TO
SECOND`, round-trip across ordinary and partitioned columns, bounded arrays,
composite attributes, and domain bases. Temporal modifiers on range subtypes are
rejected because PostgreSQL accepts but does not retain them in the range
catalog; use an unconstrained temporal subtype or a domain instead.
PostgreSQL character length modifiers are validated from `1` through
`10,485,760`, and bit-string lengths from `1` through `83,886,080`, across
ordinary and partitioned columns, arrays, composite attributes, and domain
bases. Constrained character and bit range subtypes fail before planning because
PostgreSQL drops their lengths from the range catalog. The internal one-byte
`"char"` type remains distinct from SQL `CHAR` across columns, arrays, domains,
ranges, functions, and procedures; unbounded `bpchar`, `varchar`, and `varbit`
also retain their separate catalog semantics.
PostgreSQL extensions are matched by their database-wide unqualified names,
including when their member objects are installed outside a managed schema.
`CASCADE` installation dependencies are inspected recursively so a required
extension is retained while its dependent remains desired. Removals run in
dependent-first order with `RESTRICT`; unmanaged dependent objects therefore
stop and roll back an apply instead of being deleted. `IF NOT EXISTS` is
normalized to declarative existence, while duplicate extension declarations
or options fail before mutation.
PostgreSQL table removal uses dependency-protected `RESTRICT` drops. TerraDB
removes managed dependent views and foreign keys first when their desired state
also removes those dependencies; an unmanaged view or foreign key blocks and
rolls back the apply instead of being deleted or stripped by `CASCADE`.
Partition hierarchy removal follows the same contract: managed triggers, views,
constraints, policies, and leaves are removed in dependency order before each
partitioned table is dropped with `RESTRICT`. Constraint drops are identified
from PostgreSQL's parsed statement structure, so keywords in quoted names or
literals cannot move unrelated table changes ahead of partition creation.
Declared foreign servers preserve
their type, version, foreign-data wrapper, and complete option map. Version and
option changes use native `ALTER SERVER`, preserving the server OID, user
mappings, foreign tables, and grants; unsupported type or wrapper changes fail
before mutation. `IF NOT EXISTS` and option order normalize declaratively, while
duplicates fail during parsing. A following `ALTER SERVER ... OWNER TO` with a
concrete role makes ownership declarative and repairs drift in place; contextual
session roles are rejected before mutation, while omitted ownership remains
unmanaged. Unrelated global foreign servers remain outside a managed-schema plan
unless declared by name. `DROP SERVER [IF EXISTS] name [RESTRICT]` is the
explicit, idempotent absent-state declaration for a database-wide server; it is
classified as destructive, respects strict mode, and rolls back without deleting
dependent mappings or foreign tables. `CASCADE` is rejected before mutation.
PostgreSQL roles and users share one database-cluster identity. TerraDB
normalizes `CREATE ROLE`, `CREATE USER`, and `CREATE GROUP` to complete role
state for login, superuser, database/role creation, inheritance, replication,
row-level-security bypass, and connection-limit attributes. Changes use native
`ALTER ROLE`, preserving OIDs, ownership, grants, memberships, passwords, and
role-local configuration. Password, expiration, membership, and `SYSID`
clauses are rejected in desired `CREATE ROLE` statements because they are
masked, separately modeled by PostgreSQL, or ignored. `DROP ROLE [IF EXISTS]`
is the explicit destructive absent-state declaration; PostgreSQL dependency
checks block it and roll back the transaction while the role still owns objects
or holds privileges. Undeclared cluster roles remain unmanaged.
PostgreSQL object privileges are declarative for concrete tables, sequences,
schemas, and foreign servers. TerraDB expands combined privilege, object, and
grantee lists into stable atomic grants, distinguishes `PUBLIC` from a quoted
role named `PUBLIC`, preserves PostgreSQL's implicit owner/default ACL entries,
and changes `WITH GRANT OPTION` natively. Omitting a managed grant emits a
destructive `REVOKE ... RESTRICT`, so strict mode can block it. Direct
`REVOKE`, role-membership grants, column privileges, `ALL`, expanding `ALL ...
IN SCHEMA`, contextual grantees, explicit grantors, and object families whose
ACLs are not inspected losslessly fail before mutation. Version-specific
privileges outside the PostgreSQL 14-18 portable contract, including
PostgreSQL 17-18 `MAINTAIN`, remain unmanaged and are preserved. A
foreign-server grant must declare the corresponding server so
omission remains scoped after the grant is removed from desired SQL. A grant
made by a non-owner grantor is rejected during inspection
because it cannot be revoked safely without managing grantor provenance.
The standard `public` schema's initdb state, `PUBLIC` usage (plus `CREATE` on
PostgreSQL 14) and its `standard public schema` comment, is treated like an
implicit default: it is reconciled only when the desired schema declares that
grant or comment, so a first apply to a fresh database never revokes access to
`public` or strips its stock comment.
PostgreSQL default privileges are declarative for explicitly named `FOR ROLE`
owners across tables, sequences, routines, types, and schemas. Global and
`IN SCHEMA` declarations expand to stable atomic privileges, preserve negative
hard-wired defaults such as revoking routine execution from `PUBLIC`, and
change grant options without temporarily removing access. The owner role and
any schema-specific target must be declared in the same desired schema so
omission has a stable scope. Omission restores PostgreSQL's hard-wired global
default or removes a per-schema addition; nested revocations are destructive
and respect strict mode. As PostgreSQL specifies, these settings affect only
objects created later. `ALL`, contextual owners or grantees, `CASCADE`,
grant-option-only revocations, PostgreSQL 17-18 `MAINTAIN`, and PostgreSQL 18
large-object defaults are rejected before mutation to keep one portable
PostgreSQL 14-18 contract.
PostgreSQL per-column planner metadata is declarative for ordinary and
inherited tables and materialized views: statistics targets, `n_distinct`, and
`n_distinct_inherited` are parsed, inspected, changed in place, and reset when
omitted. Statistics targets accept the documented `0` through `10000` range;
`DEFAULT` and `-1` normalize to the server default. Materialized views require
an explicit output-column list when declaring this metadata. PostgreSQL index
keys are modeled as one complete ordered sequence, including mixed column and
expression keys, multiple expression keys, per-key collation, operator class
and operator-class options, sort/null ordering, and expression statistics
targets. TerraDB reconstructs effective default operator classes from the
catalog without treating their omission from `pg_get_indexdef` as drift.
Statistics targets on partition indexes remain outside the managed partition
contract and fail before planning instead of being ignored.
PostgreSQL 18 `NOT ENFORCED` constraints, temporal constraints using `WITHOUT
OVERLAPS` or `PERIOD`, and named, table-level, `NO INHERIT`, or `NOT VALID`
`NOT NULL` forms are outside the current declarative constraint model. TerraDB
rejects those clauses while parsing desired schemas. During inspection it also
rejects `NOT ENFORCED`, temporal, and `NOT NULL NO INHERIT`/`NOT VALID` catalog
flags in managed external tables before diffing. An ordinary externally named
`NOT NULL` is normalized to column nullability because its name is not part of
the declarative model. Enforced `CHECK` and foreign-key constraints may still
be declared `NOT VALID`, and ordinary unnamed column `NOT NULL` remains fully
supported.

SQLite uses table recreation for schema changes that ALTER TABLE doesn't support (column type changes, constraint modifications, etc.).
TerraDB pins `libsql` 0.5.29, which embeds SQLite 3.45.1, so desired-schema parsing, inspection, and migration execution use one certified runtime. The runtime contract verifies the embedded version and the FTS5 and RTree compile features relied on by the supported virtual-table surface.
SQLite foreign-key enforcement timing is declarative. TerraDB recovers `DEFERRABLE INITIALLY DEFERRED` from the stored table definition, includes it in semantic comparison and recreation, and verifies its transaction behavior. SQLite treats every other accepted deferrability spelling as an immediate constraint, so TerraDB normalizes those spellings to the immediate default instead of rebuilding equivalent tables.
SQLite's historical primary-key nullability is also preserved. Primary-key columns in ordinary rowid tables remain nullable unless they are explicitly `NOT NULL` or use the exact `INTEGER PRIMARY KEY` ROWID alias; `STRICT` and `WITHOUT ROWID` tables make every primary-key column non-null. This includes SQLite's special distinction between inline `INTEGER PRIMARY KEY DESC`, which is not a ROWID alias, and table-level `PRIMARY KEY(id DESC)`, which is.
Declared SQLite type names remain distinct in the canonical schema, including `INT` versus `INTEGER`; this preserves ROWID-alias semantics while normalizing only insignificant case. Ordinary tables retain SQLite's ordered substring affinity rules, including `CHARINT` and `FLOATING POINT` as INTEGER affinity, `STRING` as NUMERIC affinity, typeless columns as BLOB affinity, and ignored size parameters such as `VARCHAR(2)`. `STRICT` tables accept only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, and `ANY`; invalid aliases fail during desired-schema parsing before the target is mutated. `ANY` retains SQLite's documented mode-dependent behavior: ordinary tables apply numeric affinity, while `STRICT` tables preserve the inserted storage class and value exactly. If a migration promotes a nullable key to an `INTEGER PRIMARY KEY` ROWID alias, TerraDB checks for existing NULL keys with a collision-safe transactional guard and rolls back instead of silently replacing them with generated integers.
Table recreation preserves hidden ROWID values and SQLite-specific definitions including `STRICT`, `WITHOUT ROWID`, `AUTOINCREMENT`, collations, named constraints, and `ON CONFLICT` policies. Migration row copies explicitly use `ABORT` semantics so declared `IGNORE` or `REPLACE` policies cannot silently drop duplicate rows or rewrite NULL values; the transaction rolls back with the original schema and rows intact when existing data violates the desired constraints. Recreation also validates foreign keys and database integrity before commit, enforces CHECK constraints during migration even when the caller disabled enforcement, and disables `writable_schema` so ALTER operations cannot silently ignore malformed schema entries. It then restores the caller's `foreign_keys`, `defer_foreign_keys`, `ignore_check_constraints`, and `writable_schema` settings. Recreation fails before mutation when declared columns shadow every SQL-visible ROWID name and exact row identity cannot be transferred safely.
SQLite virtual tables are managed losslessly; bundled FTS5 and RTree modules are covered, while their implementation-owned shadow tables are never managed as user tables.
SQLite desired schemas accept unconditional top-level `CREATE` statements and manage the persistent `main` database only. `IF NOT EXISTS` is rejected for managed tables, virtual tables, indexes, views, and triggers because SQLite otherwise turns a duplicate or racing conflicting definition into a silent no-op. Imperative SQL, connection-local temporary objects, and external-database statements are rejected before migration planning; DML inside trigger bodies remains supported.
SQLite query-derived tables created with `CREATE TABLE ... AS SELECT` (including
`VALUES` and CTE forms) are also rejected before target mutation. Those
statements combine a synthesized table definition with initial query rows,
which cannot be represented by TerraDB's declarative schema model; define the
columns explicitly and load data separately.
PostgreSQL desired schemas also describe persistent database state. Session-local temporary tables, views, and sequences are rejected before migration planning instead of being converted into persistent objects. Query-derived tables created with `CREATE TABLE AS` or `SELECT INTO` are also rejected because their structure and optional initial data cannot be reconciled declaratively; define their table structure explicitly and load data separately. `CREATE TABLE LIKE` and typed `CREATE TABLE OF` declarations must likewise be expanded to explicit columns and constraints so copied options or persistent type dependencies are never discarded. Other top-level data, query, session, transaction, maintenance, and untracked DDL commands fail explicitly instead of being silently ignored; SQL inside managed routine bodies remains supported.
PostgreSQL schema declarations preserve a concrete `AUTHORIZATION` owner,
including `CREATE SCHEMA AUTHORIZATION role` where the role also supplies the
schema name. Owner drift is repaired with `ALTER SCHEMA ... OWNER TO`.
`IF NOT EXISTS` is normalized to declarative existence rather than retained as
a conditional migration no-op. Contextual owners (`CURRENT_ROLE`,
`CURRENT_USER`, and `SESSION_USER`), duplicate schema declarations, and inline
schema elements fail before planning; use a concrete role and separate,
schema-qualified `CREATE` statements.
PostgreSQL view queries are compared through their parsed syntax trees. Local
schema qualification, redundant single-source column qualification, identifier
quoting, comments, formatting, and redundant parentheses normalize without
rewriting string or dollar-quoted literal values. Literal whitespace and text
that resembles a schema or table qualifier therefore remain semantic and cause
the view query to be replaced.
PostgreSQL object comments are declarative for schemas, ordinary and partitioned
tables, table/view/materialized-view/composite columns, ordinary and
materialized views, indexes, sequences, and user-defined types including enums,
composites, domains, ranges, and multiranges. Remove a `COMMENT ON` statement to
remove the stored comment. Explicit `IS NULL` or empty-string removals,
duplicate declarations, and targets whose identity is not yet modeled—such as
routines, constraints, policies, and triggers—fail before migration planning
instead of being silently ignored.
PostgreSQL sequences preserve type, bounds, start, increment, cache, cycling,
column ownership, and logged/unlogged persistence. Existing sequences evolve
with native `ALTER SEQUENCE` operations so their OIDs, dependents, and live
counter state are not reset. Creation and ownership detachment run before
dependent table changes, while ownership attachment and safe sequence removal
run afterward; quoted identifiers containing ownership keywords cannot alter
that ordering. `UNLOGGED` standalone sequences and explicit
identity-sequence `LOGGED`/`UNLOGGED` overrides are supported on PostgreSQL
15–18 and rejected before mutation on PostgreSQL 14. An implicit identity
sequence follows its table's persistence on PostgreSQL 15–18; PostgreSQL 14's
version-specific logged identity-sequence behavior is preserved.
PostgreSQL triggers preserve `UPDATE OF` column lists, `OLD TABLE`/`NEW TABLE`
transition names, `WHEN` expressions, function arguments, and origin, disabled,
replica-only, or always firing modes. Named `ALTER TABLE ... TRIGGER` and
`ALTER EVENT TRIGGER` firing modes are declarative and use native alterations;
bulk `ALL`/`USER` mutations and `ALTER TABLE ONLY` mode changes are rejected.
SQL comparison normalizes structural `EXECUTE PROCEDURE` to `EXECUTE FUNCTION`
without rewriting quoted trigger arguments, so argument whitespace and keyword
text remain exact.
Partition-created trigger clones are managed through their parent trigger, and
externally diverged clone modes stop planning instead of being ignored.
PostgreSQL replica identity is declarative through `ALTER TABLE ... REPLICA
IDENTITY DEFAULT`, `FULL`, `NOTHING`, or `USING INDEX`. Omitting the clause is
the canonical `DEFAULT` state. TerraDB inspects both `pg_class.relreplident`
and the selected `pg_index.indisreplident` index, repairs catalog state left
behind when a selected index is dropped, and resets identity before replacing
or renaming a selected index. `USING INDEX` is validated before mutation: the
target must be a unique, non-partial, immediate, column-only index whose key
columns are `NOT NULL`; nullable `INCLUDE` payload columns remain valid.
Standalone indexes on existing tables may be built or dropped concurrently only
as one-statement migrations. A desired schema that combines concurrent work
with another change is rejected before mutation, and a failed concurrent create
removes its invalid PostgreSQL index artifact. A `CONCURRENTLY` declaration on
a newly created table is created transactionally because it has no concurrent
writer to protect, together with dependent `REPLICA IDENTITY` or `CLUSTER`
assignments. Generated index removals that share other work are likewise
transactional; only an otherwise standalone removal retains `CONCURRENTLY`.
Constraint-backed index changes and assignments remain atomic in the main transaction. Replica
identity is tracked independently for ordinary tables, partitioned parents,
and leaf partitions because PostgreSQL does not propagate it through a
partition hierarchy. Within the supported partition contract, `USING INDEX`
targets a named primary-key or unique constraint on the partitioned relation.
PostgreSQL's persistent clustering choice is declarative through `ALTER TABLE
... CLUSTER ON` and `ALTER MATERIALIZED VIEW ... CLUSTER ON`; omission or
`SET WITHOUT CLUSTER` is the canonical unselected state. TerraDB inspects
`pg_index.indisclustered`, validates that the selected index is declared,
non-partial, and uses a built-in clusterable access method (`btree` or `gist`),
and restores the choice after index replacement. Standalone index assignments
require their concurrent build to have been applied in a prior migration, while
constraint-backed table indexes and materialized-view indexes remain
transactional. Expression-backed
exclusion constraints must be explicitly named when selected because
PostgreSQL-generated constraint names are not a declarative contract. The choice is
relation-local for inheritance hierarchies. Partition clustering is rejected
because partition indexes are outside TerraDB's independently managed
partition contract, and physical `CLUSTER` is rejected as an imperative,
locking maintenance operation rather than executed during schema apply.
PostgreSQL row-level security is declared with positive `ALTER TABLE ... ENABLE
ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` state plus complete `CREATE
POLICY` definitions. TerraDB preserves policy command, permissive/restrictive
mode, named and contextual roles, `PUBLIC`, `USING`, and `WITH CHECK`, and
compares catalog-added casts and implicit checks semantically. Combined RLS
clauses are tracked as independent flags and may share an `ALTER TABLE` with
supported foreign-key or check additions. Policy changes use transactional
drop/create replacement; omitting a policy or positive RLS flag removes it.
`ALTER POLICY`, `DISABLE ROW LEVEL SECURITY`, and `NO FORCE ROW LEVEL SECURITY`
are imperative partial mutations and are rejected in desired schemas before
database mutation.
PostgreSQL expression comparison is token-safe. Formatting whitespace and
comments outside tokens normalize through PostgreSQL syntax trees, while
whitespace inside ordinary, escape, dollar-quoted, and identifier literals
remains semantic. This applies to table and domain checks, domain defaults,
generated columns, expression and partial indexes, policies, partition
expressions, and other managed expression fields. If an expression cannot be
parsed for semantic comparison, TerraDB treats unequal text as drift instead
of guessing that it is equivalent.
Ordinary PostgreSQL `UNLOGGED` tables are lifecycle-supported. `UNLOGGED`
partitioned parents and explicit unlogged leaf partitions are rejected before
planning: PostgreSQL 18 disallows unlogged partitioned parents, while earlier
versions do not propagate parent persistence consistently and TerraDB does not
model mixed-persistence partition hierarchies. Equivalent external catalog
state on PostgreSQL 14–17 is also rejected before diffing.
PostgreSQL partition definitions are compared through PostgreSQL's parsed
representation and TerraDB's semantic column model, so equivalent identifier
quoting, type aliases, formatting, implicit `public` qualification, catalog
collation qualification, default-expression casts, identity-sequence expansion,
and explicit `NULL` converge after inspection. Partition keys also normalize
`pg_catalog` qualification, same-type casts simplified by PostgreSQL, and
effective default or non-default operator classes without hiding meaningful key
changes. A change only
to a leaf partition bound uses transactional `DETACH PARTITION` and `ATTACH
PARTITION` statements, preserving the partition table and its rows. If the new
bound rejects existing rows, the transaction rolls back to the prior attached
partition and bound. Other in-place partition-definition replacements fail
before execution instead of dropping and recreating a potentially populated
partition hierarchy.
Leaf partition bounds support canonical uncast literal values, `NULL`,
`MINVALUE`/`MAXVALUE`, hash modulus/remainder bounds, and `DEFAULT`. Explicit
casts and other evaluated bound expressions are rejected before mutation because
PostgreSQL stores only their one-time result, so the original expression cannot
be inspected or reconciled declaratively.
The supported partition contract is a basic partitioned parent with explicitly
named table-level key/check constraints and direct `CREATE TABLE ... PARTITION
OF` leaves. Parent foreign keys, unnamed or inline key/check/reference
constraints, `IF NOT EXISTS`, subpartitions, leaf column overrides or local
constraints, foreign-table partitions, partition access methods, storage
parameters, tablespaces, and parent column `STORAGE` or `COMPRESSION` settings
are rejected before mutation because TerraDB cannot yet inspect and order them
losslessly. Legacy `serial` pseudo-types are also rejected on partitioned parents;
use an identity column so sequence semantics remain declarative. Imperative
`ALTER TABLE ... ATTACH/DETACH PARTITION` commands are
also rejected in desired schemas; add or remove the declarative leaf instead.
Equivalent unsupported state created outside TerraDB is detected from the
PostgreSQL catalogs and rejected before diffing.
PostgreSQL enums preserve empty, quoted, backslash, and Unicode labels, including
valid zero-label enum types. TerraDB can add labels at any position while
preserving the relative order of existing labels. Removing or reordering
existing labels is rejected before execution because PostgreSQL has no safe
in-place operation for those changes. Enum additions are committed in a
standalone pre-transactional migration: a desired schema that combines a new
label with any other change is rejected before mutation. Apply the enum-only
change first, then apply the dependent schema change. This prevents a later
failure from leaving a committed label behind. JSON plan/apply output schema
version 2 exposes this phase through `counts.preTransactional`,
`statements.preTransactional`, and the `pre-transactional` metadata channel.
Enum removal inspects direct and array relation attributes, composite
attributes, derived domains and ranges, function/procedure signatures, and
owning defaults, constraints, and indexes.
Retained managed or unmanaged dependents fail during planning with their exact
identity, while coordinated column, routine, derived-type, and enum removal is
ordered in one apply. Index dependency columns come from PostgreSQL's catalogs,
so a column drop neither double-drops an index nor prevents a replacement index
from being created. Unmodeled catalog dependents such as casts are also reported
before mutation and must be removed explicitly first.
Domains, ranges, and composite types use the same catalog dependency safety.
TerraDB reports retained routine signatures, policies, triggers, casts, and
relation-owned expressions before replacement or removal. Managed policies and
triggers can be removed with their type in one apply; ownerless or unmanaged
dependents must be migrated explicitly.
PostgreSQL composite types preserve zero-attribute definitions, attribute order,
quoted names, schema-qualified types, arrays, typemods, and explicit collations.
TerraDB dependency-orders composite creation and removal, and uses native
transactional `ALTER TYPE` operations for positional renames, type or collation
changes, appended attributes, and attribute drops. PostgreSQL cannot insert a
new composite attribute before an existing one, so that transition and existing
attribute reordering fail before mutation. Attribute drops are destructive and
are blocked by `--strict`. PostgreSQL also refuses attribute type or collation
changes while relation columns depend on the type, including dependencies
through arrays, domains, ranges, and multiranges; TerraDB detects and reports
those columns during planning so they can be migrated first. Type removal
likewise protects retained managed and unmanaged relations, domains, and ranges
while still ordering their coordinated removal in one apply.
PostgreSQL domains preserve base types, typemods, arrays, collations, defaults,
nullability, named and generated check constraints, and validation state.
TerraDB uses native transactional `ALTER DOMAIN` statements for defaults,
nullability, constraint add/drop/rename, and validation, preserving stored rows
and rolling the whole change back if existing data violates a new constraint.
PostgreSQL cannot add or validate a domain constraint or set domain `NOT NULL`
when that domain (or a derived domain) is stored inside an array, composite, or
range column; TerraDB detects that catalog state and rejects the change during
planning with a container-migration diagnostic. Non-validating changes such as
setting or dropping a domain default remain supported for container domains;
TerraDB classifies the operation structurally, so keywords in quoted names do
not trigger the validation restriction.
Changing a domain's base type or collation, or changing between domain and range
families, requires replacement and is therefore allowed only while no relation,
derived type, or routine signature depends on it. Domain removal is
dependency-ordered and always uses `RESTRICT`, never `CASCADE`.
PostgreSQL ranges preserve subtype, effective default or explicit operator
class, collation, canonical and subtype-difference functions, and automatic or
explicit multirange names. Range definition options are immutable in PostgreSQL,
so TerraDB replaces an unused range in drop-before-create order and rejects the
change during planning when direct, array, multirange, derived-type, relation,
or routine dependents exist. Support functions referenced while creating a
range must already exist; declaring a new support function and its range in the
same apply fails before mutation with instructions to apply the prerequisite
first (canonical functions additionally require PostgreSQL's shell-type
workflow). Range and multirange removal also uses dependency-ordered
`RESTRICT` drops.
Enums, composites, domains, ranges, and generated multiranges share one
schema-qualified dependency graph. TerraDB therefore orders same-apply type
creation and composite alteration from referenced type to dependent type,
orders coordinated removal in reverse, and rejects cross-family cycles,
ambiguous references, and generated-name collisions before mutation.

## Commands

```bash
terradb plan -f schema.sql      # Preview changes
terradb plan -f custom.sql      # Use custom schema file
terradb apply -f schema.sql     # Apply changes
terradb apply -f custom.sql     # Apply from custom file
terradb plan -f schema.sql --format json
terradb apply -f schema.sql --dry-run --format json
terradb apply -f schema.sql --no-color
terradb pull                     # Print the current schema
terradb pull -f schema.sql       # Write it to a file (--overwrite to replace)
terradb pull -s app --format json
```

## Examples

### Constraints

```sql
-- Primary keys
id SERIAL PRIMARY KEY           -- PostgreSQL
id INTEGER PRIMARY KEY          -- SQLite

-- Foreign keys
CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE

-- Check constraints
CONSTRAINT check_positive CHECK (quantity > 0)

-- Unique constraints
CONSTRAINT unique_email UNIQUE (email)
```

### Indexes

```sql
CREATE INDEX idx_email ON users (email);
CREATE INDEX idx_active ON users (email) WHERE active = true;  -- partial index
CREATE UNIQUE INDEX idx_unique_email ON users (email);
CREATE INDEX idx_email_bytewise ON users (email COLLATE "C");  -- PostgreSQL
CREATE INDEX idx_search ON users (
  email COLLATE "C" text_pattern_ops DESC NULLS LAST,
  (lower(email)) ASC,
  (length(email)) DESC
);  -- ordered mixed PostgreSQL keys

-- PostgreSQL planner statistics metadata
ALTER TABLE ONLY users
  ALTER COLUMN email SET STATISTICS 500,
  ALTER COLUMN email SET (n_distinct=-0.5);
CREATE INDEX idx_normalized_email ON users ((lower(email)));
ALTER INDEX idx_normalized_email ALTER COLUMN 1 SET STATISTICS 750;
ALTER INDEX idx_search ALTER COLUMN 2 SET STATISTICS 500;
ALTER INDEX idx_search ALTER COLUMN 3 SET STATISTICS 1000;
```

### PostgreSQL-only Features

```sql
-- ENUM types
CREATE TYPE status AS ENUM ('pending', 'active', 'inactive');
-- Adding a label between existing labels is supported on a later apply:
CREATE TYPE status AS ENUM ('pending', 'in_review', 'active', 'inactive');

-- Composite types
CREATE TYPE address AS (
  street text,
  city text COLLATE "C"
);

-- Views
CREATE VIEW active_users AS SELECT * FROM users WHERE active = true;
CREATE MATERIALIZED VIEW user_stats AS SELECT COUNT(*) FROM users;

-- Functions
CREATE FUNCTION add(a INT, b INT) RETURNS INT AS $$ SELECT a + b $$ LANGUAGE SQL;

-- Sequences
CREATE SEQUENCE custom_seq START 1000 INCREMENT 1;
```

## Development

Requires [Bun](https://bun.sh) 1.4 or newer. Test scripts run files with
`bun test --parallel`; each worker gets its own database on the configured
server (`<database>_w<worker>`), and `tools/test-timings.json` balances
workers and CI shards (refresh it with `bun run test:timings:update`).

```bash
git clone https://github.com/elitan/terradb.git
cd terradb
bun install

# check local test env
bun run test:doctor

# PostgreSQL tests
docker compose up -d
bun run test:pg:18

# PostgreSQL matrix
bun run test:pg:14
bun run test:pg:15
bun run test:pg:16
bun run test:pg:17
bun run test:pg:18

# Extension tests
bun run test:pg:extensions

# SQLite tests (no docker needed)
bun run test:sqlite

# full PR matrix
bun run test:matrix:pr
```

Testing docs:

- `docs/testing-roadmap.md`
- `docs/test-matrix.md`
- `docs/pg-version-variance.md`

## License

MIT
