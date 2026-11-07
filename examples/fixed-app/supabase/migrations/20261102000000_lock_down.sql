-- Users may only create and read their own profile. The plan column is changed by the Stripe webhook (service role).
drop policy "Enable insert for authenticated users only" on public.profiles;
drop policy "Enable read access for all users" on public.profiles;

create policy "profiles: insert own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

create policy "profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

alter table public.notes enable row level security;

create policy "notes: read own" on public.notes
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "notes: insert own" on public.notes
  for insert to authenticated with check ((select auth.uid()) = user_id);
