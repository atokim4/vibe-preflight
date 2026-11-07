create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  plan text not null default 'free'
);
alter table public.profiles enable row level security;

create policy "Enable insert for authenticated users only" on public.profiles
  for insert to authenticated with check (true);

create policy "Enable read access for all users" on public.profiles
  for select using (true);

create table public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users,
  body text not null,
  created_at timestamptz not null default now()
);
