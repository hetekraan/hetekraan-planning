# Modularization Blueprint

## Layers
- `lib/domain/*`: pure rules without IO
- `lib/usecases/*`: orchestration for a business action
- `lib/adapters/*`: external services (GHL/Redis/Payments)
- `api/*`: thin transport layer

## Initial Implemented Slice
- Use case extracted:
  - `lib/usecases/complete-appointment.js`
- Transport still in place:
  - `api/ghl.js` invokes use-case and performs side effects.

## Next Extractions
- `loadPlannerDayUseCase`
- `blockCalendarDayUseCase`
- `confirmBookingUseCase`

## Editing Strategy
- Keep modules small (<200 LOC where feasible).
- One domain concern per file.
- Expose explicit input/output contracts for each use case.
