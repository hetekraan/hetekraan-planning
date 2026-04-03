# ADR-001: Model B — customer books a day block, not an exact time

**Status:** Accepted  
**Date:** 2026-03-30  
**Scope:** `hetekraan-planning` — invite, suggest, confirm, GHL integration

---

## 1. Problem

The product treated **GHL free-slots** and **exact start/end instants** as what the customer books. That mismatched the real business model (half-day **capacity**), caused **invite vs suggest** divergence, **blocked** intervals slipping through relative to free-slots, and **confirm** failures when **POST …/appointments** did not match GHL’s slot grid. **Route, travel, and clustering** belong in internal planning, not in the customer booking link.

---

## 2. Decision

We adopt **Model B**:

| Topic | Choice |
|--------|--------|
| **Customer promise** | A **block** only: **morning 09:00–13:00**, **afternoon 13:00–17:00** (Europe/Amsterdam). |
| **Split** | **`DAYPART_SPLIT_HOUR = 13`** (unchanged). |
| **Confirm (B1)** | On customer confirm, **no** exact GHL appointment is created. Confirm **reserves block capacity** (token + contact/custom fields + workflow as designed). |
| **Exact times** | **Planner / optimize-route** (and related flows) assign **real arrival order and times** later. |
| **Token** | **Schema v2**: `slots[]` carry **`dateStr` + `block`** (`morning` \| `afternoon`), **not** `startMs` / `endMs` / instant-based ids. |
| **Offers** | **`send-booking-invite`** and **`/api/suggest-slots`** use **one shared module** for “which blocks we offer.” |
| **Availability engine** | **Not** GHL free-slots for the customer path. Availability = **our rules** on **calendar events + blocked-slots + block-like detection** + **`booking-blocks`** (caps, planned minutes), aligned with the blocks above. |

---

## 3. Consequences

- **Simpler customer UX:** choices are **day + ochtend/middag**, not minutes.
- **Fewer GHL booking API failures** from slot-grid mismatch at confirm time.
- **Single source of truth** for staff preview and WhatsApp invite options.
- **Heavier responsibility** in **planning**: must **materialize** timed appointments (or equivalent) after booking; workflows must **not** assume an **appointment id** exists at confirm unless we add a separate internal step.
- **Constants and copy** in **`lib/planning-work-hours.js`** (and any NL strings) must stay aligned with **09–13 / 13–17** for customer-facing text.
- **GHL** remains the **system of record for the calendar**, but **customer-facing availability** is derived via **events + blocks + our logic**, not **`GET …/free-slots`** for offers.

---

## 4. What is now legacy

Treated as **legacy** under Model B (remove or quarantine after migration):

| Artifact | Notes |
|----------|--------|
| **`lib/ghl-free-slots-pipeline.js`** | Free-slot fetch + concrete instant list for **customer** offers. |
| **Free-slots usage** in **`api/send-booking-invite.js`** and **`api/suggest-slots.js`** | Customer path must not depend on it. |
| **Token schema v1** | Slots with **`startMs` / `endMs`**, ids like `s_<ms>`. |
| **`api/confirm-booking.js`**: instant booking | **`POST …/calendars/events/appointments`** with token-derived **exact** `startTime`/`endTime`, minute-offset retries, **`appointmentSpanMs`** alignment to free-slots — **not** part of B1 confirm. |
| **`book.html`** UX tied to **narrow time ranges** as the “product” | Replace with **block** labels. |

**Not legacy** (keep and extend):

- **`lib/booking-blocks.js`** — durations, planned minutes, per-block customer limits.
- **`lib/ghl-calendar-blocks.js`** — blocked days, blocked-slots merge, block-like marking.
- **`lib/calendar-customer-cap.js`** — e.g. max 7 customer appointments per day (env-tunable).
- **`lib/amsterdam-calendar-day.js`**, **`lib/amsterdam-wall-time.js`** — Amsterdam day boundaries.
- **`api/optimize-route.js`** / **`lib/planning/*`** — where **exact** schedule should land.

---

## 5. Migration phases

1. **Align config & copy** — Customer blocks **09–13 / 13–17** in **`lib/planning-work-hours.js`** (and any duplicated strings); verify **`DAYPART_SPLIT_HOUR = 13`** still matches afternoon start.
2. **Shared offers module** — New module (e.g. under `lib/`) implements **block-capacity** candidate list from **events + blocking + booking-blocks** (no free-slots for offers).
3. **`send-booking-invite`** — Switch to shared module; emit **token schema v2** (`dateStr` + `block` only).
4. **`book.html` + `confirm-booking`** — Read v2; **B1**: validate capacity, update contact/fields/tags; **do not** create timed appointment for the customer at confirm.
5. **`suggest-slots`** — Call the **same** shared module as invite.
6. **Retire legacy** — Remove free-slots pipeline from customer paths; sunset v1 tokens (communicate “request new link” if needed).
7. **Planner integration** — Ensure **optimize-route** / internal tools consume **reserved blocks** and create or move **real** GHL appointments with travel/clustering rules.

---

*This document is the internal contract for Model B until implementation catches up.*
