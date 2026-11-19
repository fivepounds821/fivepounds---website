create table if not exists public.coffee_shop_daily_sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  sales_date date not null,
  quantity_sold integer not null check (quantity_sold between 1 and 10000),
  unit_price numeric(10,2) not null check (unit_price = 9.90),
  channel text not null default 'coffee_shop' check (channel = 'coffee_shop'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coffee_shop_daily_sales_weekend_only check (extract(isodow from sales_date) in (5,6,7)),
  constraint coffee_shop_daily_sales_product_date_channel_unique unique (product_id, sales_date, channel)
);

create index if not exists coffee_shop_daily_sales_date_idx
  on public.coffee_shop_daily_sales (sales_date desc);

alter table public.coffee_shop_daily_sales enable row level security;
revoke all on public.coffee_shop_daily_sales from anon, authenticated;
grant all on public.coffee_shop_daily_sales to service_role;
