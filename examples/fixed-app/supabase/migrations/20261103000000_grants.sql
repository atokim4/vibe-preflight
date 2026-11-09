-- Since 2026-10-30 Supabase doesn't grant new public tables to the Data API roles. Grant only what the app uses.
-- The Stripe webhook and the admin route use the service role key; signed-in users get what their policies allow.
grant select, update on public.profiles to service_role;
grant select, insert on public.profiles to authenticated;

grant select on public.notes to service_role;
grant select, insert on public.notes to authenticated;
