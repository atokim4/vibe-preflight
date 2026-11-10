import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { scan } from "../src/scan.ts";
import { authValue, minVersion } from "../src/rules/server-adapters.ts";
import { insertRewrite, splitTopLevel, updateRewrite } from "../src/rules/cron.ts";
import { at, cleanup, EXAMPLES, only, project } from "./helpers.ts";

afterAll(cleanup);

const BEFORE = "2026-11-10";
const AFTER = "2026-12-01";
const run = (dir: string, today = BEFORE) => scan(dir, [], { today }).findings;

const PKG = (deps: Record<string, string>) => JSON.stringify({ name: "api", dependencies: { hono: "4.13.17", ...deps } });
const HONO_APP = `import { Hono } from "hono";
import { withSupabase } from "@supabase/server/adapters/hono";
const app = new Hono();
app.use("*", withSupabase({ auth: "user" }));
export default app;
`;

describe("server-adapter-removed", () => {
  const adapters = (files: Record<string, string>, today = BEFORE) => only(run(project(files), today), "server-adapter-removed");

  it("warns before 2026-12-01 with the days left, and is an error from that day", () => {
    const files = { "package.json": PKG({ "@supabase/server": "^1.9.2", "@supabase/middleware": "^1.0.0" }), "src/index.ts": HONO_APP };
    const before = adapters(files);
    expect(before.map((f) => `${f.severity} ${f.line}`)).toEqual(["warning 2", "warning 4"]);
    expect(before[0]!.message).toBe(
      "`@supabase/server/adapters/hono` is removed on 2026-12-01 (21 days left). Copy `hono/supabase-middleware.ts` from supabase/server examples/frameworks to `src/lib/supabase-middleware.ts`.",
    );
    expect(adapters(files, "2026-11-30")[0]!.message).toContain("(1 day left)");
    const after = adapters(files, AFTER);
    expect(after.map((f) => f.severity)).toEqual(["error", "error"]);
    expect(after[0]!.message).toContain("was removed on 2026-12-01");
  });

  it("notes a @supabase/server range below 1.6.0 and a missing @supabase/middleware, from the nearest package.json", () => {
    const msg = adapters({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "apps/api/package.json": PKG({ "@supabase/server": "~1.5.1" }),
      "apps/api/src/index.ts": HONO_APP,
    })[0]!.message;
    expect(msg).toContain("apps/api/package.json allows @supabase/server ~1.5.1; the bridges need 1.6.0 or later");
    expect(msg).toContain("add @supabase/middleware as a direct dependency");
  });

  it("gives the replacement for each auth value, the way the migration guide decides it", () => {
    const list = adapters({
      "package.json": PKG({ "@supabase/server": "^1.9.2", "@supabase/middleware": "^1.0.0" }),
      "src/app.ts": `import { withSupabase as supa } from '@supabase/server/adapters/h3'
app.use(supa())
app.use(supa({ auth: 'none' }))
app.use(supa({ auth: 'publishable' }))
app.use(supa({ auth: 'secret:cron' }))
app.use(supa({ auth: mode }))
`,
    }).slice(1);
    expect(list.map((f) => f.message)).toEqual([
      "`supa()` is auth: 'user'. Replace it with `toH3([withRequiredClaims(), withSupabaseClient()])` (not withClaims(), which lets anonymous requests through with a 200).",
      "`supa({ auth: 'none' })` is auth: 'none'. Replace it with `toH3([withSupabaseClient()])`, no gate.",
      "`supa({ auth: 'publishable' })` is auth: 'publishable'. Keep this endpoint on `withSupabase` from '@supabase/server'; apikey auth has no composable gate.",
      "`supa({ auth: 'secret:cron' })` is auth: 'secret'. Keep this endpoint on `withSupabase` from '@supabase/server'; apikey auth has no composable gate.",
      "`supa({ auth: mode })` has an auth value that isn't one literal. Decide it by hand: 'user' needs withRequiredClaims(), 'none' no gate, 'publishable' or 'secret' stays on withSupabase.",
    ]);
  });

  it("names the Elysia and NestJS bridges with what changes around them", () => {
    const pkg = PKG({ "@supabase/server": "^1.9.2", "@supabase/middleware": "^1.0.0" });
    const elysia = adapters({ "package.json": pkg, "src/a.ts": "import { withSupabase } from '@supabase/server/adapters/elysia'\nnew Elysia().use(withSupabase({ auth: 'user' }))\n" });
    expect(elysia[1]!.message).toContain("`wrapElysia([withRequiredClaims(), withSupabaseClient()], (req) => app.handle(req))`");
    expect(elysia[1]!.message).toContain("supabaseCtx<typeof entries>()");
    const nest = adapters({ "package.json": pkg, "src/c.ts": "import { withSupabase } from '@supabase/server/adapters/nestjs'\n@UseGuards(withSupabase({ auth: 'none' }))\nclass C {}\n" });
    expect(nest[0]!.message).toContain("Copy `nestjs/supabase.guard.ts`");
    expect(nest[1]!.message).toContain("`toNestGuard([withSupabaseClient()])`");
  });

  it("finds Deno npm: specifiers, dynamic imports and require, and skips comments and the middleware entries", () => {
    const list = adapters({
      "supabase/functions/api/index.ts": 'import { withSupabase } from "npm:@supabase/server@1.9.0/adapters/hono";\n',
      "src/lazy.ts": "const m = await import('@supabase/server/adapters/h3');\n",
      "src/old.cjs": "const { withSupabase } = require('@supabase/server/adapters/elysia');\n",
      "src/notes.ts": "// was: import { withSupabase } from '@supabase/server/adapters/hono'\nimport { withRequiredClaims } from '@supabase/server/middleware/required-claims';\nimport { withSupabase } from '@supabase/server';\nwithSupabase({ auth: 'user' }, handler);\n",
    });
    expect(at(list)).toEqual([
      "server-adapter-removed warning src/lazy.ts:1",
      "server-adapter-removed warning src/old.cjs:1",
      "server-adapter-removed warning supabase/functions/api/index.ts:1",
    ]);
  });

  it("reads the lowest version a range allows", () => {
    expect(minVersion("^1.4.0")).toEqual([1, 4, 0]);
    expect(minVersion(">=1.6 <2")).toEqual([1, 6, 0]);
    expect(minVersion("1.9.2")).toEqual([1, 9, 2]);
    expect(minVersion("latest")).toBeUndefined();
    expect(minVersion("workspace:*")).toBeUndefined();
  });

  it("reads the auth value of a registration", () => {
    expect(authValue("")).toBe("user");
    expect(authValue("{ cors: false }")).toBe("user");
    expect(authValue("{ auth: `none` }")).toBe("none");
    expect(authValue("{ auth: 'secret:admin' }")).toBe("secret");
    expect(authValue("{ auth: cfg.auth }")).toBe("dynamic");
  });

  it("reads the deprecated allow option and lists of modes", () => {
    expect(authValue("{ allow: 'user', env }")).toBe("user");
    expect(authValue("{ allow: 'always' }")).toBe("none");
    expect(authValue("{ allow: 'public:web' }")).toBe("publishable");
    expect(authValue("{ allow: 'none', auth: 'user' }")).toBe("user");
    expect(authValue("{ auth: ['user', 'user'] }")).toBe("user");
    expect(authValue("{ auth: ['user', 'secret:cron'] }")).toBe("secret");
    expect(authValue("{ auth: ['user', 'none'] }")).toBe("dynamic");
    expect(authValue("{ auth: ['user', extra] }")).toBe("dynamic");
  });

  it("reports leftover supabaseContext reads in a project on @supabase/server, even with the adapters gone", () => {
    const list = adapters({
      "package.json": PKG({ "@supabase/server": "^1.9.2", "@supabase/middleware": "^1.0.0" }),
      "src/routes.ts": "app.get('/me', (c) => c.json({ id: c.var.supabaseContext.userClaims.id }));\nconst s = c.get('supabaseContext');\nconst supabaseContext = 1; // a local variable is fine\n",
    });
    expect(at(list)).toEqual(["server-adapter-removed warning src/routes.ts:1", "server-adapter-removed warning src/routes.ts:2"]);
    expect(list[0]!.message).toContain("`.id` becomes `jwtClaims.sub`");
    expect(adapters({ "package.json": PKG({}), "src/routes.ts": "const x = ctx.supabaseContext;\n" })).toEqual([]);
  });
});

