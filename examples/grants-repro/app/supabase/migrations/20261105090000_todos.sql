-- A table added after Supabase's 2026-10-30 change. RLS and policies are right; the grant is missing.
create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  title text not null,
  done boolean not null default false
);
alter table public.todos enable row level security;

create policy "todos: own rows" on public.todos
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
