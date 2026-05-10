create table if not exists public.analytics_appointments (
  "appointmentId" text primary key,
  "date" date not null,
  "totalRevenueExcl" numeric not null default 0,
  "totalCost" numeric not null default 0,
  "margin" numeric not null default 0,
  "marginPct" numeric not null default 0,
  "costKnown" boolean not null default false,
  "updatedAt" timestamptz not null default now()
);

create index if not exists analytics_appointments_date_idx
  on public.analytics_appointments ("date");
