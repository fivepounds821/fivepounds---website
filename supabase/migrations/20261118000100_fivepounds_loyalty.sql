-- FIVEPOUNDS customer records and Sweet Circle loyalty ledger
-- Apply through the Supabase SQL editor or Supabase migrations.

create extension if not exists pgcrypto;

create sequence if not exists public.fivepounds_order_ref_seq;

create or replace function public.make_fivepounds_order_number()
returns text
language sql
volatile
set search_path = public
as $$
  select
    'FP-' ||
    to_char(clock_timestamp() at time zone 'Asia/Kuala_Lumpur', 'YYMMDD') ||
    '-' ||
    lpad(nextval('public.fivepounds_order_ref_seq')::text, 4, '0');
$$;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  display_name text not null,
  rewards_opt_in boolean not null default false,
  rewards_consent_at timestamptz,
  marketing_opt_in boolean not null default false,
  marketing_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default public.make_fivepounds_order_number(),
  customer_id uuid not null references public.customers(id),
  customer_name text not null,
  customer_phone text not null,
  preferred_date date not null,
  preferred_time text not null,
  fulfillment_method text not null check (fulfillment_method in ('Self Collection', 'Grab Express')),
  collection_point text,
  delivery_address text,
  notes text,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  item_count integer not null check (item_count > 0),
  subtotal numeric(10,2) not null check (subtotal > 0),
  discount numeric(10,2) not null default 0 check (discount >= 0 and discount <= subtotal),
  amount_due numeric(10,2) not null check (amount_due >= 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled')),
  paid boolean not null default false,
  paid_at timestamptz,
  rewards_opt_in_at_order boolean not null default false,
  marketing_opt_in_at_order boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (fulfillment_method = 'Self Collection'
      and collection_point in ('Sin Chooi Hong Kopitiam', 'Taman Pulasan')
      and delivery_address is null)
    or
    (fulfillment_method = 'Grab Express'
      and collection_point is null
      and length(coalesce(delivery_address, '')) >= 8)
  )
);

create index if not exists orders_customer_created_idx
  on public.orders(customer_id, created_at desc);
create index if not exists orders_status_created_idx
  on public.orders(status, created_at desc);
create index if not exists orders_customer_phone_idx
  on public.orders(customer_phone);

create table if not exists public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  order_id uuid not null references public.orders(id),
  transaction_type text not null check (transaction_type in ('earned', 'redeemed')),
  stamps_delta integer not null check (stamps_delta in (-5, 1)),
  description text not null,
  created_at timestamptz not null default now(),
  unique(order_id, transaction_type)
);

create index if not exists loyalty_customer_created_idx
  on public.loyalty_transactions(customer_id, created_at desc);

-- Email allowlist for the private admin page. Add the owner's verified email after setup.
create table if not exists public.admin_allowlist (
  email text primary key,
  created_at timestamptz not null default now()
);

-- A customer earns one stamp only when an opted-in order becomes both paid and completed.
-- The unique constraint makes this idempotent if an admin repeats the action.
create or replace function public.award_fivepounds_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'completed'
     and new.paid = true
     and new.rewards_opt_in_at_order = true then
    insert into public.loyalty_transactions (
      customer_id, order_id, transaction_type, stamps_delta, description
    )
    values (
      new.customer_id, new.id, 'earned', 1, 'Completed and paid order'
    )
    on conflict (order_id, transaction_type) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_award_fivepounds_stamp on public.orders;
create trigger trg_award_fivepounds_stamp
after insert or update of status, paid on public.orders
for each row
execute function public.award_fivepounds_stamp();

