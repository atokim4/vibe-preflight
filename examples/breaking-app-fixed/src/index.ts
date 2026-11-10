import { Hono } from "hono";
import { withSupabase } from "@supabase/server";
import { withRequiredClaims } from "@supabase/server/middleware/required-claims";
import { withSupabaseClient } from "@supabase/server/middleware/client";
import { toHono } from "./lib/supabase-middleware.js";

// Sample data: breaking-app's todo API after moving off the Hono adapter.
// One sub-app per entry array, each chaining its own .use() into its routes.

// Was auth: 'user'. withRequiredClaims() keeps the 401 for anonymous callers.
const todos = new Hono()
  .use("*", toHono([withRequiredClaims(), withSupabaseClient()]))
  .get("/", async (c) => {
    const { data, error } = await c.var.supabase.from("todos").select();
    if (error) return c.json({ error: error.message }, 500);
    return c.json(data);
  })
  .get("/me", (c) => c.json({ id: c.var.jwtClaims.sub }));

// Was auth: 'none'. No gate.
const health = new Hono()
  .use("*", toHono([withSupabaseClient()]))
  .get("/", (c) => c.json({ ok: true }));

// Was auth: 'secret'. apikey auth has no composable gate, so it stays on withSupabase.
const reindex = withSupabase({ auth: "secret" }, async () => Response.json({ queued: true }));

const app = new Hono().route("/todos", todos).route("/health", health).mount("/internal/reindex", reindex);

export default { fetch: app.fetch };
