-- Lucky Five: couple exclusions and safe, retryable gift draws.
-- Run AFTER 001_lucky_five.sql. Existing games and participant names are preserved.

alter table public.lf_players
  add column if not exists partner_player_id uuid references public.lf_players(id);

-- Helper: determine whether the remaining buyers can still be assigned all remaining recipients.
create or replace function public.lf_match_possible(
  p_game_id uuid,
  p_buyers uuid[],
  p_recipients uuid[]
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
  v_recipient uuid;
  v_partner uuid;
  v_next_buyers uuid[];
  v_next_recipients uuid[];
begin
  if coalesce(array_length(p_buyers, 1), 0) = 0 then
    return coalesce(array_length(p_recipients, 1), 0) = 0;
  end if;
  if coalesce(array_length(p_buyers, 1), 0) <> coalesce(array_length(p_recipients, 1), 0) then
    return false;
  end if;

  -- Choose the buyer with the fewest legal remaining options (MRV).
  select b.id into v_buyer
  from unnest(p_buyers) as b(id)
  order by (
    select count(*)
    from unnest(p_recipients) as r(id)
    join public.lf_players bp on bp.id = b.id
    where r.id <> b.id and (bp.partner_player_id is null or r.id <> bp.partner_player_id)
  ) asc
  limit 1;

  select partner_player_id into v_partner from public.lf_players where id = v_buyer and game_id = p_game_id;
  for v_recipient in
    select r.id from unnest(p_recipients) as r(id)
    where r.id <> v_buyer and (v_partner is null or r.id <> v_partner)
  loop
    v_next_buyers := array_remove(p_buyers, v_buyer);
    v_next_recipients := array_remove(p_recipients, v_recipient);
    if public.lf_match_possible(p_game_id, v_next_buyers, v_next_recipients) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- Replace preparation: numbers are assigned, but gift recipients are NOT preassigned.
create or replace function public.lf_prepare_draws(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_players uuid[];
  v_numbers integer[];
  v_count integer;
  i integer;
begin
  select count(*) into v_count from public.lf_players where game_id = p_game_id;
  if v_count <> 5 then raise exception 'Exactly five players are required'; end if;
  select array_agg(id order by random()) into v_players from public.lf_players where game_id = p_game_id;
  select array_agg(n order by random()) into v_numbers
  from (select generate_series(10,99) as n order by random() limit 5) nums;
  for i in 1..5 loop
    update public.lf_players set assigned_number = v_numbers[i], recipient_player_id = null,
      partner_player_id = null, gift_revealed_at = null
    where id = v_players[i];
  end loop;
  update public.lf_games set status = 'ready' where id = p_game_id;
end;
$$;

-- Host chooses two pairs after all five participants have joined.
create or replace function public.lf_set_couples(
  p_admin_token_hash text,
  p_pair1_a uuid,
  p_pair1_b uuid,
  p_pair2_a uuid,
  p_pair2_b uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.lf_games%rowtype;
  v_count integer;
  v_ids uuid[];
begin
  select * into v_game from public.lf_games where admin_token_hash = p_admin_token_hash for update;
  if not found then raise exception 'Admin session not found.'; end if;
  if v_game.status <> 'ready' then raise exception 'Wait until all five players have joined.'; end if;
  if p_pair1_a = p_pair1_b or p_pair2_a = p_pair2_b
     or p_pair1_a = p_pair2_a or p_pair1_a = p_pair2_b
     or p_pair1_b = p_pair2_a or p_pair1_b = p_pair2_b then
    raise exception 'Choose four different people for the two couples.';
  end if;
  select count(*) into v_count from public.lf_players
    where game_id = v_game.id and id in (p_pair1_a,p_pair1_b,p_pair2_a,p_pair2_b);
  if v_count <> 4 then raise exception 'The selected names must belong to this game.'; end if;
  if exists(select 1 from public.lf_players where game_id=v_game.id and gift_revealed_at is not null) then
    raise exception 'Couples cannot be changed after gift draws have started.';
  end if;
  -- Clear any recipients preassigned by the original version before enabling retryable draws.
  update public.lf_players set recipient_player_id = null, partner_player_id = null
    where game_id = v_game.id;
  update public.lf_players set partner_player_id = p_pair1_b where id = p_pair1_a;
  update public.lf_players set partner_player_id = p_pair1_a where id = p_pair1_b;
  update public.lf_players set partner_player_id = p_pair2_b where id = p_pair2_a;
  update public.lf_players set partner_player_id = p_pair2_a where id = p_pair2_b;
  select array_agg(id) into v_ids from public.lf_players where game_id = v_game.id;
  if not public.lf_match_possible(v_game.id, v_ids, v_ids) then
    update public.lf_players set partner_player_id = null where game_id = v_game.id;
    raise exception 'These exclusions do not allow a complete gift exchange.';
  end if;
  return jsonb_build_object('saved', true);
end;
$$;

-- Every attempt is atomic. Invalid attempts never consume a recipient.
create or replace function public.lf_player_action(p_player_token_hash text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.lf_players%rowtype;
  v_game public.lf_games%rowtype;
  v_recipient public.lf_players%rowtype;
  v_players jsonb;
  v_all uuid[];
  v_available uuid[];
  v_buyers uuid[];
  v_candidate uuid;
  v_partner uuid;
  v_count integer;
begin
  select * into v_player from public.lf_players where player_token_hash = p_player_token_hash for update;
  if not found then raise exception 'Your private game session was not found. Rejoin using the invitation link.'; end if;
  select * into v_game from public.lf_games where id = v_player.game_id for update;

  if p_action = 'spin-number' then
    if v_game.status not in ('ready','complete') then raise exception 'Waiting for all five players to join.'; end if;
    update public.lf_players set number_revealed_at = coalesce(number_revealed_at, now())
      where id = v_player.id returning * into v_player;
    return jsonb_build_object('number', v_player.assigned_number);

  elsif p_action = 'spin-gift' then
    if v_game.status not in ('ready','complete') then raise exception 'The gift draw is not ready yet.'; end if;
    if v_player.number_revealed_at is null then raise exception 'Reveal your own number first.'; end if;
    if v_player.recipient_player_id is not null then
      select * into v_recipient from public.lf_players where id = v_player.recipient_player_id;
      return jsonb_build_object('recipient', jsonb_build_object('name',v_recipient.display_name,'number',v_recipient.assigned_number),'already_drawn',true);
    end if;
    if (select count(*) from public.lf_players where game_id=v_game.id and partner_player_id is not null) <> 4 then
      raise exception 'The host must choose both couples before gift spins begin.';
    end if;

    select array_agg(id) into v_available from public.lf_players
      where game_id=v_game.id and not exists (
        select 1 from public.lf_players buyer where buyer.game_id=v_game.id and buyer.recipient_player_id=lf_players.id
      );
    select array_agg(id) into v_buyers from public.lf_players
      where game_id=v_game.id and recipient_player_id is null;

    -- A spin samples from recipients not yet taken. Self/partner hits are rejected without consuming anyone.
    select id into v_candidate from unnest(v_available) as x(id) order by random() limit 1;
    select partner_player_id into v_partner from public.lf_players where id=v_player.id;
    if v_candidate = v_player.id or v_candidate = v_partner then
      return jsonb_build_object('retry',true,'reason','That person is not allowed. Spin again!');
    end if;

    if not public.lf_match_possible(v_game.id, array_remove(v_buyers,v_player.id), array_remove(v_available,v_candidate)) then
      return jsonb_build_object('retry',true,'reason','Try again to keep every remaining draw possible.');
    end if;

    update public.lf_players set recipient_player_id=v_candidate, gift_revealed_at=now()
      where id=v_player.id;
    select * into v_recipient from public.lf_players where id=v_candidate;
    select count(*) into v_count from public.lf_players where game_id=v_game.id and gift_revealed_at is not null;
    if v_count=5 then update public.lf_games set status='complete' where id=v_game.id; end if;
    return jsonb_build_object('recipient',jsonb_build_object('name',v_recipient.display_name,'number',v_recipient.assigned_number));

  elsif p_action = 'status' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.display_name,'is_me',p.id=v_player.id,
      'number_drawn',p.number_revealed_at is not null,'gift_drawn',p.gift_revealed_at is not null
    ) order by p.created_at),'[]'::jsonb) into v_players
      from public.lf_players p where p.game_id=v_game.id;
    if v_player.gift_revealed_at is not null then
      select * into v_recipient from public.lf_players where id=v_player.recipient_player_id;
    end if;
    return jsonb_build_object(
      'status',v_game.status,'players',v_players,
      'my_number',case when v_player.number_revealed_at is not null then to_jsonb(v_player.assigned_number) else 'null'::jsonb end,
      'my_gift',case when v_player.gift_revealed_at is not null then jsonb_build_object('name',v_recipient.display_name,'number',v_recipient.assigned_number) else 'null'::jsonb end,
      'couples_set',(select count(*) from public.lf_players where game_id=v_game.id and partner_player_id is not null)=4
    );
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;

create or replace function public.lf_admin_status(p_admin_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_game public.lf_games%rowtype; v_players jsonb;
begin
  select * into v_game from public.lf_games where admin_token_hash=p_admin_token_hash;
  if not found then raise exception 'Admin session not found.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name,
    'number_drawn',number_revealed_at is not null,'gift_drawn',gift_revealed_at is not null)
    order by created_at),'[]'::jsonb) into v_players
    from public.lf_players where game_id=v_game.id;
  return jsonb_build_object('status',v_game.status,'players',v_players);
end;
$$;

revoke all on function public.lf_match_possible(uuid,uuid[],uuid[]) from public,anon,authenticated;
revoke all on function public.lf_set_couples(text,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.lf_set_couples(text,uuid,uuid,uuid,uuid) to service_role;
revoke all on function public.lf_player_action(text,text) from public,anon,authenticated;
grant execute on function public.lf_player_action(text,text) to service_role;
revoke all on function public.lf_admin_status(text) from public,anon,authenticated;
grant execute on function public.lf_admin_status(text) to service_role;
