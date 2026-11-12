-- Lets the counter fix one of the last 7 days (today and the 6 before it).
-- A plus or minus lands on exactly p_day. Anything older stays locked.
-- Ran on Nov 11, 2026. setup.sql has the same function for a fresh project.
create or replace function public.sc_bump_day(p_key text, p_metric text, p_delta integer, p_day date, p_today date) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  me scorecard.people;
  closer_metric boolean := p_metric in ('closerSat', 'censuses', 'signedDeals');
begin
  me := scorecard.who(p_key);
  if p_delta not in (1, -1) then raise exception 'bad_delta'; end if;
  -- The page sends its own date so taps land on the rep's local day; it can't be far off.
  if p_today is null or abs(p_today - (now() at time zone 'utc')::date) > 1 then raise exception 'bad_day'; end if;
  if p_day is null or p_day > p_today or p_day < p_today - 6 then raise exception 'day_locked'; end if;
  if closer_metric and not ('closer' = any (me.roles)) then raise exception 'bad_metric'; end if;
  if not closer_metric and not ('setter' = any (me.roles)) then raise exception 'bad_metric'; end if;

  if p_delta = 1 then
    insert into scorecard.counts as c (person_id, day, metric, n) values (me.id, p_day, p_metric, 1)
    on conflict (person_id, day, metric) do update set n = c.n + 1;
    return true;
  end if;

  delete from scorecard.counts c where c.person_id = me.id and c.day = p_day and c.metric = p_metric and c.n = 1;
  if found then return true; end if;
  update scorecard.counts c set n = c.n - 1 where c.person_id = me.id and c.day = p_day and c.metric = p_metric;
  return found;
end $$;

revoke all on function public.sc_bump_day(text, text, integer, date, date) from public;
grant execute on function public.sc_bump_day(text, text, integer, date, date) to anon, authenticated;
notify pgrst, 'reload schema';
