import { supabase } from "./supabase";

export async function listNotes() {
  const { data, error } = await supabase.from("notes").select("id, body");
  if (error) throw error;
  return data;
}
