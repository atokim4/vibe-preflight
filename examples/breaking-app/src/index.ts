import { Hono } from "hono";
import { withSupabase } from "@supabase/server/adapters/hono";

// Sample data: a made-up todo API on the deprecated Hono adapter.
const app = new Hono();

app.use("/todos/*", withSupabase({ auth: "user" }));
app.use("/health", withSupabase({ auth: "none" }));
app.use("/internal/*", withSupabase({ auth: "secret" }));

app.get("/todos", async (c) => {
  const { supabase } = c.var.supabaseContext;
  const { data, error } = await supabase.from("todos").select();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

app.get("/todos/me", (c) => c.json({ id: c.var.supabaseContext.userClaims?.id }));
app.get("/health", (c) => c.json({ ok: true }));
app.post("/internal/reindex", (c) => c.json({ queued: true }));

export default { fetch: app.fetch };
