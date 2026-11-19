create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  variant text not null default '' check (char_length(variant) <= 80),
  category text not null default 'Other' check (char_length(category) <= 80),
  description text check (description is null or char_length(description) <= 1000),
  selling_price numeric(10,2) not null check (selling_price > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists products_name_variant_unique_idx
  on public.products (lower(name), lower(variant));
create index if not exists products_active_name_idx
  on public.products (active, name);

create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) between 1 and 120),
  category text not null default 'Other' check (char_length(category) <= 80),
  base_unit text not null check (base_unit in ('g', 'ml', 'pcs')),
  purchase_pack_quantity numeric(12,3) not null check (purchase_pack_quantity > 0),
  purchase_pack_unit text not null check (purchase_pack_unit in ('g', 'kg', 'ml', 'L', 'pcs')),
  purchase_price numeric(10,2) not null check (purchase_price > 0),
  normalized_pack_quantity numeric(15,3)
    generated always as (
      purchase_pack_quantity *
      case when purchase_pack_unit in ('kg', 'L') then 1000::numeric else 1::numeric end
    ) stored,
  unit_cost_per_base_unit numeric(14,6)
    generated always as (
      purchase_price /
      nullif(
        purchase_pack_quantity *
        case when purchase_pack_unit in ('kg', 'L') then 1000::numeric else 1::numeric end,
        0
      )
    ) stored,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingredients_compatible_units check (
    (base_unit = 'g' and purchase_pack_unit in ('g', 'kg')) or
    (base_unit = 'ml' and purchase_pack_unit in ('ml', 'L')) or
    (base_unit = 'pcs' and purchase_pack_unit = 'pcs')
  )
);

create index if not exists ingredients_active_name_idx
  on public.ingredients (active, name);

create table if not exists public.product_recipe_items (
  product_id uuid not null references public.products(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity numeric(12,3) not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, ingredient_id)
);
create index if not exists product_recipe_items_ingredient_id_idx
  on public.product_recipe_items (ingredient_id);

alter table public.products enable row level security;
alter table public.ingredients enable row level security;
alter table public.product_recipe_items enable row level security;

revoke all on table public.products, public.ingredients, public.product_recipe_items from public, anon, authenticated;
grant select, insert, update, delete on table public.products, public.ingredients, public.product_recipe_items to service_role;

create or replace function public.replace_product_recipe(p_product_id uuid, p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_count integer;
begin
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Recipe items must be an array';
  end if;

  delete from public.product_recipe_items where product_id = p_product_id;

  insert into public.product_recipe_items (product_id, ingredient_id, quantity)
  select p_product_id, item.ingredient_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ingredient_id uuid, quantity numeric);

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.replace_product_recipe(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_product_recipe(uuid, jsonb) to service_role;
