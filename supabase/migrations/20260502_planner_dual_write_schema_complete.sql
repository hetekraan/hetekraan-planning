-- ============================================================================
-- Planner dual-write: één idempotente schema-aanpassing passend bij
-- lib/planner-supabase-sync.js (syncAppointmentToSupabase).
--
-- Schrijft de code naar:
--   customers:     ghl_contact_id, name, phone, email, address
--   appointments:  source, external_booking_id, ghl_contact_id, customer_id,
--                  address, service_date, day_part, time_window, status,
--                  problem_description, total_amount, raw_payload
--   appointment_price_lines: appointment_id, line_index, description,
--                            quantity, unit_price, total_price, raw_payload
--
-- Veilig meerdere keren uit te voeren. Geen DROP TABLE / TRUNCATE.
-- ============================================================================

-- ─── Kolommen: customers ───────────────────────────────────────────────────
ALTER TABLE IF EXISTS public.customers
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text;

-- ─── Kolommen: appointments (nieuwe mirror-velden) ─────────────────────────
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

-- ─── Kolommen: appointment_price_lines ─────────────────────────────────────
ALTER TABLE IF EXISTS public.appointment_price_lines
  ADD COLUMN IF NOT EXISTS appointment_id uuid,
  ADD COLUMN IF NOT EXISTS line_index integer,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS quantity numeric,
  ADD COLUMN IF NOT EXISTS unit_price numeric,
  ADD COLUMN IF NOT EXISTS total_price numeric,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;

-- ─── Legacy kolom appointments.date vs code die service_date schrijft ──────
-- Code vult nooit "date" in; alleen service_date. Oude NOT NULL op "date"
-- geeft: null value in column "date" violates not-null constraint.
-- Veiligste minimale DB-only fix: NOT NULL verwijderen + backfill + trigger
-- die bij insert/update date uit service_date vult (alleen als kolom date bestaat).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'date'
  ) THEN
    UPDATE public.appointments
    SET date = service_date
    WHERE date IS NULL
      AND service_date IS NOT NULL;

    ALTER TABLE public.appointments
      ALTER COLUMN date DROP NOT NULL;
  END IF;
END $$;

-- Trigger: houd legacy "date" gelijk aan service_date wanneer date leeg is
-- (alleen als beide kolommen bestaan; functie refereert naar NEW.date / NEW.service_date.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'date'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'service_date'
  ) THEN
    EXECUTE $create_fn$
CREATE OR REPLACE FUNCTION public.planner_appointments_sync_legacy_date()
RETURNS trigger
LANGUAGE plpgsql
AS $f$
BEGIN
  IF NEW.service_date IS NOT NULL AND NEW.date IS NULL THEN
    NEW.date := NEW.service_date;
  ELSIF NEW.date IS NOT NULL AND NEW.service_date IS NULL THEN
    NEW.service_date := NEW.date;
  END IF;
  RETURN NEW;
END;
$f$;
$create_fn$;

    DROP TRIGGER IF EXISTS planner_appointments_sync_legacy_date_trg
      ON public.appointments;

    CREATE TRIGGER planner_appointments_sync_legacy_date_trg
      BEFORE INSERT OR UPDATE OF service_date, date
      ON public.appointments
      FOR EACH ROW
      EXECUTE PROCEDURE public.planner_appointments_sync_legacy_date();
  END IF;
END $$;

-- ─── Indexen (idempotent) ─────────────────────────────────────────────────
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

-- ─── Grants: service_role (lost dual-write "permission denied" op) ───────────
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
