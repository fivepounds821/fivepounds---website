create table if not exists public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  category text not null check (category in (
    'Ingredients & Materials',
    'Packaging',
    'Delivery & Transport',
    'Marketing & Promotion',
    'Equipment & Tools',
    'Utilities & Bills',
    'Other'
  )),
  description text not null check (char_length(trim(description)) between 1 and 240),
  vendor text check (vendor is null or char_length(vendor) <= 120),
  amount numeric(10,2) not null check (amount > 0),
  payment_method text not null default 'Other' check (payment_method in (
    'Cash', 'Bank Transfer', 'E-wallet', 'Card', 'Other'
  )),
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_expenses_expense_date_idx
  on public.finance_expenses (expense_date desc, created_at desc);
create index if not exists finance_expenses_category_idx
  on public.finance_expenses (category);

alter table public.finance_expenses enable row level security;
revoke all on table public.finance_expenses from public, anon, authenticated;
grant select, insert, update, delete on table public.finance_expenses to service_role;
