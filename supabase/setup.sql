-- Kept Scorecard database. Run once on a new, empty Supabase project.
--
-- How access works: nobody reads or writes the tables directly. Each person has a
-- private key that lives only in their personal link. The page sends that key to
-- the sc_* functions below, which check it before doing anything. Only a hash of
-- each key is stored, so a lost link is replaced, never looked up.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists scorecard;
revoke all on schema scorecard from public, anon, authenticated;

create table scorecard.people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 40),
  roles text[] not null check (roles <@ array['setter', 'closer'] and cardinality(roles) between 1 and 2),
  is_admin boolean not null default false,
  key_hash bytea unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per person, day and number. Rows at zero are deleted, never kept.
create table scorecard.counts (
  person_id uuid not null references scorecard.people (id) on delete cascade,
  day date not null,
  metric text not null check (metric in (
    'partnersContacted', 'partnersSigned', 'intros', 'outreach', 'contacts', 'meetingsBooked', 'meetingsSat',
    'closerSat', 'censuses', 'signedDeals')),
  n integer not null check (n > 0),
  primary key (person_id, day, metric)
);

alter table scorecard.people enable row level security;
alter table scorecard.counts enable row level security;

-- ---------- Helpers (not reachable from the page) ----------

create or replace function scorecard.new_key() returns text
language sql volatile set search_path = '' as $$
  select encode(extensions.gen_random_bytes(16), 'hex')
$$;

create or replace function scorecard.hash_key(p_key text) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.digest(coalesce(p_key, ''), 'sha256')
$$;

-- The signed-in person for a key, or an error the page shows as "link not working".
create or replace function scorecard.who(p_key text) returns scorecard.people
language plpgsql stable set search_path = '' as $$
declare me scorecard.people;
begin
  select * into me from scorecard.people p where p.active and p.key_hash = scorecard.hash_key(p_key);
  if not found then raise exception 'bad_key' using errcode = '28000'; end if;
  return me;
end $$;

create or replace function scorecard.admin(p_key text) returns scorecard.people
language plpgsql stable set search_path = '' as $$
declare me scorecard.people;
begin
  me := scorecard.who(p_key);
  if not me.is_admin then raise exception 'not_admin' using errcode = '42501'; end if;
  return me;
end $$;

create or replace function scorecard.everything(p_me scorecard.people) returns json
language sql stable set search_path = '' as $$
  select json_build_object(
    'me', json_build_object('id', p_me.id, 'name', p_me.name, 'roles', p_me.roles, 'isAdmin', p_me.is_admin),
    'people', coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name, 'roles', p.roles, 'isAdmin', p.is_admin, 'active', p.active) order by lower(p.name))
      from scorecard.people p), '[]'::json),
    'counts', coalesce((
      select json_object_agg(d.person_id, d.days)
      from (
        select x.person_id, json_object_agg(x.day, x.metrics) as days
        from (
          select c.person_id, c.day::text as day, json_object_agg(c.metric, c.n) as metrics
          from scorecard.counts c group by c.person_id, c.day
        ) x group by x.person_id
      ) d), '{}'::json)
  )
$$;

-- ---------- What the page calls ----------

-- Everyone's numbers, for the counter and the dashboard.
create or replace function public.sc_data(p_key text) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  return scorecard.everything(scorecard.who(p_key));
end $$;

-- A plus lands on p_today. A minus undoes the most recent tap in p_today's week
-- (Mon to Sun), so a Monday mistake can still be fixed on Wednesday.
create or replace function public.sc_bump(p_key text, p_metric text, p_delta integer, p_today date) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  me scorecard.people;
  closer_metric boolean := p_metric in ('closerSat', 'censuses', 'signedDeals');
  week_start date;
  d date;
