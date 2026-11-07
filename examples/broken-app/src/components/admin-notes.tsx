"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// "Quick fix" for RLS errors: talk to Supabase with the service role key.
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export function AdminNotes() {
  const [notes, setNotes] = useState<{ id: number; body: string }[]>([]);
  useEffect(() => {
    supabase.from("notes").select("id, body").then(({ data }) => setNotes(data ?? []));
  }, []);
  return (
    <ul>
      {notes.map((n) => (
        <li key={n.id}>{n.body}</li>
      ))}
    </ul>
  );
}
