-- Immutable completion snapshots for planner appointments.
-- Starts collecting from deployment date; no backfill of historical appointments.

create extension if not exists pgcrypto;

create table if not exists public.appointment_snapshots (
  id uuid primary key default gen_random_uuid(),

  snapshot_id text not null unique,
  snapshot_version integer not null default 1,
  source text not null default 'planner_complete',

  ghl_contact_id text not null,
  appointment_id text,
  synthetic_appointment_id text,

  service_date date not null,
  route_date date,
  completed_at timestamptz not null default now(),

  status text,
  type text,
  payment_status text,

  appointment_desc text,
  base_price numeric,
  total_amount numeric,

  contact_name text,
  contact_email text,
  contact_phone text,
  contact_address text,

  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index if not exists idx_appointment_snapshots_contact_date
  on public.appointment_snapshots (ghl_contact_id, service_date desc);

create index if not exists idx_appointment_snapshots_contact_date_lookup
  on public.appointment_snapshots (ghl_contact_id, service_date);

create index if not exists idx_appointment_snapshots_appointment_id
  on public.appointment_snapshots (appointment_id);

create index if not exists idx_appointment_snapshots_completed_at
  on public.appointment_snapshots (completed_at desc);