begin
  me := scorecard.who(p_key);
  if p_delta not in (1, -1) then raise exception 'bad_delta'; end if;
  -- The page sends its own date so taps land on the rep's local day; it can't be far off.
  if p_today is null or abs(p_today - (now() at time zone 'utc')::date) > 1 then raise exception 'bad_day'; end if;
  if closer_metric and not ('closer' = any (me.roles)) then raise exception 'bad_metric'; end if;
  if not closer_metric and not ('setter' = any (me.roles)) then raise exception 'bad_metric'; end if;

  if p_delta = 1 then
    insert into scorecard.counts as c (person_id, day, metric, n) values (me.id, p_today, p_metric, 1)
    on conflict (person_id, day, metric) do update set n = c.n + 1;
    return true;
  end if;

  week_start := p_today - (extract(isodow from p_today)::integer - 1);
  select c.day into d from scorecard.counts c
  where c.person_id = me.id and c.metric = p_metric and c.day between week_start and week_start + 6
  order by c.day desc limit 1 for update;
  if not found then return false; end if;

  delete from scorecard.counts c where c.person_id = me.id and c.day = d and c.metric = p_metric and c.n = 1;
  if not found then
    update scorecard.counts c set n = c.n - 1 where c.person_id = me.id and c.day = d and c.metric = p_metric;
  end if;
  return true;
end $$;

-- What the counter uses now: a plus or minus on one of the last 7 days (today and the
-- 6 before it), landing on exactly p_day. Anything older stays locked. sc_bump above
-- stays for any page still running an older copy.
create or replace function public.sc_bump_day(p_key text, p_metric text, p_delta integer, p_day date, p_today date) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  me scorecard.people;
  closer_metric boolean := p_metric in ('closerSat', 'censuses', 'signedDeals');
begin
  me := scorecard.who(p_key);
  if p_delta not in (1, -1) then raise exception 'bad_delta'; end if;
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

-- A person ticks Setter, Closer or both for themselves.
create or replace function public.sc_set_roles(p_key text, p_roles text[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me scorecard.people;
begin
  me := scorecard.who(p_key);
  update scorecard.people set roles = p_roles where id = me.id;
end $$;

-- ---------- Team admin (managers only) ----------

-- Adds a person and returns their key once. Only its hash is kept.
create or replace function public.sc_add_person(p_key text, p_name text, p_roles text[], p_admin boolean) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare k text := scorecard.new_key(); new_id uuid;
begin
  perform scorecard.admin(p_key);
  insert into scorecard.people (name, roles, is_admin, key_hash)
  values (btrim(p_name), p_roles, coalesce(p_admin, false), scorecard.hash_key(k))
  returning id into new_id;
  return json_build_object('id', new_id, 'key', k);
end $$;

-- Replaces a person's link (the old one stops working) and turns them back on.
create or replace function public.sc_new_link(p_key text, p_person uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare k text := scorecard.new_key();
begin
  perform scorecard.admin(p_key);
  update scorecard.people set key_hash = scorecard.hash_key(k), active = true where id = p_person;
  if not found then raise exception 'no_person'; end if;
  return k;
end $$;

-- Stops a person's link from working. Their past numbers stay in the totals.
create or replace function public.sc_turn_off(p_key text, p_person uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me scorecard.people;
begin
  me := scorecard.admin(p_key);
  if p_person = me.id then raise exception 'not_yourself'; end if;
  update scorecard.people set active = false, key_hash = null where id = p_person;
end $$;

-- Only the page's functions are callable from outside, and only with a valid key.
revoke all on all functions in schema scorecard from public, anon, authenticated;
revoke all on function public.sc_data(text), public.sc_bump(text, text, integer, date), public.sc_bump_day(text, text, integer, date, date),
  public.sc_set_roles(text, text[]), public.sc_add_person(text, text, text[], boolean), public.sc_new_link(text, uuid), public.sc_turn_off(text, uuid) from public;
grant execute on function public.sc_data(text), public.sc_bump(text, text, integer, date), public.sc_bump_day(text, text, integer, date, date),
  public.sc_set_roles(text, text[]), public.sc_add_person(text, text, text[], boolean), public.sc_new_link(text, uuid), public.sc_turn_off(text, uuid) to anon, authenticated;
