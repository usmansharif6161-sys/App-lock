-- Run in Supabase SQL Editor (required for Lock / Unlock feature)
alter table public.installments
  add column if not exists is_locked boolean not null default false;
