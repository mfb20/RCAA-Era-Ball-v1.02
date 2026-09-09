-- RCAA ERA BALL v1.02 multiplayer schema
-- This matches the production schema deployed to project jvvkmzxoqjvtmqcthghg.
-- Anonymous Sign-Ins must be enabled in Supabase Authentication.

create extension if not exists pgcrypto;

create table if not exists public.rcaa_players (
  card_key text primary key,
  season integer not null,
  team_code text not null,
  player_name text not null,
  adp numeric(5,1) not null,
  player_data jsonb not null
);

create table if not exists public.lobbies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 1 and 32),
  mode text not null check (mode in ('duel', 'fantasy')),
  host_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'drafting', 'lineup', 'simulating', 'complete')),
  max_players integer not null check (max_players in (2, 4)),
  draft_order uuid[] not null default '{}',
  current_pick integer not null default 0,
  season_results jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lobby_players (
  lobby_id uuid not null references public.lobbies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  team_name text not null check (char_length(team_name) between 1 and 24),
  seat integer not null,
  ready boolean not null default false,
  progress integer not null default 0,
  roster jsonb not null default '[]',
  lineup jsonb not null default '{}',
  team_ovr numeric(5,1),
  joined_at timestamptz not null default now(),
  primary key (lobby_id, user_id),
  unique (lobby_id, seat)
);

create table if not exists public.fantasy_picks (
  id bigint generated always as identity primary key,
  lobby_id uuid not null references public.lobbies(id) on delete cascade,
  pick_number integer not null,
  round_number integer not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_key text not null references public.rcaa_players(card_key),
  player_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (lobby_id, pick_number),
  unique (lobby_id, card_key)
);

create index if not exists lobbies_status_idx on public.lobbies(status, created_at desc);
create index if not exists lobby_players_lobby_idx on public.lobby_players(lobby_id);
create index if not exists fantasy_picks_lobby_idx on public.fantasy_picks(lobby_id, pick_number);
create index if not exists fantasy_picks_card_key_idx on public.fantasy_picks(card_key);
create index if not exists fantasy_picks_user_id_idx on public.fantasy_picks(user_id);
create index if not exists lobbies_host_id_idx on public.lobbies(host_id);
create index if not exists lobby_players_user_id_idx on public.lobby_players(user_id);

create or replace function public.set_reb_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists lobbies_set_updated_at on public.lobbies;
create trigger lobbies_set_updated_at
before update on public.lobbies
for each row execute function public.set_reb_updated_at();

alter table public.rcaa_players enable row level security;
alter table public.lobbies enable row level security;
alter table public.lobby_players enable row level security;
alter table public.fantasy_picks enable row level security;

drop policy if exists "authenticated read player catalog" on public.rcaa_players;
create policy "authenticated read player catalog" on public.rcaa_players
for select to authenticated using (true);

drop policy if exists "authenticated read lobbies" on public.lobbies;
create policy "authenticated read lobbies" on public.lobbies
for select to authenticated using (true);

drop policy if exists "host updates lobby" on public.lobbies;
create policy "host updates lobby" on public.lobbies
for update to authenticated
using (host_id = (select auth.uid()))
with check (host_id = (select auth.uid()));

drop policy if exists "authenticated read lobby players" on public.lobby_players;
create policy "authenticated read lobby players" on public.lobby_players
for select to authenticated using (true);

drop policy if exists "player updates self" on public.lobby_players;
create policy "player updates self" on public.lobby_players
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "authenticated read fantasy picks" on public.fantasy_picks;
create policy "authenticated read fantasy picks" on public.fantasy_picks
for select to authenticated using (true);

create or replace function public.new_reb_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare result text;
begin
  loop
    result := upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 6));
    exit when not exists (select 1 from public.lobbies where code = result);
  end loop;
  return result;
end;
$$;

