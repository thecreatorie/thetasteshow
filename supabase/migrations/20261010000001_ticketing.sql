-- TASTE The Show — ticketing schema
-- Shows, ticket types, orders and individual tickets with unique door codes.

create extension if not exists pgcrypto with schema extensions;

-- ── Tables ─────────────────────────────────────────────────────────────

create table public.shows (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'TASTE The Show',
  starts_at   timestamptz not null,
  doors_at    timestamptz,
  ends_at     timestamptz,
  venue       text not null default 'Gipsy Nightclub',
  address     text not null default '4605 Paradise Rd, Las Vegas, NV 89169',
  on_sale     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.ticket_types (
  id           uuid primary key default gen_random_uuid(),
  show_id      uuid not null references public.shows(id) on delete cascade,
  name         text not null,
  description  text not null default '',
  price_cents  integer not null check (price_cents >= 0),
  admits       integer not null default 1 check (admits between 1 and 20),
  capacity     integer not null check (capacity >= 0),
  max_per_order integer not null default 10 check (max_per_order >= 1),
  sort         integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index on public.ticket_types (show_id);

create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  show_id            uuid not null references public.shows(id),
  buyer_name         text not null,
  buyer_email        text not null,
  buyer_phone        text not null default '',
  status             text not null default 'pending'
                       check (status in ('pending', 'paid', 'comp', 'expired', 'refunded')),
  amount_cents       integer not null default 0,
  stripe_session_id  text unique,
  note               text not null default '',
  expires_at         timestamptz,
  paid_at            timestamptz,
  emailed_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index on public.orders (show_id, status);

create table public.order_items (
  order_id          uuid not null references public.orders(id) on delete cascade,
  ticket_type_id    uuid not null references public.ticket_types(id),
  quantity          integer not null check (quantity > 0),
  unit_price_cents  integer not null,
  primary key (order_id, ticket_type_id)
);
create index on public.order_items (ticket_type_id);

create table public.tickets (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  order_id        uuid not null references public.orders(id) on delete cascade,
  show_id         uuid not null references public.shows(id),
  ticket_type_id  uuid not null references public.ticket_types(id),
  holder_name     text not null,
  label           text not null default '',
  voided          boolean not null default false,
  checked_in_at   timestamptz,
  created_at      timestamptz not null default now()
);
create index on public.tickets (show_id);
create index on public.tickets (order_id);

-- Staff password (bcrypt hash). Only reachable through the functions below.
create table public.app_settings (
  key    text primary key,
  value  text not null
);

-- ── Row level security ────────────────────────────────────────────────
-- The public website may read shows and ticket types. Everything else is
-- only reachable through the Edge Functions (service role).

alter table public.shows        enable row level security;
alter table public.ticket_types enable row level security;
alter table public.orders       enable row level security;
alter table public.order_items  enable row level security;
alter table public.tickets      enable row level security;
alter table public.app_settings enable row level security;

create policy "Public can view shows on sale"
  on public.shows for select to anon, authenticated
  using (on_sale);

create policy "Public can view active ticket types"
  on public.ticket_types for select to anon, authenticated
  using (active and exists (select 1 from public.shows s where s.id = show_id and s.on_sale));

-- ── Helpers ───────────────────────────────────────────────────────────

-- Seats taken: paid + comp orders, plus checkouts still in progress.
create or replace function public.ticket_type_sold(p_ticket_type_id uuid)
returns integer
language sql stable
set search_path = ''
as $$
  select coalesce(sum(oi.quantity), 0)::int
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.ticket_type_id = p_ticket_type_id
    and (o.status in ('paid', 'comp')
         or (o.status = 'pending' and o.expires_at > now()));
$$;

-- Public: remaining availability for every ticket type of on-sale shows.
create or replace function public.get_availability()
returns table (ticket_type_id uuid, remaining integer)
language sql stable security definer
set search_path = ''
as $$
  select tt.id, greatest(tt.capacity - public.ticket_type_sold(tt.id), 0)
  from public.ticket_types tt
  join public.shows s on s.id = tt.show_id
  where s.on_sale and tt.active;
$$;

-- Unique, hard-to-guess door code like TST-7KQ4-M9XP (no 0/O/1/I).
create or replace function public.new_ticket_code()
returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  v_code text;
begin
  loop
    bytes := extensions.gen_random_bytes(8);
    v_code := 'TST-';
    for i in 0..7 loop
      if i = 4 then v_code := v_code || '-'; end if;
      v_code := v_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.tickets t where t.code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Atomically check capacity and create a pending order (or a comp order).
-- p_items: [{"ticket_type_id": "...", "quantity": 2}, ...]
create or replace function public.create_order(
  p_show_id uuid,
  p_items jsonb,
  p_name text,
  p_email text,
  p_phone text default '',
  p_comp boolean default false,
  p_note text default '',
  p_hold_minutes integer default 31
)
returns uuid
language plpgsql volatile
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_tt public.ticket_types%rowtype;
  v_qty integer;
  v_total integer := 0;
  v_count integer := 0;
begin
  if not exists (select 1 from public.shows where id = p_show_id and (on_sale or p_comp)) then
    raise exception 'show_not_on_sale';
  end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_email), '') = '' then
    raise exception 'missing_buyer';
  end if;

  insert into public.orders (show_id, buyer_name, buyer_email, buyer_phone, status, note, expires_at, paid_at)
  values (p_show_id, trim(p_name), lower(trim(p_email)), coalesce(trim(p_phone), ''),
          case when p_comp then 'comp' else 'pending' end,
          coalesce(p_note, ''),
          case when p_comp then null else now() + make_interval(mins => p_hold_minutes) end,
          case when p_comp then now() else null end)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::int;
    continue when v_qty is null or v_qty <= 0;

    -- Lock the ticket type row so two buyers can't grab the last seat.
    select * into v_tt from public.ticket_types
      where id = (v_item->>'ticket_type_id')::uuid and show_id = p_show_id
      for update;
    if not found or (not v_tt.active and not p_comp) then
      raise exception 'invalid_ticket_type';
    end if;
    if not p_comp and v_qty > v_tt.max_per_order then
      raise exception 'too_many:%', v_tt.name;
    end if;
    if public.ticket_type_sold(v_tt.id) + v_qty > v_tt.capacity then
      raise exception 'sold_out:%', v_tt.name;
    end if;

    insert into public.order_items (order_id, ticket_type_id, quantity, unit_price_cents)
    values (v_order_id, v_tt.id, v_qty, case when p_comp then 0 else v_tt.price_cents end);
    v_total := v_total + v_qty * (case when p_comp then 0 else v_tt.price_cents end);
    v_count := v_count + v_qty;
  end loop;

  if v_count = 0 then
    raise exception 'empty_order';
  end if;

  update public.orders set amount_cents = v_total where id = v_order_id;
  if p_comp then
    perform public.issue_tickets(v_order_id);
  end if;
  return v_order_id;