-- Used by the public order Edge Function only (service role).
-- Product prices are verified in the Edge Function before reaching this RPC.
create or replace function public.create_fivepounds_web_order(
  p_name text,
  p_phone text,
  p_preferred_date date,
  p_preferred_time text,
  p_fulfillment_method text,
  p_collection_point text,
  p_delivery_address text,
  p_notes text,
  p_items jsonb,
  p_item_count integer,
  p_subtotal numeric,
  p_rewards_opt_in boolean,
  p_marketing_opt_in boolean
)
returns table(order_id uuid, order_number text, amount_due numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_rewards_opt_in boolean;
  v_marketing_opt_in boolean;
  v_order_id uuid;
  v_order_number text;
begin
  if length(trim(coalesce(p_name, ''))) < 2 or length(p_name) > 80 then
    raise exception 'Please enter a valid name';
  end if;

  if length(trim(coalesce(p_phone, ''))) < 9 or length(p_phone) > 18 then
    raise exception 'Please enter a valid Malaysian phone number';
  end if;

  if p_preferred_date < (now() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'The preferred date cannot be in the past';
  end if;

  if extract(dow from p_preferred_date) not in (0, 6) then
    raise exception 'FIVEPOUNDS accepts Saturday and Sunday orders only';
  end if;

  if p_fulfillment_method not in ('Self Collection', 'Grab Express') then
    raise exception 'Invalid collection method';
  end if;

  if p_fulfillment_method = 'Self Collection'
     and p_collection_point not in ('Sin Chooi Hong Kopitiam', 'Taman Pulasan') then
    raise exception 'Please choose a valid collection point';
  end if;

  if p_fulfillment_method = 'Grab Express'
     and length(trim(coalesce(p_delivery_address, ''))) < 8 then
    raise exception 'Please enter a complete delivery address';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Please add at least one dessert';
  end if;

  insert into public.customers (
    phone, display_name, rewards_opt_in, rewards_consent_at,
    marketing_opt_in, marketing_consent_at
  )
  values (
    p_phone, trim(p_name), coalesce(p_rewards_opt_in, false),
    case when coalesce(p_rewards_opt_in, false) then now() else null end,
    coalesce(p_marketing_opt_in, false),
    case when coalesce(p_marketing_opt_in, false) then now() else null end
  )
  on conflict (phone) do update set
    display_name = excluded.display_name,
    rewards_opt_in = public.customers.rewards_opt_in or excluded.rewards_opt_in,
    rewards_consent_at = case
      when not public.customers.rewards_opt_in and excluded.rewards_opt_in then now()
      else public.customers.rewards_consent_at end,
    marketing_opt_in = public.customers.marketing_opt_in or excluded.marketing_opt_in,
    marketing_consent_at = case
      when not public.customers.marketing_opt_in and excluded.marketing_opt_in then now()
      else public.customers.marketing_consent_at end,
    updated_at = now()
  returning id, rewards_opt_in, marketing_opt_in
  into v_customer_id, v_rewards_opt_in, v_marketing_opt_in;

  insert into public.orders (
    customer_id, customer_name, customer_phone,
    preferred_date, preferred_time, fulfillment_method,
    collection_point, delivery_address, notes,
    items, item_count, subtotal, discount, amount_due,
    rewards_opt_in_at_order, marketing_opt_in_at_order
  )
  values (
    v_customer_id, trim(p_name), p_phone,
    p_preferred_date, p_preferred_time, p_fulfillment_method,
    case when p_fulfillment_method = 'Self Collection' then p_collection_point else null end,
    case when p_fulfillment_method = 'Grab Express' then trim(p_delivery_address) else null end,
    nullif(trim(coalesce(p_notes, '')), ''),
    p_items, p_item_count, p_subtotal, 0, p_subtotal,
    v_rewards_opt_in, v_marketing_opt_in
  )
  returning id, orders.order_number into v_order_id, v_order_number;

  return query select v_order_id, v_order_number, p_subtotal;
end;
$$;

-- The admin applies RM5 off a qualifying order only when at least five stamps exist.
create or replace function public.redeem_fivepounds_reward(p_order_id uuid)
returns table(order_id uuid, order_number text, discount numeric, amount_due numeric, stamps_balance integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_balance integer;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;
  if v_order.status not in ('pending', 'confirmed') then
    raise exception 'Reward can only be applied before preparation';
  end if;
  if v_order.subtotal < 40 then
    raise exception 'RM40 minimum subtotal required';
  end if;
  if v_order.discount > 0 then
    raise exception 'A discount has already been applied';
  end if;

  select coalesce(sum(stamps_delta), 0)::integer into v_balance
  from public.loyalty_transactions
  where customer_id = v_order.customer_id;

  if v_balance < 5 then raise exception 'At least five stamps are required'; end if;

  insert into public.loyalty_transactions (
    customer_id, order_id, transaction_type, stamps_delta, description
  )
  values (
    v_order.customer_id, v_order.id, 'redeemed', -5, 'RM5 reward redeemed on RM40+ order'
  );

  update public.orders
  set discount = 5, amount_due = subtotal - 5, updated_at = now()
  where id = v_order.id;

  select coalesce(sum(stamps_delta), 0)::integer into v_balance
  from public.loyalty_transactions
  where customer_id = v_order.customer_id;

  return query
  select v_order.id, v_order.order_number, 5::numeric,
         v_order.subtotal - 5, v_balance;
end;
$$;

-- The view is accessed only by a service-role Edge Function after admin authentication.
create or replace view public.customer_summary as
select
  c.id,
  c.display_name,
  c.phone,
  c.rewards_opt_in,
  c.marketing_opt_in,
  c.created_at,
  coalesce(o.completed_paid_orders, 0)::integer as completed_paid_orders,
  coalesce(o.lifetime_spend, 0)::numeric(10,2) as lifetime_spend,
  o.first_order_at,
  o.last_order_at,
  coalesce(l.stamps_balance, 0)::integer as stamps_balance
from public.customers c
left join lateral (
  select
    count(*) filter (where status = 'completed' and paid) as completed_paid_orders,
    sum(amount_due) filter (where status = 'completed' and paid) as lifetime_spend,
    min(created_at) filter (where status = 'completed' and paid) as first_order_at,
    max(created_at) filter (where status = 'completed' and paid) as last_order_at
  from public.orders
  where customer_id = c.id
) o on true
left join lateral (
  select sum(stamps_delta) as stamps_balance
  from public.loyalty_transactions
  where customer_id = c.id
) l on true;

-- No browser-side table access. All writes/reads go through server-side Edge Functions.
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.loyalty_transactions enable row level security;
alter table public.admin_allowlist enable row level security;

revoke all on public.customers from anon, authenticated;
revoke all on public.orders from anon, authenticated;
revoke all on public.loyalty_transactions from anon, authenticated;
revoke all on public.admin_allowlist from anon, authenticated;
revoke all on public.customer_summary from anon, authenticated;

revoke all on function public.create_fivepounds_web_order(text,text,date,text,text,text,text,text,jsonb,integer,numeric,boolean,boolean) from public, anon, authenticated;
grant execute on function public.create_fivepounds_web_order(text,text,date,text,text,text,text,text,jsonb,integer,numeric,boolean,boolean) to service_role;

revoke all on function public.redeem_fivepounds_reward(uuid) from public, anon, authenticated;
grant execute on function public.redeem_fivepounds_reward(uuid) to service_role;
