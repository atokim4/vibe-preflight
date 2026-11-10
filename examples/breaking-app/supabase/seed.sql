-- Sample data for local development.
insert into cron.job (jobname, schedule, command, database, username)
values ('nightly-report', '30 2 * * *', 'select public.build_report()', 'postgres', 'postgres')
on conflict do nothing;
