# SLO and Error Budget Baseline

## Core SLOs
- Planner day load (`GET /api/ghl?action=getAppointments`): 99.5% monthly success.
- Confirm booking (`POST /api/confirm-booking`): 99.9% monthly success.
- Block/unblock day (`/api/ghl?action=blockCalendarDay|unblockCalendarDay`): 99.5% monthly success.

## Latency Targets (p95)
- Day load: < 1500ms
- Confirm booking: < 2000ms
- Block/unblock: < 1200ms

## Error Budget
- 99.5% SLO => 0.5% monthly budget.
- Escalation levels:
  - 25% consumed: freeze non-critical changes.
  - 50% consumed: only reliability/security deploys.
  - 75% consumed: incident mode, rollback-first.

## Mandatory Release Checklist
- Critical path smoke passed.
- No new high-severity security findings.
- Structured logs available with request IDs.
