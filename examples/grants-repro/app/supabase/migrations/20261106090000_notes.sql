-- A second table, made the quick way: no RLS.
create table public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  body text not null
);
