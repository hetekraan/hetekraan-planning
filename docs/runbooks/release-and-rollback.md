# Release and Rollback Runbook

## Release Steps
1. Run CI locally (`npm test` where available).
2. Validate critical path matrix in preview.
3. Deploy to production.
4. Monitor logs/metrics for first 30 minutes.

## Fast Rollback Triggers
- Confirm booking failures > 1% over 5 minutes.
- Day-load error spike > 2x normal baseline.
- Security regression on auth/booking/block endpoints.

## Rollback Procedure
1. Revert last commit(s) on `main`.
2. Push rollback commit.
3. Verify production health endpoint and key flows.
4. Log incident summary and root-cause ticket.
