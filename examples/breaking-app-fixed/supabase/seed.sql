-- Sample data for local development.
select cron.schedule_in_database('nightly-report', '30 2 * * *', 'select public.build_report()', 'postgres', username := 'postgres');