describe("cron-job-direct-write", () => {
  const cron = (files: Record<string, string>) => only(run(project({ "supabase/config.toml": "", ...files })), "cron-job-direct-write");

  it("flags INSERT/UPDATE on cron.job in migrations and seeds, top level and inside DO blocks", () => {
    const list = cron({
      "supabase/migrations/20261101000000_jobs.sql": `-- insert into cron.job (comment, ignored)
INSERT INTO "cron"."job" (jobname, schedule, command) VALUES ('a', '* * * * *', 'select 1');
update only cron.job set command = 'select 2' where jobid = 7;
do $body$
declare n int;
begin
  update cron.job set active = false where jobname like 'tmp-%';
end
$body$;
create function public.pause_all() returns void language sql as $$ update cron.job set active = false $$;
`,
      "supabase/seed.sql": "insert into cron.job (schedule, command) values ('0 0 * * *', $$vacuum$$);\n",
    });
    expect(list.map((f) => `${f.file}:${f.line} ${/rewrite as `([^`]+)`/.exec(f.message)?.[1]}`)).toEqual([
      "supabase/migrations/20261101000000_jobs.sql:2 select cron.schedule('a', '* * * * *', 'select 1');",
      "supabase/migrations/20261101000000_jobs.sql:3 select cron.alter_job(7, command := 'select 2');",
      "supabase/migrations/20261101000000_jobs.sql:7 perform cron.alter_job(jobid, active := false) from cron.job where jobname like 'tmp-%';",
      "supabase/migrations/20261101000000_jobs.sql:10 select cron.alter_job(jobid, active := false) from cron.job;",
      "supabase/seed.sql:1 select cron.schedule('0 0 * * *', $$vacuum$$);",
    ]);
    expect(list.every((f) => f.severity === "warning")).toBe(true);
  });

  it("leaves reads, cron.job_run_details and the pg_cron functions alone", () => {
    expect(
      cron({
        "supabase/migrations/20261101000000_ok.sql":
          "select * from cron.job;\ndelete from cron.job_run_details where end_time < now() - interval '7 days';\nupdate cron.job_run_details set status = 'x';\nselect cron.schedule('n', '0 1 * * *', $$update cron.job_history set x = 1$$);\ncomment on table public.t is 'never insert into cron.job by hand';\n",
      }),
    ).toEqual([]);
  });

  it("checks other SQL (Prisma migrations, schema.sql) only in projects that use Supabase", () => {
    const write = "insert into cron.job (schedule, command) values ('* * * * *', 'select 1');\n";
    expect(at(cron({ "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.80.0" } }), "prisma/migrations/1_init/migration.sql": write }))).toEqual([
      "cron-job-direct-write warning prisma/migrations/1_init/migration.sql:1",
    ]);
    const selfHosted = project({ "package.json": JSON.stringify({ dependencies: { prisma: "7.0.0" } }), "prisma/migrations/1_init/migration.sql": write });
    expect(only(run(selfHosted), "cron-job-direct-write")).toEqual([]);
  });

  it("falls back to the general advice when the statement has no safe one-line rewrite", () => {
    const messages = cron({
      "supabase/migrations/20261101000000_x.sql":
        "update cron.job set jobname = 'renamed' where jobid = 1;\ninsert into cron.job (schedule, command, nodename) values ('* * * * *', 'select 1', 'worker-2');\ninsert into cron.job select * from tmp_jobs;\n",
    }).map((f) => f.message);
    expect(messages[0]).toContain("a rename is cron.unschedule + cron.schedule");
    expect(messages[1]).toContain("use `select cron.schedule('<name>', '<schedule>', $$<command>$$);` instead");
    expect(messages[2]).toContain("use `select cron.schedule(");
  });

  it("builds schedule_in_database when the row names a database or user", () => {
    expect(insertRewrite("insert into cron.job (jobname, schedule, command, username, active) values ('r', '@daily', 'select 1', 'reporter', false)")).toBe(
      "select cron.schedule_in_database('r', '@daily', 'select 1', current_database(), username := 'reporter', active := false);",
    );
    expect(insertRewrite("insert into cron.job (schedule, command, database) values ('@daily', 'select 1', 'other')")).toBeUndefined();
    expect(insertRewrite("insert into cron.job (jobid, jobname, schedule, command) values (9, 'k', '@hourly', 'select 1') on conflict do nothing")).toBe(
      "select cron.schedule('k', '@hourly', 'select 1');",
    );
  });

  it("shortens long values instead of breaking them", () => {
    const long = `'${"x".repeat(60)}'`;
    expect(updateRewrite(`update cron.job set command = ${long} where jobid = 3`)).toBe("select cron.alter_job(3, command := <command>);");
  });

  it("splits on top-level commas only", () => {
    expect(splitTopLevel("'a,b', $$c, d$$, f(1, 2), \"x,y\"")).toEqual(["'a,b'", "$$c, d$$", "f(1, 2)", '"x,y"']);
  });
});

describe("examples/breaking-app", () => {
  const broken = (today?: string) => run(join(EXAMPLES, "breaking-app"), today);

  it("reports each adapter import and registration, and every direct cron.job write", () => {
    expect(at(broken())).toEqual([
      "server-adapter-removed warning src/games.controller.ts:2",
      "server-adapter-removed warning src/games.controller.ts:7",
      "server-adapter-removed warning src/index.ts:2",
      "server-adapter-removed warning src/index.ts:7",
      "server-adapter-removed warning src/index.ts:8",
      "server-adapter-removed warning src/index.ts:9",
      "server-adapter-removed warning src/index.ts:12",
      "server-adapter-removed warning src/index.ts:18",
      "cron-job-direct-write warning supabase/migrations/20261105000000_cron_jobs.sql:4",
      "cron-job-direct-write warning supabase/migrations/20261105000000_cron_jobs.sql:7",
      "cron-job-direct-write warning supabase/migrations/20261105000000_cron_jobs.sql:9",
      "cron-job-direct-write warning supabase/migrations/20261105000000_cron_jobs.sql:14",
      "cron-job-direct-write warning supabase/seed.sql:2",
    ]);
  });

  it("turns the adapter findings into errors from 2026-12-01", () => {
    const after = broken(AFTER);
    expect(after.filter((f) => f.severity === "error").map((f) => f.rule)).toEqual(Array(8).fill("server-adapter-removed"));
  });

  it("is clean once migrated (breaking-app-fixed)", () => {
    expect(run(join(EXAMPLES, "breaking-app-fixed"), AFTER)).toEqual([]);
  });
});

/**
 * PGlite can't load pg_cron, so this can't prove anything about pg_cron itself. It checks that every rewrite the
 * rule prints is valid SQL that binds to the function signatures pg_cron documents (stubs below, same parameter
 * names and defaults), and models Supabase's restriction with a role that may read cron.job but not write it.
 */
describe("cron rewrites against pg_cron's documented signatures (stubs in PGlite)", async () => {
  const db = new PGlite();
  afterAll(() => db.close());
  await db.exec(`
    create schema cron;
    create table cron.job (
      jobid bigserial primary key, schedule text not null, command text not null,
      nodename text not null default 'localhost', nodeport int not null default 5432,
      database text not null default current_database(), username text not null default current_user,
      active boolean not null default true, jobname text,
      constraint jobname_username_uniq unique (jobname, username));
    create function cron.schedule(schedule text, command text) returns bigint language sql security definer
      as $$ insert into cron.job (schedule, command) values (schedule, command) returning jobid $$;
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql security definer
      as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
            on conflict on constraint jobname_username_uniq do update set schedule = excluded.schedule, command = excluded.command
            returning jobid $$;
    create function cron.schedule_in_database(job_name text, schedule text, command text, database text,
      username text default null, active boolean default true) returns bigint language sql security definer
      as $$ insert into cron.job (jobname, schedule, command, database, username, active)
            values (job_name, schedule, command, database, coalesce(username, current_user), active) returning jobid $$;
    create function cron.alter_job(job_id bigint, schedule text default null, command text default null,
      database text default null, username text default null, active boolean default null) returns void
      language sql security definer
      as $$ update cron.job set schedule = coalesce(alter_job.schedule, job.schedule), command = coalesce(alter_job.command, job.command),
            database = coalesce(alter_job.database, job.database), username = coalesce(alter_job.username, job.username),
            active = coalesce(alter_job.active, job.active) where jobid = job_id $$;
    create role migrator;
    grant usage on schema cron to migrator;
    grant select on cron.job to migrator;
    grant execute on all functions in schema cron to migrator;
  `);

  const exec = async (sql: string) => {
    try {
      await db.exec(`set role migrator; ${sql}; reset role;`);
      return "ok";
    } catch (error) {
      await db.exec("reset role;");
      return (error as { code?: string }).code ?? String(error);
    }
  };

  it("blocks the direct writes for the restricted role, like Supabase does", async () => {
    expect(await exec("insert into cron.job (jobname, schedule, command) values ('a', '0 3 * * *', 'select 1')")).toBe("42501");
  });

  it("runs every rewrite the rule printed for examples/breaking-app", async () => {
    const rewrites = only(run(join(EXAMPLES, "breaking-app")), "cron-job-direct-write")
      .map((f) => /rewrite as `([^`]+)`/.exec(f.message)?.[1])
      .filter((s): s is string => Boolean(s) && !s!.includes("<"));
    expect(rewrites).toHaveLength(4);
    await db.exec("select cron.schedule('refresh-stats', '0 * * * *', 'select 1'); insert into cron.job (jobid, schedule, command) values (42, '@daily', 'select 2');");
    for (const sql of rewrites) {
      const body = sql.startsWith("perform ") ? `do $$ begin ${sql} end $$` : sql;
      expect(await exec(body), sql).toBe("ok");
    }
    const jobs = await db.query<{ jobname: string | null; schedule: string; active: boolean }>("select jobname, schedule, active from cron.job order by jobid");
    expect(jobs.rows).toEqual(
      expect.arrayContaining([
        { jobname: "refresh-stats", schedule: "*/10 * * * *", active: true },
        { jobname: null, schedule: "@daily", active: false },
        { jobname: "nightly-report", schedule: "30 2 * * *", active: true },
      ]),
    );
  });
});
