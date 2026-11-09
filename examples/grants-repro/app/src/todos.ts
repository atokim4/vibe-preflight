import { supabase } from "./supabase";

export async function listTodos() {
  const { data, error } = await supabase.from("todos").select("id, title, done").order("id");
  if (error) throw error;
  return data;
}

export async function addTodo(title: string) {
  const { error } = await supabase.from("todos").insert({ title });
  if (error) throw error;
}

export async function toggleTodo(id: number, done: boolean) {
  const { error } = await supabase.from("todos").update({ done }).eq("id", id);
  if (error) throw error;
}
