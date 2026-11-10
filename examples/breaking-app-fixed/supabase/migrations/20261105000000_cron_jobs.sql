-- Sample data: the same jobs through pg_cron's functions.
create extension if not exists pg_cron;

-- A named job: running this again updates the job instead of failing.
select cron.schedule('purge-done-todos', '0 3 * * *', $$delete from public.todos where done and updated_at < now() - interval '30 days'$$);

select cron.alter_job(jobid, schedule := '*/10 * * * *') from cron.job where jobname = 'refresh-stats';

select cron.alter_job(42, active := false);

do $$
begin
  perform cron.schedule('0 * * * *', 'select public.refresh_counts()');
end
$$;

select jobid, jobname from cron.job;
delete from cron.job_run_details where end_time < now() - interval '7 days';
