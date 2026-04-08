# Critical Path Regression Matrix

## Planner Dashboard
- Load day with mixed rows (customer + block + synthetic).
- Mark as complete and refresh: row remains visible with final price.
- Delete booking: row removed and capacity reflects release.

## Blocking
- Block full day: dashboard + suggest/invite/confirm exclude date.
- Unblock day: date becomes available again.
- Refresh immediately after block/unblock: no stale 45s behavior.

## Booking Lifecycle
- Suggest -> invite -> confirm (morning and afternoon).
- Confirm on blocked day returns `DAY_BLOCKED`.
- Confirm duplicate contact/date handled deterministically.

## Pricing Canonical
- `boekingsformulier_prijs_regels` roundtrip parse/write.
- `boekingsformulier_prijs_totaal` remains source of truth after refresh.

## Failure Scenarios
- GHL 429/5xx retries with jitter and timeout.
- Network timeout path returns controlled error and log with request ID.
