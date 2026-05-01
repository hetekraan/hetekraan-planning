-- Idempotente kolommen voor planner dual-write mirror.
-- Veilig meerdere keren uit te voeren.

ALTER TABLE IF EXISTS public.customers
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text;

ALTER TABLE IF EXISTS public.appointments
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS external_booking_id text,
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS service_date date,
  ADD COLUMN IF NOT EXISTS day_part text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS time_window text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS problem_description text,
  ADD COLUMN IF NOT EXISTS total_amount numeric,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;

ALTER TABLE IF EXISTS public.appointment_price_lines
  ADD COLUMN IF NOT EXISTS appointment_id uuid,
  ADD COLUMN IF NOT EXISTS line_index integer,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS quantity numeric,
  ADD COLUMN IF NOT EXISTS unit_price numeric,
  ADD COLUMN IF NOT EXISTS total_price numeric,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;

CREATE INDEX IF NOT EXISTS idx_customers_ghl_contact_id
  ON public.customers (ghl_contact_id);

CREATE INDEX IF NOT EXISTS idx_customers_email
  ON public.customers (email);

CREATE INDEX IF NOT EXISTS idx_appointments_external_booking_id
  ON public.appointments (external_booking_id);

CREATE INDEX IF NOT EXISTS idx_appointments_lookup_fallback
  ON public.appointments (source, ghl_contact_id, service_date, day_part);

CREATE INDEX IF NOT EXISTS idx_appointment_price_lines_appointment_id
  ON public.appointment_price_lines (appointment_id);

