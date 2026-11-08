import { afterAll, describe, expect, it } from "vitest";
import { at, cleanup, findings, ids, NEXT_SUPABASE, only, project } from "./helpers.ts";

afterAll(cleanup);

const migration = (sql: string) => project({ ...NEXT_SUPABASE, "supabase/migrations/001.sql": sql });

describe("rls-disabled", () => {
  it("flags a public table until a later migration enables RLS", () => {
    expect(only(findings(migration("create table todos (id int);")), "rls-disabled")).toHaveLength(1);
    const later = project({
      ...NEXT_SUPABASE,
      "supabase/migrations/001.sql": "create table public.todos (id int);",
      "supabase/migrations/002.sql": 'ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY;',
    });
    expect(only(findings(later), "rls-disabled")).toEqual([]);
  });

  it("ignores other schemas, dropped tables, SQL in comments and function bodies", () => {
    const sql = `
      -- create table public.commented (id int);
      create table private.secrets (id int);
      create table public.tmp (id int);
      drop table public.tmp;
      create function f() returns void language plpgsql as $$ begin create table public.inner_t (id int); end $$;
    `;
    expect(only(findings(migration(sql)), "rls-disabled")).toEqual([]);
  });

  it("follows a rename", () => {
    const sql = "create table public.a (id int); alter table public.a rename to b; alter table public.b enable row level security;";
    expect(only(findings(migration(sql)), "rls-disabled")).toEqual([]);
  });

  it("skips projects that don't use Supabase (plain Postgres isn't exposed to browsers)", () => {
    const dir = project({ "package.json": JSON.stringify({ dependencies: { next: "16.0.0", "drizzle-orm": "1.0.0" } }), "drizzle/0001.sql": "create table users (id int);" });
    expect(findings(dir)).toEqual([]);
  });
});

describe("rls-permissive-policy", () => {
  const base = "create table public.t (id int, user_id uuid); alter table public.t enable row level security;\n";

  it("is an error on writes and a warning on reads", () => {
    const list = only(
      findings(migration(base + "create policy w on public.t for update to authenticated using (true);\ncreate policy r on public.t for select using (true);")),
      "rls-permissive-policy",
    );
    expect(list.map((f) => `${f.severity} ${f.line}`)).toEqual(["error 2", "warning 3"]);
    expect(list[0]!.message).toContain("any signed-in user");
    expect(list[1]!.message).toContain("anyone (signed in or not)");
  });

  it("accepts ownership checks, service_role-only policies and dropped policies", () => {
    const sql =
      base +
      "create policy own on public.t for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);\n" +
      "create policy svc on public.t for all to service_role using (true);\n" +
      'create policy "open" on public.t for insert with check (true);\ndrop policy "open" on public.t;';
    expect(only(findings(migration(sql)), "rls-permissive-policy")).toEqual([]);
  });

  it("honours a vibe-preflight-ignore comment on the line above", () => {
    const sql = base + "-- vibe-preflight-ignore rls-permissive-policy (public catalogue)\ncreate policy r on public.t for select using (true);";
    expect(only(findings(migration(sql)), "rls-permissive-policy")).toEqual([]);
  });
});

describe("server-secret-in-client", () => {
  it("flags a 'use client' file, not a route handler or a comment", () => {
    const dir = project({
      ...NEXT_SUPABASE,
      "components/a.tsx": '"use client";\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n',
      "components/b.tsx": '"use client";\n// never use SUPABASE_SERVICE_ROLE_KEY here\n',
      "app/api/admin/route.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n",
    });
    expect(only(findings(dir), "server-secret-in-client").map((f) => `${f.file}:${f.line}`)).toEqual(["components/a.tsx:2"]);
  });

  it("treats everything under src/ as browser code in a Vite app, except Edge Functions", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { vite: "7.0.0", "@supabase/supabase-js": "2.80.0" } }),
      "src/lib/admin.ts": "createClient(url, import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY);\n",
      "src/lib/role.ts": "const role = 'service_role';\n",
      "supabase/functions/admin/index.ts": "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');\n",
    });
    const list = findings(dir);
    expect(only(list, "server-secret-in-client").map((f) => f.file)).toEqual(["src/lib/admin.ts", "src/lib/role.ts"]);
    expect(only(list, "public-env-secret").map((f) => f.message)).toEqual(["`VITE_SUPABASE_SERVICE_ROLE_KEY` looks like a secret and is exposed to the browser."]);
  });
});