create or replace function public.create_reb_lobby(
  p_name text,
  p_mode text,
  p_display_name text,
  p_team_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  player_limit integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_mode not in ('duel', 'fantasy') then raise exception 'Invalid mode'; end if;

  player_limit := case when p_mode = 'duel' then 2 else 4 end;
  insert into public.lobbies (code, name, mode, host_id, max_players)
  values (public.new_reb_code(), left(trim(p_name), 32), p_mode, auth.uid(), player_limit)
  returning id into new_id;

  insert into public.lobby_players (lobby_id, user_id, display_name, team_name, seat)
  values (new_id, auth.uid(), left(trim(p_display_name), 20), left(trim(p_team_name), 24), 1);

  return new_id;
end;
$$;

create or replace function public.join_reb_lobby(
  p_lobby_id uuid,
  p_display_name text,
  p_team_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.lobbies%rowtype;
  current_count integer;
  next_seat integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into target from public.lobbies where id = p_lobby_id for update;
  if target.id is null then raise exception 'Lobby not found'; end if;
  if target.status <> 'waiting' then raise exception 'That lobby has already started'; end if;

  if exists (select 1 from public.lobby_players where lobby_id = target.id and user_id = auth.uid()) then
    update public.lobby_players
    set display_name = left(trim(p_display_name), 20), team_name = left(trim(p_team_name), 24)
    where lobby_id = target.id and user_id = auth.uid();
    return target.id;
  end if;

  select count(*) into current_count from public.lobby_players where lobby_id = target.id;
  if current_count >= target.max_players then raise exception 'Lobby is full'; end if;

  select slot into next_seat
  from generate_series(1, target.max_players) as slot
  where not exists (
    select 1 from public.lobby_players p where p.lobby_id = target.id and p.seat = slot
  )
  order by slot limit 1;

  insert into public.lobby_players (lobby_id, user_id, display_name, team_name, seat)
  values (target.id, auth.uid(), left(trim(p_display_name), 20), left(trim(p_team_name), 24), next_seat);
  return target.id;
end;
$$;

create or replace function public.leave_reb_lobby(p_lobby_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_host boolean;
  replacement uuid;
begin
  select host_id = auth.uid() into was_host from public.lobbies where id = p_lobby_id;
  delete from public.lobby_players where lobby_id = p_lobby_id and user_id = auth.uid();

  if not exists (select 1 from public.lobby_players where lobby_id = p_lobby_id) then
    delete from public.lobbies where id = p_lobby_id;
  elsif was_host then
    select user_id into replacement
    from public.lobby_players where lobby_id = p_lobby_id order by seat limit 1;
    update public.lobbies set host_id = replacement where id = p_lobby_id;
  end if;
end;
$$;

create or replace function public.make_fantasy_pick(
  p_lobby_id uuid,
  p_card_key text,
  p_player_snapshot jsonb
)
returns public.fantasy_picks
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.lobbies%rowtype;
  player_count integer;
  round_index integer;
  seat_offset integer;
  expected_index integer;
  expected_user uuid;
  inserted public.fantasy_picks%rowtype;
  total_picks integer;
  offense_rating numeric;
  defense_rating numeric;
  supplied_adp numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_player_snapshot is null or p_player_snapshot->>'id' <> p_card_key then
    raise exception 'Invalid player snapshot';
  end if;

  offense_rating := (p_player_snapshot #>> '{offense,rating}')::numeric;
  defense_rating := (p_player_snapshot #>> '{defense,rating}')::numeric;
  supplied_adp := (p_player_snapshot->>'adp')::numeric;

  if offense_rating is null or defense_rating is null
     or offense_rating < 0 or offense_rating > 100
     or defense_rating < 0 or defense_rating > 100 then
    raise exception 'Invalid player ratings';
  end if;

  if round((offense_rating + defense_rating) / 2, 1) <> round(supplied_adp, 1) then
    raise exception 'Player ADP must equal offense/defense average';
  end if;

  if coalesce(p_player_snapshot->>'name','') = ''
     or coalesce(p_player_snapshot->>'teamCode','') = '' then
    raise exception 'Incomplete player snapshot';
  end if;

  select * into target from public.lobbies where id = p_lobby_id for update;
  if target.id is null or target.mode <> 'fantasy' or target.status <> 'drafting' then
    raise exception 'Draft is not active';
  end if;

  player_count := array_length(target.draft_order, 1);
  if player_count <> 4 then raise exception 'Four players are required'; end if;
  total_picks := player_count * 4;
  if target.current_pick >= total_picks then raise exception 'Draft is complete'; end if;

  round_index := target.current_pick / player_count;
  seat_offset := target.current_pick % player_count;
  expected_index := case
    when round_index % 2 = 0 then seat_offset + 1
    else player_count - seat_offset
  end;
  expected_user := target.draft_order[expected_index];
  if expected_user <> auth.uid() then raise exception 'It is not your turn'; end if;

  insert into public.rcaa_players (card_key, season, team_code, player_name, adp, player_data)
  values (
    p_card_key,
    (p_player_snapshot->>'season')::integer,
    p_player_snapshot->>'teamCode',
    p_player_snapshot->>'name',
    supplied_adp,
    p_player_snapshot
  )
  on conflict (card_key) do nothing;

  insert into public.fantasy_picks
    (lobby_id, pick_number, round_number, user_id, card_key, player_snapshot)
  values
    (target.id, target.current_pick + 1, round_index + 1, auth.uid(), p_card_key, p_player_snapshot)
  returning * into inserted;

  update public.lobbies
  set current_pick = current_pick + 1,
      status = case when current_pick + 1 >= total_picks then 'lineup' else status end
  where id = target.id;

  return inserted;
end;
$$;

revoke all on public.rcaa_players, public.lobbies, public.lobby_players, public.fantasy_picks from anon;
revoke insert, delete on public.lobbies, public.lobby_players, public.fantasy_picks from authenticated;
grant select on public.rcaa_players, public.lobbies, public.lobby_players, public.fantasy_picks to authenticated;
grant update on public.lobbies, public.lobby_players to authenticated;

revoke execute on function public.set_reb_updated_at() from public, anon, authenticated;
revoke execute on function public.new_reb_code() from public, anon, authenticated;
revoke execute on function public.create_reb_lobby(text, text, text, text) from public, anon;
revoke execute on function public.join_reb_lobby(uuid, text, text) from public, anon;
revoke execute on function public.leave_reb_lobby(uuid) from public, anon;
revoke execute on function public.make_fantasy_pick(uuid, text, jsonb) from public, anon;
grant execute on function public.create_reb_lobby(text, text, text, text) to authenticated;
grant execute on function public.join_reb_lobby(uuid, text, text) to authenticated;
grant execute on function public.leave_reb_lobby(uuid) to authenticated;
grant execute on function public.make_fantasy_pick(uuid, text, jsonb) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lobbies'
  ) then alter publication supabase_realtime add table public.lobbies; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lobby_players'
  ) then alter publication supabase_realtime add table public.lobby_players; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fantasy_picks'
  ) then alter publication supabase_realtime add table public.fantasy_picks; end if;
end $$;

-- The production RCAA-Era-Ball-v1.02 project is already seeded with all 203
-- player snapshots from the v1.02 game data. New deployments should seed
-- rcaa_players from the generated player pool before opening fantasy rooms.
