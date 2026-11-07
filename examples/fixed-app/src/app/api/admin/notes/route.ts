import { createClient } from "@supabase/supabase-js";

// Runs on the server only. Add your own admin check before returning data.
export async function GET() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await admin.from("notes").select("id, body");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