describe("public-env-secret", () => {
  it("lets browser-safe names through and warns on generic API keys", () => {
    const dir = project({
      ...NEXT_SUPABASE,
      ".env.example": "NEXT_PUBLIC_SUPABASE_ANON_KEY=\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=\nNEXT_PUBLIC_SITE_URL=\nNEXT_PUBLIC_RESEND_API_KEY=\nNEXT_PUBLIC_DATABASE_URL=\n",
    });
    expect(only(findings(dir), "public-env-secret").map((f) => `${f.severity} ${f.line}`)).toEqual(["error 5", "warning 4"]);
  });

  it("skips boolean feature flags with secret-sounding names", () => {
    const dir = project({
      ...NEXT_SUPABASE,
      ".env.example": "NEXT_PUBLIC_AUTH_PASSWORD=true\nNEXT_PUBLIC_SECRET_MODE=1\n",
      "lib/auth.ts": "export const password = process.env.NEXT_PUBLIC_AUTH_PASSWORD === 'true';\nexport const nums = process.env.NEXT_PUBLIC_PASSWORD_REQUIRE_NUMBERS === \"true\";\nexport const mode = process.env.NEXT_PUBLIC_SECRET_MODE;\n",
    });
    expect(only(findings(dir), "public-env-secret").map((f) => f.message)).toEqual(["`NEXT_PUBLIC_SECRET_MODE` looks like a secret and is exposed to the browser."]);
  });

  it("only checks the prefixes of the detected framework", () => {
    const dir = project({ ...NEXT_SUPABASE, ".env.example": "VITE_STRIPE_SECRET_KEY=\n" });
    expect(only(findings(dir), "public-env-secret")).toEqual([]);
  });
});

describe("stripe-webhook-unverified", () => {
  const handler = (body: string) =>
    `export async function POST(req: Request) {\n${body}\n  if (event.type === "checkout.session.completed") {}\n  return new Response("ok");\n}\n`;

  it("flags a handler without constructEvent", () => {
    const dir = project({ ...NEXT_SUPABASE, "app/api/stripe/webhook/route.ts": handler("  const event = await req.json();") });
    expect(only(findings(dir), "stripe-webhook-unverified").map((f) => f.line)).toEqual([3]);
  });

  it("accepts constructEvent and constructEventAsync, but not one in a comment", () => {
    const sync = handler("  const event = stripe.webhooks.constructEvent(await req.text(), sig, secret);");
    const edge = handler("  const event = await stripe.webhooks.constructEventAsync(body, sig, secret);");
    const commented = handler("  // TODO: stripe.webhooks.constructEvent(body, sig, secret)\n  const event = await req.json();");
    const dir = project({ ...NEXT_SUPABASE, "app/api/stripe/webhook/route.ts": sync, "supabase/functions/stripe/index.ts": edge, "app/api/billing/webhook/route.ts": commented });
    expect(only(findings(dir), "stripe-webhook-unverified").map((f) => f.file)).toEqual(["app/api/billing/webhook/route.ts"]);
  });

  it("leaves other providers' webhooks alone", () => {
    const clerk = 'import { Webhook } from "svix";\nexport async function POST(req: Request) {\n  const event = new Webhook(secret).verify(await req.text(), headers);\n  if (event.type === "user.created") {}\n}\n';
    const dir = project({ ...NEXT_SUPABASE, "app/api/webhooks/clerk/route.ts": clerk });
    expect(only(findings(dir), "stripe-webhook-unverified")).toEqual([]);
  });

  it("ignores a CORS helper that only lists the stripe-signature header", () => {
    const cors = 'import { NextResponse } from "next/server";\n// Stripe\nconst headers = { "Access-Control-Allow-Headers": "Content-Type, stripe-signature" };\nexport function withCors(h: Function) { return h; }\n';
    const reads = 'import Stripe from "stripe";\nexport async function POST(req: Request) {\n  const sig = req.headers.get("Stripe-Signature");\n  const event = await req.json();\n}\n';
    const dir = project({ ...NEXT_SUPABASE, "utils/cors.ts": cors, "app/api/pay/route.ts": reads });
    expect(only(findings(dir), "stripe-webhook-unverified").map((f) => f.file)).toEqual(["app/api/pay/route.ts"]);
  });

  it("ignores client code that only names an event", () => {
    const dir = project({ ...NEXT_SUPABASE, "components/plan.tsx": '"use client";\nimport { loadStripe } from "@stripe/stripe-js";\nconst e = "checkout.session.completed";\nexport default function P() { return null; }\n' });
    expect(only(findings(dir), "stripe-webhook-unverified")).toEqual([]);
  });
});