end;
$$;

-- Create one ticket (one QR code) per person admitted. Idempotent.
create or replace function public.issue_tickets(p_order_id uuid)
returns void
language plpgsql volatile
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  n integer;
  g integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or exists (select 1 from public.tickets where order_id = p_order_id) then
    return;
  end if;
  for v_item in
    select oi.quantity, tt.id as tt_id, tt.name, tt.admits
    from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id
    where oi.order_id = p_order_id order by tt.sort
  loop
    for n in 1..v_item.quantity loop
      for g in 1..v_item.admits loop
        insert into public.tickets (code, order_id, show_id, ticket_type_id, holder_name, label)
        values (public.new_ticket_code(), p_order_id, v_order.show_id, v_item.tt_id, v_order.buyer_name,
                v_item.name ||
                case when v_item.quantity > 1 then ' #' || n else '' end ||
                case when v_item.admits > 1 then ' · Guest ' || g || ' of ' || v_item.admits else '' end);
      end loop;
    end loop;
  end loop;
end;
$$;

-- Mark an order paid (from Stripe) and issue its tickets. Idempotent.
create or replace function public.mark_order_paid(p_order_id uuid, p_amount_cents integer default null)
returns void
language plpgsql volatile
set search_path = ''
as $$
begin
  update public.orders
     set status = 'paid',
         paid_at = coalesce(paid_at, now()),
         amount_cents = coalesce(p_amount_cents, amount_cents)
   where id = p_order_id and status in ('pending', 'expired');
  if exists (select 1 from public.orders where id = p_order_id and status in ('paid', 'comp')) then
    perform public.issue_tickets(p_order_id);
  end if;
