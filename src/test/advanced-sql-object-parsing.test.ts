import { describe, expect, test } from "bun:test";
import { SchemaParser } from "../core/schema/parser";
import { hasEmptyForeignServerClause } from "../core/schema/parser/schema-parser";
import {
  parseForeignServerRemovals,
} from "../core/schema/parser/foreign-server-removal-parser";
import { parsePostgresRole } from "../core/schema/parser/role-parser";
import {
  parsePostgresRoleRemovals,
} from "../core/schema/parser/role-removal-parser";
import {
  parsePostgresDefaultPrivileges,
} from "../core/schema/parser/default-privilege-parser";

describe("Advanced SQL object parsing", function () {
  test("expands supported object grants into atomic canonical privileges", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      GRANT SELECT, INSERT ON TABLE public.accounts, public.users
        TO reader, PUBLIC;
    `);
    const grants = parsed.sqlObjects?.filter(function isGrant(object) {
      return object.kind === "grant";
    });

    expect(grants).toHaveLength(8);
    expect(grants?.map(function getStatement(object) {
      return object.createStatement;
    })).toEqual([
      'GRANT INSERT ON TABLE "public"."accounts" TO "reader";',
      'GRANT INSERT ON TABLE "public"."accounts" TO PUBLIC;',
      'GRANT INSERT ON TABLE "public"."users" TO "reader";',
      'GRANT INSERT ON TABLE "public"."users" TO PUBLIC;',
      'GRANT SELECT ON TABLE "public"."accounts" TO "reader";',
      'GRANT SELECT ON TABLE "public"."accounts" TO PUBLIC;',
      'GRANT SELECT ON TABLE "public"."users" TO "reader";',
      'GRANT SELECT ON TABLE "public"."users" TO PUBLIC;',
    ]);
    expect(grants?.[0]).toMatchObject({
      key:
        'grant:GRANT INSERT ON TABLE "public"."accounts" TO "reader";',
      schema: "public",
      grantDefinition: {
        objectType: "TABLE",
        objectName: "accounts",
        schema: "public",
        grantee: "reader",
        granteeIsPublic: false,
        privilege: "INSERT",
        grantable: false,
        implicitDefault: false,
      },
    });
  });

  test("distinguishes PUBLIC from a quoted role named PUBLIC", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      GRANT SELECT ON TABLE public.accounts TO PUBLIC, "PUBLIC";
    `);

    expect(parsed.sqlObjects?.map(function getStatement(object) {
      return object.createStatement;
    })).toEqual([
      'GRANT SELECT ON TABLE "public"."accounts" TO "PUBLIC";',
      'GRANT SELECT ON TABLE "public"."accounts" TO PUBLIC;',
    ]);
    expect(parsed.sqlObjects?.map(function getPublicKind(object) {
      return object.grantDefinition?.granteeIsPublic;
    })).toEqual([false, true]);

    const quotedGrantOption = await parser.parseSchema(`
      GRANT SELECT ON TABLE public.accounts TO "PUBLIC" WITH GRANT OPTION;
    `);
    expect(quotedGrantOption.sqlObjects?.[0].createStatement).toBe(
      'GRANT SELECT ON TABLE "public"."accounts" TO "PUBLIC" WITH GRANT OPTION;'
    );
  });

  test("rejects duplicate atomic privilege declarations", async function () {
    const parser = new SchemaParser();
    await expect(parser.parseSchema(`
      GRANT SELECT ON TABLE public.accounts TO reader;
      GRANT SELECT ON TABLE public.accounts TO reader WITH GRANT OPTION;
    `)).rejects.toThrow(/privilege grant.*declared more than once/i);
  });

  test("requires foreign server grants to have a managed target", async function () {
    const parser = new SchemaParser();
    await expect(parser.parseSchema(`
      GRANT USAGE ON FOREIGN SERVER analytics TO reader;
    `)).rejects.toThrow(/must also declare.*CREATE SERVER/i);
    await expect(parser.parseSchema(`
      DROP SERVER analytics;
      GRANT USAGE ON FOREIGN SERVER analytics TO reader;
    `)).rejects.toThrow(/must also declare.*CREATE SERVER/i);
  });

  test("rejects privilege syntax outside the lossless grant contract", async function () {
    const parser = new SchemaParser();
    const unsupported = [
      "REVOKE SELECT ON TABLE public.accounts FROM reader;",
      "GRANT SELECT (id) ON TABLE public.accounts TO reader;",
      "GRANT ALL ON TABLE public.accounts TO reader;",
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader;",
      "GRANT EXECUTE ON FUNCTION public.work(integer) TO reader;",
      "GRANT USAGE ON TYPE public.payload TO reader;",
      "GRANT SELECT ON TABLE public.accounts TO CURRENT_USER;",
      "GRANT SELECT ON TABLE public.accounts TO reader GRANTED BY CURRENT_USER;",
      "GRANT SELECT ON TABLE public.accounts TO PUBLIC WITH GRANT OPTION;",
    ];

    for (const sql of unsupported) {
      await expect(parser.parseSchema(sql)).rejects.toMatchObject({
        code: "PARSER_ERROR",
        message: expect.stringContaining("not supported in desired schemas"),
      });
    }
  });

  test("expands PostgreSQL default privileges into atomic desired state", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE ROLE owner_a;
      CREATE ROLE owner_b;
      CREATE SCHEMA app;
      CREATE SCHEMA audit;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner_a, owner_b
        IN SCHEMA app, audit
        GRANT SELECT, INSERT ON TABLES TO reader, PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner_a
        REVOKE EXECUTE ON ROUTINES FROM PUBLIC RESTRICT;
    `);
    const defaults = parsed.sqlObjects?.filter(function isDefault(object) {
      return object.kind === "default-privilege";
    });

    expect(defaults).toHaveLength(17);
    expect(defaults?.find(function isGlobalRevoke(object) {
      return object.defaultPrivilegeDefinition?.objectType === "ROUTINES";
    })).toMatchObject({
      createStatement:
        'ALTER DEFAULT PRIVILEGES FOR ROLE "owner_a" REVOKE EXECUTE ON ROUTINES FROM PUBLIC RESTRICT;',
      defaultPrivilegeDefinition: {
        owner: "owner_a",
        objectType: "ROUTINES",
        grantee: "PUBLIC",
        granteeIsPublic: true,
        privilege: "EXECUTE",
        granted: false,
        grantable: false,
        baselineGranted: true,
      },
    });
    expect(defaults?.find(function isSchemaGrant(object) {
      const definition = object.defaultPrivilegeDefinition;
      return definition?.owner === "owner_b" &&
        definition.schema === "audit" &&
        definition.grantee === "reader" &&
        definition.privilege === "SELECT";
    })).toMatchObject({
      createStatement:
        'ALTER DEFAULT PRIVILEGES FOR ROLE "owner_b" IN SCHEMA "audit" GRANT SELECT ON TABLES TO "reader";',
      defaultPrivilegeDefinition: {
        baselineGranted: false,
        granted: true,
      },
    });
  });

  test("distinguishes PUBLIC from a quoted default-privilege role", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE ROLE owner;
      CREATE ROLE "PUBLIC";
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO PUBLIC, "PUBLIC";
    `);
    const defaults = parsed.sqlObjects?.filter(function isDefault(object) {
      return object.kind === "default-privilege";
    });

    expect(defaults).toHaveLength(2);
    expect(defaults?.map(function getGrantee(object) {
      const definition = object.defaultPrivilegeDefinition;
      return {
        grantee: definition?.grantee,
        isPublic: definition?.granteeIsPublic,
      };
    })).toEqual([
      { grantee: "PUBLIC", isPublic: false },
      { grantee: "PUBLIC", isPublic: true },
    ]);
  });

  test("rejects duplicate default privileges and absent owners", async function () {
    const parser = new SchemaParser();
    await expect(parser.parseSchema(`
      CREATE ROLE owner;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO reader;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO reader;
    `)).rejects.toThrow(/default privilege.*declared more than once/i);

    await expect(parser.parseSchema(`
      DROP ROLE IF EXISTS owner;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO reader;
    `)).rejects.toThrow(/must also declare.*CREATE ROLE/i);
  });

  test("rejects default privilege syntax outside the portable contract", async function () {
    const parser = new SchemaParser();
    const unsupported = [
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner GRANT ALL ON TABLES TO reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner GRANT MAINTAIN ON TABLES TO reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner GRANT SELECT ON LARGE OBJECTS TO reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner REVOKE GRANT OPTION FOR SELECT ON TABLES FROM reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner REVOKE SELECT ON TABLES FROM reader CASCADE;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT SELECT ON TABLES TO reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA app GRANT USAGE ON SCHEMAS TO reader;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner GRANT SELECT ON TABLES TO PUBLIC WITH GRANT OPTION;",
    ];

    for (const sql of unsupported) {
      await expect(parser.parseSchema(sql)).rejects.toMatchObject({
        code: "PARSER_ERROR",
      });
    }
    await expect(parser.parseSchema(`
      CREATE ROLE owner;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        IN SCHEMA app GRANT SELECT ON TABLES TO reader;
    `)).rejects.toThrow(/must also declare.*CREATE SCHEMA/i);
    await expect(parser.parseSchema(`
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO reader;
    `)).rejects.toThrow(/must also declare.*CREATE ROLE/i);
    await expect(parser.parseSchema(`
      CREATE ROLE owner;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        REVOKE GRANT OPTION FOR SELECT ON TABLES FROM reader;
    `)).rejects.toThrow(/imperative partial default-privilege mutation/i);
    await expect(parser.parseSchema(`
      CREATE ROLE owner;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO PUBLIC WITH GRANT OPTION;
    `)).rejects.toThrow(/grant option for PUBLIC is not supported/i);
  });

  test("preserves default privilege grant options in canonical state", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE ROLE owner;
      ALTER DEFAULT PRIVILEGES FOR ROLE owner
        GRANT SELECT ON TABLES TO reader WITH GRANT OPTION;
    `);
    const privilege = parsed.sqlObjects?.find(function isDefault(object) {
      return object.kind === "default-privilege";
    });

    expect(privilege).toMatchObject({
      createStatement:
        'ALTER DEFAULT PRIVILEGES FOR ROLE "owner" ' +
        'GRANT SELECT ON TABLES TO "reader" WITH GRANT OPTION;',
      defaultPrivilegeDefinition: {
        granted: true,
        grantable: true,
      },
    });
  });

  test("rejects malformed default privilege AST defensively", function () {
    const roleOption = {
      DefElem: {
        defname: "roles",
        arg: {
          List: {
            items: [{
              RoleSpec: {
                roletype: "ROLESPEC_CSTRING",
                rolename: "owner",
              },
            }],
          },
        },
      },
    };
    const action = {
      targtype: "ACL_TARGET_DEFAULTS",
      objtype: "OBJECT_TABLE",
      is_grant: true,
      privileges: [{ AccessPriv: { priv_name: "select" } }],
      grantees: [{
        RoleSpec: {
          roletype: "ROLESPEC_CSTRING",
          rolename: "reader",
        },
      }],
    };
    const malformed = [
      { options: [roleOption] },
      { options: [{}], action },
      { options: [roleOption, roleOption], action },
      {
        options: [{
          DefElem: {
            defname: "roles",
            arg: { List: { items: [] } },
          },
        }],
        action,
      },
      {
        options: [
          roleOption,
          {
            DefElem: {
              defname: "schemas",
              arg: { List: { items: [{}] } },
            },
          },
        ],
        action,
      },
      {
        options: [{
          DefElem: {
            defname: "unexpected",
            arg: { List: { items: [{ String: { sval: "value" } }] } },
          },
        }],
        action,
      },
      {
        options: [roleOption],
        action: { ...action, grantees: [] },
      },
      {
        options: [roleOption],
        action: {
          ...action,
          grantees: [{
            RoleSpec: { roletype: "ROLESPEC_CURRENT_USER" },
          }],
        },
      },
    ];

    for (const node of malformed) {
      expect(function parseMalformedDefaultPrivilege() {
        parsePostgresDefaultPrivileges(node, "malformed-default.sql");
      }).toThrow();
    }
  });

  test("normalizes ROLE and USER aliases to complete role state", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE ROLE plain;
      CREATE USER "No Login User" NOLOGIN CREATEDB NOINHERIT
        CONNECTION LIMIT 4;
      CREATE ROLE "Login Role" LOGIN CREATEROLE;
    `);

    expect(parsed.sqlObjects).toMatchObject([
      {
        kind: "role",
        key: "role:plain",
        roleDefinition: {
          login: false,
          superuser: false,
          createDatabase: false,
          createRole: false,
          inherit: true,
          replication: false,
          bypassRowLevelSecurity: false,
          connectionLimit: -1,
        },
      },
      {
        kind: "role",
        key: "role:No Login User",
        roleDefinition: {
          login: false,
          superuser: false,
          createDatabase: true,
          createRole: false,
          inherit: false,
          replication: false,
          bypassRowLevelSecurity: false,
          connectionLimit: 4,
        },
      },
      {
        kind: "role",
        key: "role:Login Role",
        roleDefinition: {
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: true,
          inherit: true,
          replication: false,
          bypassRowLevelSecurity: false,
          connectionLimit: -1,
        },
      },
    ]);
    expect(parsed.sqlObjects?.[0]?.createStatement).toBe(
      'CREATE ROLE "plain" WITH NOLOGIN NOSUPERUSER NOCREATEDB ' +
        'NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;'
    );
  });

  test("rejects role state that cannot be inspected losslessly", async function () {
    const parser = new SchemaParser();
    const unsupported = [
      "CREATE ROLE app PASSWORD 'secret';",
      "CREATE ROLE app PASSWORD NULL;",
      "CREATE ROLE app VALID UNTIL 'infinity';",
      "CREATE ROLE app IN ROLE parent;",
      "CREATE ROLE app ROLE member;",
      "CREATE ROLE app ADMIN member;",
      "CREATE ROLE app SYSID 42;",
    ];

    for (const sql of unsupported) {
      await expect(parser.parseSchema(sql)).rejects.toMatchObject({
        code: "PARSER_ERROR",
        message: expect.stringContaining("not supported in desired schemas"),
      });
    }
    await expect(
      parser.parseSchema("CREATE ROLE app LOGIN NOLOGIN;")
    ).rejects.toThrow(/attribute.*canlogin.*more than once/i);
    await expect(
      parser.parseSchema("CREATE ROLE app CONNECTION LIMIT -2;")
    ).rejects.toThrow(/connection limit.*-1 or greater/i);
    await expect(
      parser.parseSchema("CREATE ROLE duplicate; CREATE USER duplicate;")
    ).rejects.toThrow(/role.*declared more than once/i);
  });

  test("rejects malformed role parser state defensively", function () {
    expect(parsePostgresRole({ CreateRoleStmt: {} })).toBeNull();
    expect(parsePostgresRole({
      CreateRoleStmt: { role: "legacy_group", stmt_type: "ROLESTMT_GROUP" },
    })).toMatchObject({
      kind: "role",
      key: "role:legacy_group",
      roleDefinition: { login: false },
    });
    expect(function parseUnknownCreationForm() {
      parsePostgresRole({
        CreateRoleStmt: { role: "app", stmt_type: "ROLESTMT_UNKNOWN" },
      });
    }).toThrow(/unsupported creation form/i);
    expect(function parseMalformedOption() {
      parsePostgresRole({
        CreateRoleStmt: {
          role: "app",
          stmt_type: "ROLESTMT_ROLE",
          options: [{}],
        },
      });
    }).toThrow(/malformed option/i);
    expect(function parseMalformedBoolean() {
      parsePostgresRole({
        CreateRoleStmt: {
          role: "app",
          stmt_type: "ROLESTMT_ROLE",
          options: [{ DefElem: { defname: "canlogin", arg: {} } }],
        },
      });
    }).toThrow(/option.*canlogin.*not supported/i);
    expect(function parseMalformedLimit() {
      parsePostgresRole({
        CreateRoleStmt: {
          role: "app",
          stmt_type: "ROLESTMT_ROLE",
          options: [{ DefElem: { defname: "connectionlimit", arg: {} } }],
        },
      });
    }).toThrow(/connection limit/i);
    expect(function parseContextualRemoval() {
      parsePostgresRoleRemovals({
        roles: [{ RoleSpec: { roletype: "ROLESPEC_CURRENT_USER" } }],
      });
    }).toThrow(/concrete role name/i);
    expect(function parseEmptyRemoval() {
      parsePostgresRoleRemovals({ roles: [] });
    }).toThrow(/no concrete role names/i);
  });

  test("models explicit role removals and rejects imperative role changes", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(
      'DROP ROLE IF EXISTS app, "Quoted Role";'
    );

    expect(parsed.sqlObjects).toEqual([
      {
        kind: "role",
        key: "role:app",
        name: "app",
        createStatement: 'DROP ROLE IF EXISTS "app";',
        desiredAbsent: true,
      },
      {
        kind: "role",
        key: "role:Quoted Role",
        name: "Quoted Role",
        createStatement: 'DROP ROLE IF EXISTS "Quoted Role";',
        desiredAbsent: true,
      },
    ]);

    for (const sql of [
      "ALTER ROLE app LOGIN;",
      "ALTER ROLE app RENAME TO renamed;",
      "ALTER ROLE app SET search_path = public;",
    ]) {
      await expect(parser.parseSchema(sql)).rejects.toMatchObject({
        code: "PARSER_ERROR",
        message: expect.stringContaining("CREATE ROLE"),
      });
    }
  });

  test("models complete foreign server definitions and normalizes conditionals", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE SERVER IF NOT EXISTS "Remote Server"
        TYPE 'postgresql'
        VERSION '14'
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (port '5432', host 'localhost');
      ALTER SERVER "Remote Server" OWNER TO "Server Owner";
    `);
    const server = parsed.sqlObjects?.[0];

    expect(server).toMatchObject({
      kind: "foreign-server",
      key: "foreign-server:Remote Server",
      name: "Remote Server",
        foreignServerDefinition: {
          foreignDataWrapper: "postgres_fdw",
          owner: "Server Owner",
          type: "postgresql",
        version: "14",
        options: [
          { name: "host", value: "localhost" },
          { name: "port", value: "5432" },
        ],
      },
    });
    expect(server?.createStatement).toBe(
      `CREATE SERVER "Remote Server" TYPE 'postgresql' VERSION '14' ` +
        `FOREIGN DATA WRAPPER "postgres_fdw" OPTIONS (` +
        `"host" 'localhost', "port" '5432');`
    );
  });

  test("rejects duplicate foreign servers and option names", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(`
        CREATE SERVER duplicate_server
          FOREIGN DATA WRAPPER postgres_fdw;
        CREATE SERVER duplicate_server
          FOREIGN DATA WRAPPER postgres_fdw;
      `)
    ).rejects.toThrow(/foreign server.*declared more than once/i);
    await expect(
      parser.parseSchema(`
        CREATE SERVER duplicate_options
          FOREIGN DATA WRAPPER postgres_fdw
          OPTIONS (host 'one', host 'two');
      `)
    ).rejects.toThrow(/option.*host.*more than once/i);
  });

  test("rejects ambiguous or contextual foreign server ownership", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(`
        CREATE SERVER owned_server FOREIGN DATA WRAPPER postgres_fdw;
        ALTER SERVER owned_server OWNER TO first_owner;
        ALTER SERVER owned_server OWNER TO second_owner;
      `)
    ).rejects.toThrow(/owner.*more than once/i);
    await expect(
      parser.parseSchema(
        `ALTER SERVER missing_server OWNER TO concrete_owner;`
      )
    ).rejects.toThrow(/has no matching CREATE SERVER/i);

    for (const owner of ["CURRENT_ROLE", "CURRENT_USER", "SESSION_USER"]) {
      await expect(
        parser.parseSchema(`
          CREATE SERVER contextual_owner FOREIGN DATA WRAPPER postgres_fdw;
          ALTER SERVER contextual_owner OWNER TO ${owner};
        `)
      ).rejects.toThrow(/depends on the apply session/i);
    }
  });

  test("models explicit foreign server absence and rejects unsafe removal", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      DROP SERVER IF EXISTS "Remote Server" RESTRICT;
      DROP SERVER alpha_server, "Beta Server";
    `);

    expect(parsed.sqlObjects).toEqual([
      {
        kind: "foreign-server",
        key: "foreign-server:Remote Server",
        name: "Remote Server",
        createStatement:
          'DROP SERVER IF EXISTS "Remote Server" RESTRICT;',
        desiredAbsent: true,
      },
      {
        kind: "foreign-server",
        key: "foreign-server:alpha_server",
        name: "alpha_server",
        createStatement:
          'DROP SERVER IF EXISTS "alpha_server" RESTRICT;',
        desiredAbsent: true,
      },
      {
        kind: "foreign-server",
        key: "foreign-server:Beta Server",
        name: "Beta Server",
        createStatement:
          'DROP SERVER IF EXISTS "Beta Server" RESTRICT;',
        desiredAbsent: true,
      },
    ]);

    await expect(
      parser.parseSchema(`DROP SERVER unsafe_server CASCADE;`)
    ).rejects.toThrow(/CASCADE.*not supported.*dependent/i);
    await expect(
      parser.parseSchema(`
        CREATE SERVER conflict FOREIGN DATA WRAPPER postgres_fdw;
        DROP SERVER conflict;
      `)
    ).rejects.toThrow(/foreign server.*declared more than once/i);
    expect(function parseUnknownBehavior() {
      parseForeignServerRemovals(
        { behavior: "DROP_UNKNOWN", objects: [] },
        "removal.sql"
      );
    }).toThrow(/unsupported dependency behavior/i);
    expect(function parseMissingName() {
      parseForeignServerRemovals(
        {
          behavior: "DROP_RESTRICT",
          objects: [{ Integer: { ival: 1 } }],
        },
        "removal.sql"
      );
    }).toThrow(/no concrete server name/i);
  });

  test("quotes unusual foreign server fields losslessly", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE SCHEMA byte_offset_guard;
      -- blå
      CREATE SERVER "Remote ""Server"
        TYPE 'post''gres'
        VERSION /* retained empty */ E''
        FOREIGN DATA WRAPPER "FDW Name"
        OPTIONS ("Mixed Option" 'it''s');
    `);
    const server = parsed.sqlObjects?.[0];

    expect(server?.createStatement).toBe(
      `CREATE SERVER "Remote ""Server" TYPE 'post''gres' VERSION '' ` +
        `FOREIGN DATA WRAPPER "FDW Name" OPTIONS (` +
        `"Mixed Option" 'it''s');`
    );
    expect(server?.foreignServerDefinition).toEqual({
      foreignDataWrapper: "FDW Name",
      type: "post'gres",
      version: "",
      options: [{ name: "Mixed Option", value: "it's" }],
    });
  });

  test("recognizes empty foreign server clauses through PostgreSQL lexical trivia", function () {
    expect(
      hasEmptyForeignServerClause(
        `CREATE SERVER scanner TYPE $type$TYPE ''$type$
          VERSION -- retained empty
          /* outer /* nested */ comment */ U&''
          FOREIGN DATA WRAPPER postgres_fdw`,
        "VERSION"
      )
    ).toBe(true);
    expect(
      hasEmptyForeignServerClause(
        `CREATE SERVER "quoted ""server""" TYPE E''
          FOREIGN DATA WRAPPER postgres_fdw`,
        "TYPE"
      )
    ).toBe(true);
    expect(
      hasEmptyForeignServerClause(
        `$not_a_tag TYPE '' FOREIGN DATA WRAPPER postgres_fdw`,
        "TYPE"
      )
    ).toBe(true);
    expect(
      hasEmptyForeignServerClause(
        `CREATE SERVER scanner TYPE 'not empty'
          FOREIGN DATA WRAPPER postgres_fdw`,
        "TYPE"
      )
    ).toBe(false);
    expect(hasEmptyForeignServerClause(`"unterminated`, "TYPE")).toBe(false);
    expect(
      hasEmptyForeignServerClause(`$tag$unterminated`, "TYPE")
    ).toBe(false);
    expect(
      hasEmptyForeignServerClause(`-- comment without newline`, "TYPE")
    ).toBe(false);
    expect(hasEmptyForeignServerClause(`   `, "TYPE")).toBe(false);
  });

  test("rejects non-string foreign server option AST values", function () {
    const parser = new SchemaParser() as any;

    expect(function parseInvalidOption() {
      parser.parseForeignServerSqlObject(
        {
          CreateForeignServerStmt: {
            servername: "invalid_options",
            fdwname: "postgres_fdw",
            options: [
              {
                DefElem: {
                  defname: "host",
                  arg: { Integer: { ival: 1 } },
                },
              },
            ],
          },
        },
        "invalid.sql"
      );
    }).toThrow(/unsupported option value/i);
  });

  test("tracks issue 112 object families from sql files", async function () {
    const parser = new SchemaParser();
    const sql = `
      CREATE TABLE public.accounts (
        id integer NOT NULL,
        region_id integer NOT NULL
      ) PARTITION BY RANGE (region_id);

      CREATE TABLE public.accounts_eu
        PARTITION OF public.accounts
        FOR VALUES FROM (0) TO (100);

      CREATE TABLE public.users (
        id integer PRIMARY KEY,
        tenant_id integer NOT NULL
      );

      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

      CREATE POLICY tenant_policy
        ON public.users
        FOR SELECT
        USING (tenant_id = current_setting('app.tenant_id')::integer);

      CREATE DOMAIN public.email_address AS text
        CHECK (POSITION('@' IN VALUE) > 1);

      CREATE TYPE public.price_window AS RANGE (
        subtype = numeric
      );

      CREATE SERVER analytics_server
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host '127.0.0.1', dbname 'analytics', port '5432');

      CREATE FUNCTION public.audit_users_trigger()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;

      CREATE PROCEDURE public.touch_users()
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER audit_users_trigger
        AFTER INSERT ON public.users
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_users_trigger();

      CREATE FUNCTION public.audit_ddl()
      RETURNS event_trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN;
      END;
      $$;

      CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();

      CREATE ROLE app_reader NOLOGIN;
      CREATE USER app_user WITH LOGIN;
      GRANT SELECT ON TABLE public.users TO app_reader;
    `;

    const parsed = await parser.parseSchema(sql);
    const sqlObjects = ((parsed as any).sqlObjects || []).map(function (item: any) {
      return item.kind;
    });

    expect(parsed.tables.map(function (table) {
      return table.name;
    })).toEqual(["users"]);
    expect(parsed.procedures?.map(function (item) {
      return item.name;
    })).toEqual(["touch_users"]);
    expect(sqlObjects.sort()).toEqual([
      "constraint-trigger",
      "domain-type",
      "event-trigger",
      "foreign-server",
      "grant",
      "partition",
      "partition",
      "policy",
      "range-type",
      "role",
      "role",
      "row-level-security",
    ]);
  });

  test("splits combined row security declarations into stable desired objects", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      ALTER TABLE "security"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
    `);

    expect(parsed.sqlObjects).toEqual([
      expect.objectContaining({
        key: "row-level-security:security.Order:enabled",
        createStatement: expect.stringMatching(
          /ALTER TABLE security\."Order"\s+ENABLE ROW LEVEL SECURITY;/
        ),
      }),
      expect.objectContaining({
        key: "row-level-security:security.Order:force",
        createStatement: expect.stringMatching(
          /ALTER TABLE security\."Order"\s+FORCE ROW LEVEL SECURITY;/
        ),
      }),
    ]);
  });

  test("preserves trigger definition fields and declarative firing modes", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE TRIGGER update_audit
        BEFORE UPDATE OF name, "Status" ON "audit"."Orders"
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
      ALTER TABLE "audit"."Orders"
        ENABLE ALWAYS TRIGGER update_audit;

      CREATE TRIGGER transition_audit
        AFTER UPDATE ON "audit"."Orders"
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS "New Rows"
        FOR EACH STATEMENT
        EXECUTE FUNCTION public.audit_statement();

      CREATE CONSTRAINT TRIGGER constraint_audit
        AFTER INSERT ON "audit"."Orders"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
      ALTER TABLE "audit"."Orders"
        DISABLE TRIGGER constraint_audit;

      CREATE EVENT TRIGGER ddl_audit
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();
      ALTER EVENT TRIGGER ddl_audit ENABLE REPLICA;
    `);

    expect(parsed.triggers).toEqual([
      expect.objectContaining({
        name: "update_audit",
        updateColumns: ["name", "Status"],
        enabled: "always",
      }),
      expect.objectContaining({
        name: "transition_audit",
        oldTransitionTable: "old_rows",
        newTransitionTable: "New Rows",
      }),
    ]);
    expect(parsed.sqlObjects?.find(function findConstraintTrigger(object) {
      return object.key ===
        "constraint-trigger:audit.Orders.constraint_audit";
    })).toMatchObject({
      triggerTable: { name: "Orders", schema: "audit" },
      triggerEnabled: "disabled",
    });
    expect(parsed.sqlObjects?.find(function findEventTrigger(object) {
      return object.key === "event-trigger:ddl_audit";
    })).toMatchObject({
      triggerEnabled: "replica",
    });
  });

  test("rejects ambiguous or unbound trigger firing mutations", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(
        "ALTER TABLE public.orders DISABLE TRIGGER USER;"
      )
    ).rejects.toThrow(/bulk trigger firing mutations.*not supported/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.orders DISABLE TRIGGER missing_trigger;"
      )
    ).rejects.toThrow(/target trigger.*not declared/i);
    await expect(
      parser.parseSchema(`
        CREATE TRIGGER audit
          AFTER INSERT ON public.orders
          EXECUTE FUNCTION public.audit_row();
        ALTER TABLE ONLY public.orders DISABLE TRIGGER audit;
      `)
    ).rejects.toThrow(/ALTER TABLE ONLY.*unmodeled state/i);
    await expect(
      parser.parseSchema(`
        CREATE TRIGGER audit
          AFTER INSERT ON public.orders
          EXECUTE FUNCTION public.audit_row();
        ALTER TABLE public.orders DISABLE TRIGGER audit;
        ALTER TABLE public.orders ENABLE TRIGGER audit;
      `)
    ).rejects.toThrow(/firing mode.*more than once/i);
  });

  test("rejects duplicate declarations across every trigger family", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE TRIGGER audit
        AFTER INSERT ON public.orders
        EXECUTE FUNCTION public.audit_row();
      CREATE TRIGGER audit
        AFTER INSERT ON public.orders
        EXECUTE FUNCTION public.audit_row();
    `)).rejects.toThrow(/trigger.*orders\.audit.*declared more than once/i);

    await expect(parser.parseSchema(`
      CREATE CONSTRAINT TRIGGER audit
        AFTER INSERT ON public.orders
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
      CREATE CONSTRAINT TRIGGER audit
        AFTER INSERT ON public.orders
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
    `)).rejects.toThrow(/trigger.*orders\.audit.*declared more than once/i);

    await expect(parser.parseSchema(`
      CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();
      CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();
    `)).rejects.toThrow(/trigger.*audit_ddl.*declared more than once/i);
  });

  test("preserves declarative replica identity for tables and partitions", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE TABLE public.default_identity (id integer PRIMARY KEY);
      ALTER TABLE public.default_identity REPLICA IDENTITY DEFAULT;

      CREATE TABLE public.full_identity (id integer, value text);
      ALTER TABLE public.full_identity REPLICA IDENTITY FULL;

      CREATE TABLE public.nothing_identity (id integer, value text);
      ALTER TABLE public.nothing_identity REPLICA IDENTITY NOTHING;

      CREATE TABLE public.index_identity (
        id integer NOT NULL,
        value text
      );
      CREATE UNIQUE INDEX index_identity_key
        ON public.index_identity (id);
      ALTER TABLE public.index_identity
        REPLICA IDENTITY USING INDEX index_identity_key;

      CREATE TABLE public.partition_identity (
        id integer NOT NULL,
        CONSTRAINT partition_identity_pkey PRIMARY KEY (id)
      ) PARTITION BY RANGE (id);
      ALTER TABLE public.partition_identity
        REPLICA IDENTITY USING INDEX partition_identity_pkey;

      CREATE TABLE public.partition_unique_identity (
        id integer NOT NULL,
        CONSTRAINT partition_unique_identity_key UNIQUE (id)
      ) PARTITION BY RANGE (id);
      ALTER TABLE public.partition_unique_identity
        REPLICA IDENTITY USING INDEX partition_unique_identity_key;
    `);

    expect(parsed.tables.find(function findDefault(table) {
      return table.name === "default_identity";
    })).not.toHaveProperty("replicaIdentity");
    expect(parsed.tables.find(function findFull(table) {
      return table.name === "full_identity";
    })).toHaveProperty("replicaIdentity", { mode: "full" });
    expect(parsed.tables.find(function findNothing(table) {
      return table.name === "nothing_identity";
    })).toHaveProperty("replicaIdentity", { mode: "nothing" });
    expect(parsed.tables.find(function findIndex(table) {
      return table.name === "index_identity";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "index_identity_key",
    });
    expect(parsed.sqlObjects?.find(function findPartition(object) {
      return object.key === "partition:public.partition_identity";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "partition_identity_pkey",
    });
    expect(parsed.sqlObjects?.find(function findUniquePartition(object) {
      return object.key === "partition:public.partition_unique_identity";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "partition_unique_identity_key",
    });
  });

  test("rejects duplicate or unbound replica identity declarations", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE TABLE public.accounts (id integer);
      ALTER TABLE public.accounts REPLICA IDENTITY FULL;
      ALTER TABLE public.accounts REPLICA IDENTITY NOTHING;
    `)).rejects.toThrow(/replica identity.*declared more than once/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.missing REPLICA IDENTITY FULL;"
      )
    ).rejects.toThrow(/replica identity target.*not found/i);
  });

  test("preserves declarative PostgreSQL clustering choices", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE TABLE public.clustered_table (id integer, value text);
      CREATE INDEX clustered_table_order
        ON public.clustered_table ((lower(value)));
      ALTER TABLE ONLY public.clustered_table
        CLUSTER ON clustered_table_order;

      CREATE TABLE public.unclustered_table (id integer);
      ALTER TABLE public.unclustered_table SET WITHOUT CLUSTER;

      CREATE MATERIALIZED VIEW public.clustered_summary AS
        SELECT 1 AS id;
      CREATE INDEX clustered_summary_order
        ON public.clustered_summary (id);
      ALTER MATERIALIZED VIEW public.clustered_summary
        CLUSTER ON clustered_summary_order;
    `);

    expect(parsed.tables.find(function findClustered(table) {
      return table.name === "clustered_table";
    })).toHaveProperty("clusterIndex", "clustered_table_order");
    expect(parsed.tables.find(function findUnclustered(table) {
      return table.name === "unclustered_table";
    })).not.toHaveProperty("clusterIndex");
    expect(parsed.views.find(function findSummary(view) {
      return view.name === "clustered_summary";
    })).toHaveProperty("clusterIndex", "clustered_summary_order");
  });

  test("rejects ambiguous or imperative PostgreSQL clustering declarations", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE TABLE public.accounts (id integer);
      CREATE INDEX accounts_order ON public.accounts (id);
      ALTER TABLE public.accounts CLUSTER ON accounts_order;
      ALTER TABLE public.accounts SET WITHOUT CLUSTER;
    `)).rejects.toThrow(/clustering choice.*declared more than once/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.missing CLUSTER ON missing_order;"
      )
    ).rejects.toThrow(/clustering target.*not found/i);
    await expect(parser.parseSchema(`
      CREATE TABLE public.partitioned_accounts (id integer)
        PARTITION BY RANGE (id);
      ALTER TABLE public.partitioned_accounts
        CLUSTER ON partitioned_accounts_id_idx;
    `)).rejects.toThrow(/partition.*clustering/i);
    await expect(
      parser.parseSchema("CLUSTER public.accounts USING accounts_order;")
    ).rejects.toThrow(/physical CLUSTER.*maintenance/i);
  });

  test("rejects imperative policy and negative row security mutations", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema("ALTER POLICY tenant_policy ON public.users USING (true);")
    ).rejects.toThrow(/ALTER POLICY.*imperative partial mutation/i);
    await expect(
      parser.parseSchema("ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;")
    ).rejects.toThrow(/omit ENABLE ROW LEVEL SECURITY/i);
    await expect(
      parser.parseSchema("ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY;")
    ).rejects.toThrow(/omit FORCE ROW LEVEL SECURITY/i);
  });

  test("preserves complete CREATE POLICY semantics", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE POLICY insert_policy ON public.users
        FOR INSERT TO CURRENT_USER WITH CHECK (tenant_id > 0);
      CREATE POLICY all_policy ON public.users
        AS RESTRICTIVE FOR ALL TO PUBLIC
        USING (tenant_id > 0) WITH CHECK (tenant_id >= 10);
    `);

    expect(parsed.sqlObjects?.map(function mapPolicy(object) {
      return object.policyDefinition;
    })).toEqual([
      {
        command: "insert",
        permissive: true,
        roles: [{ kind: "current_user" }],
        withCheck: "tenant_id > 0",
      },
      {
        command: "all",
        permissive: false,
        roles: [{ kind: "public" }],
        using: "tenant_id > 0",
        withCheck: "tenant_id >= 10",
      },
    ]);
  });

  test("rejects duplicate and command-invalid policy declarations", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE POLICY tenant_policy ON public.users USING (true);
      CREATE POLICY tenant_policy ON public.users USING (false);
    `)).rejects.toThrow(/policy .* declared more than once/i);
    await expect(
      parser.parseSchema(
        "CREATE POLICY insert_policy ON public.users FOR INSERT USING (true);"
      )
    ).rejects.toThrow(/INSERT policy.*cannot declare USING/i);
    await expect(
      parser.parseSchema(
        "CREATE POLICY select_policy ON public.users FOR SELECT WITH CHECK (true);"
      )
    ).rejects.toThrow(/SELECT policy.*cannot declare WITH CHECK/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.users ENABLE ROW LEVEL SECURITY, ENABLE ROW LEVEL SECURITY;"
      )
    ).rejects.toThrow(/ENABLE.*declared more than once/i);
    await expect(parser.parseSchema(`
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
    `)).rejects.toThrow(/row-level security state.*declared more than once/i);
  });

  test("preserves domain and range semantics in the canonical model", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE DOMAIN audit.score AS pg_catalog.numeric(10, 2)
        COLLATE pg_catalog."C"
        DEFAULT 1.5
        CONSTRAINT positive CHECK (VALUE > 0)
        NOT NULL;

      CREATE TYPE audit.price_window AS RANGE (
        subtype = pg_catalog.numeric,
        subtype_opclass = pg_catalog.numeric_ops,
        collation = pg_catalog."C",
        canonical = audit.canonical_price,
        subtype_diff = audit.price_diff,
        multirange_type_name = audit.price_windows
      );
    `);

    expect(parsed.sqlObjects).toHaveLength(2);
    expect(parsed.sqlObjects?.[0]).toMatchObject({
      kind: "domain-type",
      key: "domain-type:audit.score",
      typeDefinition: {
        kind: "domain",
        baseType: "NUMERIC(10,2)",
        collation: { schema: "pg_catalog", name: "C" },
        default: "1.5",
        notNull: true,
        constraints: [
          {
            name: "positive",
            expression: "value > 0",
            validated: true,
          },
        ],
      },
    });
    expect(parsed.sqlObjects?.[1]).toMatchObject({
      kind: "range-type",
      key: "range-type:audit.price_window",
      typeDefinition: {
        kind: "range",
        subtype: "NUMERIC",
        subtypeOperatorClass: {
          schema: "pg_catalog",
          name: "numeric_ops",
        },
        collation: { schema: "pg_catalog", name: "C" },
        canonicalFunction: { schema: "audit", name: "canonical_price" },
        subtypeDiffFunction: { schema: "audit", name: "price_diff" },
        multirangeTypeName: { schema: "audit", name: "price_windows" },
      },
    });
    expect(parsed.sqlObjects?.[1]?.createStatement).toContain(
      'collation = pg_catalog."C"'
    );
    expect(parsed.sqlObjects?.[1]?.createStatement).toContain(
      "subtype_opclass = pg_catalog.numeric_ops"
    );
    expect(parsed.sqlObjects?.[1]?.createStatement).not.toContain(
      "terradb_pg_catalog_placeholder"
    );
  });

  test("rejects duplicate and unsupported domain or range clauses", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(`
        CREATE DOMAIN audit.score AS integer
          CONSTRAINT positive CHECK (VALUE > 0)
          CONSTRAINT positive CHECK (VALUE >= 0);
      `)
    ).rejects.toThrow(/constraint 'positive' more than once/i);
    await expect(
      parser.parseSchema(
        "CREATE DOMAIN audit.score AS integer DEFAULT 1 DEFAULT 2;"
      )
    ).rejects.toThrow(/more than one default/i);
    await expect(
      parser.parseSchema(
        "CREATE TYPE audit.window AS RANGE (subtype = integer, subtype = bigint);"
      )
    ).rejects.toThrow(/option 'subtype' more than once/i);
    await expect(
      parser.parseSchema(
        "CREATE TYPE audit.window AS RANGE (subtype = integer, unknown_option = integer);"
      )
    ).rejects.toThrow(/unsupported option 'unknown_option'/i);
    await expect(
      parser.parseSchema("CREATE TYPE audit.window AS RANGE ();")
    ).rejects.toThrow(/syntax error/i);
  });
});
