-- TestingInstallment schema (no auth)
-- Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/fscrvvxvumkuzhmmydpn/sql/new

create extension if not exists "pgcrypto";

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(12, 2) not null check (price >= 0),
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  address text,
  created_at timestamptz not null default now()
);

create table if not exists public.installments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  product_price numeric(12, 2) not null check (product_price >= 0),
  down_payment numeric(12, 2) not null default 0 check (down_payment >= 0),
  remaining_balance numeric(12, 2) not null check (remaining_balance >= 0),
  number_of_installments integer not null check (number_of_installments > 0),
  installment_amount numeric(12, 2) not null check (installment_amount >= 0),
  qr_code_ref text not null unique,
  status text not null default 'active' check (status in ('active', 'completed')),
  is_locked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  installment_id uuid not null references public.installments (id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  amount numeric(12, 2) not null check (amount >= 0),
  due_date date not null,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'overdue')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (installment_id, installment_number)
);

create index if not exists payments_installment_id_idx on public.payments (installment_id);
create index if not exists installments_qr_code_ref_idx on public.installments (qr_code_ref);

alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.installments enable row level security;
alter table public.payments enable row level security;

-- Open policies for anon (no auth in this phase)
drop policy if exists "anon_all_products" on public.products;
create policy "anon_all_products" on public.products
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "anon_all_customers" on public.customers;
create policy "anon_all_customers" on public.customers
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "anon_all_installments" on public.installments;
create policy "anon_all_installments" on public.installments
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "anon_all_payments" on public.payments;
create policy "anon_all_payments" on public.payments
  for all to anon, authenticated using (true) with check (true);

-- Realtime for owner dashboard (ignore errors if already added)
do $$
begin
  begin
    alter publication supabase_realtime add table public.payments;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.installments;
  exception when duplicate_object then null;
  end;
end $$;