end;
$$;

-- Door check-in. Returns what the door staff should see.
create or replace function public.check_in(p_code text, p_undo boolean default false)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v record;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
begin
  if v_code !~ '^TST-' and length(v_code) = 8 then
    v_code := 'TST-' || substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
  end if;

  select t.id, t.code, t.holder_name, t.label, t.voided, t.checked_in_at,
         o.status as order_status, o.buyer_email, tt.name as ticket_type,
         s.starts_at, s.title
    into v
    from public.tickets t
    join public.orders o on o.id = t.order_id
    join public.ticket_types tt on tt.id = t.ticket_type_id
    join public.shows s on s.id = t.show_id
   where t.code = v_code
   for update of t;

  if not found then
    return jsonb_build_object('result', 'not_found', 'code', v_code);
  end if;

  if v.voided or v.order_status not in ('paid', 'comp') then
    return jsonb_build_object('result', 'invalid', 'code', v.code, 'holder_name', v.holder_name,
                              'label', v.label, 'reason', case when v.voided then 'voided' else v.order_status end);
  end if;

  if p_undo then
    update public.tickets set checked_in_at = null where id = v.id;
    return jsonb_build_object('result', 'undone', 'code', v.code, 'holder_name', v.holder_name, 'label', v.label);
  end if;

  if v.checked_in_at is not null then
    return jsonb_build_object('result', 'already_used', 'code', v.code, 'holder_name', v.holder_name,
                              'label', v.label, 'ticket_type', v.ticket_type, 'checked_in_at', v.checked_in_at,
                              'show_starts_at', v.starts_at);
  end if;

  update public.tickets set checked_in_at = now() where id = v.id;
  return jsonb_build_object('result', 'ok', 'code', v.code, 'holder_name', v.holder_name, 'label', v.label,
                            'ticket_type', v.ticket_type, 'show_starts_at', v.starts_at);
end;
$$;

create or replace function public.set_staff_password(p_password text)
returns void
language sql volatile
set search_path = ''
as $$
  insert into public.app_settings (key, value)
  values ('staff_password_hash', extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  on conflict (key) do update set value = excluded.value;
$$;

create or replace function public.check_staff_password(p_password text)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from public.app_settings
    where key = 'staff_password_hash'
      and value = extensions.crypt(coalesce(p_password, ''), value)
  );
$$;

-- Only the server (service role) may call the write/staff functions.
revoke execute on function public.create_order(uuid, jsonb, text, text, text, boolean, text, integer) from public, anon, authenticated;
revoke execute on function public.issue_tickets(uuid)            from public, anon, authenticated;
revoke execute on function public.mark_order_paid(uuid, integer) from public, anon, authenticated;
revoke execute on function public.check_in(text, boolean)        from public, anon, authenticated;
revoke execute on function public.set_staff_password(text)       from public, anon, authenticated;
revoke execute on function public.check_staff_password(text)     from public, anon, authenticated;
revoke execute on function public.new_ticket_code()              from public, anon, authenticated;
revoke execute on function public.ticket_type_sold(uuid)         from public, anon, authenticated;
grant  execute on function public.get_availability()             to anon, authenticated;