describe("stripe-webhook-parsed-body", () => {
  const verified = (read: string, arg: string) =>
    `import Stripe from "stripe";\nexport async function POST(req: Request) {\n${read}\n  const event = stripe.webhooks.constructEvent(${arg}, req.headers.get("stripe-signature")!, secret);\n  if (event.type === "checkout.session.completed") {}\n}\n`;

  it("flags .json() and JSON.stringify before constructEvent", () => {
    const json = verified("  const payload = await req.json();", "JSON.stringify(payload)");
    const dir = project({ ...NEXT_SUPABASE, "app/api/stripe/webhook/route.ts": json });
    expect(at(only(findings(dir), "stripe-webhook-parsed-body"))).toEqual([
      "stripe-webhook-parsed-body warning app/api/stripe/webhook/route.ts:3",
      "stripe-webhook-parsed-body warning app/api/stripe/webhook/route.ts:4",
    ]);
  });

  it("accepts the raw text body", () => {
    const dir = project({ ...NEXT_SUPABASE, "app/api/stripe/webhook/route.ts": verified("  const body = await req.text();", "body") });
    expect(only(findings(dir), "stripe-webhook-parsed-body")).toEqual([]);
  });

  it("flags req.body in pages/api unless bodyParser is off", () => {
    const handler = (extra: string) =>
      `import Stripe from "stripe";\n${extra}export default async function handler(req, res) {\n  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);\n}\n`;
    const dir = project({
      ...NEXT_SUPABASE,
      "pages/api/stripe/webhook.ts": handler(""),
      "pages/api/stripe/webhook-raw.ts": handler("export const config = { api: { bodyParser: false } };\n"),
    });
    expect(only(findings(dir), "stripe-webhook-parsed-body").map((f) => f.file)).toEqual(["pages/api/stripe/webhook.ts"]);
  });

  it("flags req.body in Express only when the app parses JSON and never sets up express.raw()", () => {
    const route = 'import Stripe from "stripe";\nexport function webhook(req, res) {\n  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);\n}\n';
    const server = (parsers: string) => `import express from "express";\nconst app = express();\n${parsers}\n`;
    const pkg = { "package.json": '{"dependencies":{"express":"5.0.0","stripe":"19.0.0"}}' };
    const broken = project({ ...pkg, "src/server.ts": server("app.use(express.json());"), "src/stripe/webhook.ts": route });
    const fixed = project({ ...pkg, "src/server.ts": server('app.post("/webhook", express.raw({ type: "application/json" }), webhook);\napp.use(express.json());'), "src/stripe/webhook.ts": route });
    expect(only(findings(broken), "stripe-webhook-parsed-body").map((f) => f.line)).toEqual([3]);
    expect(only(findings(fixed), "stripe-webhook-parsed-body")).toEqual([]);
  });

  it("leaves handlers without constructEvent to stripe-webhook-unverified", () => {
    const dir = project({ ...NEXT_SUPABASE, "app/api/stripe/webhook/route.ts": 'export async function POST(req: Request) {\n  const event = await req.json();\n  if (event.type === "checkout.session.completed") {}\n}\n' });
    expect(ids(findings(dir).filter((f) => f.rule.startsWith("stripe-")))).toEqual(["stripe-webhook-unverified"]);
  });
});

describe("env-file-committed (no git repo)", () => {
  it("flags a root .env with values that .gitignore doesn't cover", () => {
    const dir = project({ "package.json": "{}", ".gitignore": "node_modules\n", ".env": "KEY=value\n", ".env.example": "KEY=placeholder\n", ".env.test": "\n" });
    expect(only(findings(dir), "env-file-committed").map((f) => f.message)).toEqual(["`.env` is not in .gitignore, so `git add .` will commit it."]);
  });

  it("downgrades files with only Supabase local keys or only public variables to warnings", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = (iss: string) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss, role: "service_role" })}.c2lnbmF0dXJl`;
    const dir = project({
      ...NEXT_SUPABASE,
      ".gitignore": "node_modules\n",
      ".env": "NEXT_PUBLIC_SITE_URL=http://localhost:3000\nNEXT_PUBLIC_AUTH_PASSWORD=true\n",
      ".env.development": `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_SERVICE_ROLE_KEY=${jwt("supabase-demo")}\n`,
      ".env.local": `SUPABASE_SERVICE_ROLE_KEY=${jwt("supabase")}\n`,
      ".env.production": `SUPABASE_SERVICE_ROLE_KEY=${jwt("supabase-demo")}\nSTRIPE_SECRET_KEY=${["sk", "live", "x".repeat(16)].join("_")}\n`,
    });
    expect(only(findings(dir), "env-file-committed").map((f) => `${f.severity} ${f.file}`).sort()).toEqual([
      "error .env.local",
      "error .env.production",
      "warning .env",
      "warning .env.development",
    ]);
  });

  it("respects negation and reports a missing .gitignore", () => {
    expect(only(findings(project({ "package.json": "{}", ".gitignore": ".env*\n!.env.local\n", ".env.local": "A=1\n" })), "env-file-committed")).toHaveLength(1);
    expect(only(findings(project({ "package.json": "{}", ".env": "A=1\n" })), "env-file-committed")[0]!.message).toContain("no .gitignore");
  });
});
