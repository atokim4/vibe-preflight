-- Sample data: scheduled jobs written straight into pg_cron's table.
create extension if not exists pg_cron;

insert into cron.job (jobname, schedule, command)
values ('purge-done-todos', '0 3 * * *', $$delete from public.todos where done and updated_at < now() - interval '30 days'$$);

update cron.job set schedule = '*/10 * * * *' where jobname = 'refresh-stats';

UPDATE cron.job SET active = false WHERE jobid = 42;

do $$
begin
  -- inside a DO block it is still a direct write
  insert into cron.job (schedule, command) values ('0 * * * *', 'select public.refresh_counts()');
end
$$;

-- Reading cron.job and cleaning cron.job_run_details are fine.
select jobid, jobname from cron.job;
delete from cron.job_run_details where end_time < now() - interval '7 days';
