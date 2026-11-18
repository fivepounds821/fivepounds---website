-- FIVEPOUNDS automatic order and Sweet Circle ledger
-- Tables are private to server-side Edge Functions. Never expose a service/secret key in browser code.

create extension if not exists pgcrypto;

create sequence if not exists public.fivepounds_order_ref_seq;

create or replace function public.make_fivepounds_order_number()
returns text
language sql
volatile
set search_path = ''
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
  preferred_date date not null check (extract(isodow from preferred_date) in (6, 7)),
  preferred_time text not null,
  fulfillment_method text not null check (fulfillment_method in ('Self Collection', 'Grab Express')),
  collection_point text,
  delivery_address text,
  notes text,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  item_count integer not null check (item_count > 0),
  subtotal numeric(10,2) not null check (subtotal > 0),
  discount numeric(10,2) not null default 0 check (discount >= 0 and discount <= subtotal),
  amount_due numeric(10,2) not null check (amount_due = subtotal - discount),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled')),
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
  ),
  check (paid = (paid_at is not null))
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

-- Only the owner's verified Supabase Auth email is placed in this allowlist.
create table if not exists public.admin_allowlist (
  email text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- Trigger is idempotent: the unique (order_id, transaction_type) prevents duplicate stamps.
-- It runs as the role changing the order (the server-side service role), not as a definer.
create or replace function public.award_fivepounds_stamp()
returns trigger
language plpgsql
security invoker
set search_path = ''
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

-- Redeem one RM5 reward on an order with a subtotal >= RM40.
-- Advisory lock serializes redemptions for the same customer across different orders.
-- This function is invoker-rights and is granted only to the server-side service role.
create or replace function public.redeem_fivepounds_reward(p_order_id uuid)
returns table(
  order_id uuid,
  order_number text,
  discount numeric,
  amount_due numeric,
  stamps_balance integer
)
language plpgsql
security invoker
set search_path = ''
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

  perform pg_advisory_xact_lock(hashtextextended(v_order.customer_id::text, 0));

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
    v_order.customer_id, v_order.id, 'redeemed', -5,
    'RM5 reward redeemed on RM40+ order'
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

-- security_invoker ensures the view obeys the underlying table grants and RLS.
create or replace view public.customer_summary
with (security_invoker = true)
as
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

-- No anon or customer-browser table access. Website access is only through server Edge Functions.
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.loyalty_transactions enable row level security;
alter table public.admin_allowlist enable row level security;

revoke all on public.customers from public, anon, authenticated;
revoke all on public.orders from public, anon, authenticated;
revoke all on public.loyalty_transactions from public, anon, authenticated;
revoke all on public.admin_allowlist from public, anon, authenticated;
revoke all on public.customer_summary from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update on public.customers to service_role;
grant select, insert, update on public.orders to service_role;
grant select, insert on public.loyalty_transactions to service_role;
grant select, insert, update, delete on public.admin_allowlist to service_role;
grant select on public.customer_summary to service_role;
grant usage, select on sequence public.fivepounds_order_ref_seq to service_role;

revoke all on function public.make_fivepounds_order_number() from public, anon, authenticated;
grant execute on function public.make_fivepounds_order_number() to service_role;

revoke all on function public.award_fivepounds_stamp() from public, anon, authenticated;
grant execute on function public.award_fivepounds_stamp() to service_role;

revoke all on function public.redeem_fivepounds_reward(uuid) from public, anon, authenticated;
grant execute on function public.redeem_fivepounds_reward(uuid) to service_role;
