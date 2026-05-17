import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPlannerAppointmentEligibleForMorningMessage,
  resolvePlannerAppointmentStatus,
} from '../lib/planner-appointment-status.js';
import { buildMorningMessageAppointmentsForIngepland } from '../lib/morning-message-payload.js';

describe('planner appointment status (morning messages)', () => {
  it('accepts ingepland and confirmed via status or appointmentStatus', () => {
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: 'ingepland' }), true);
    assert.equal(
      isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', appointmentStatus: 'confirmed' }),
      true
    );
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: 'scheduled' }), true);
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: '' }), true);
  });

  it('rejects klaar, onderweg and cancelled', () => {
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: 'klaar' }), false);
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: 'onderweg' }), false);
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: 'cancelled' }), false);
    assert.equal(isPlannerAppointmentEligibleForMorningMessage({ contactId: 'c1', status: 'geannuleerd' }), false);
  });

  it('buildMorningMessageAppointmentsForIngepland includes confirmed when in route order', () => {
    const routeState = {
      orderContactIds: ['c1', 'c2'],
      etasByContactId: { c1: '09:00', c2: '10:30' },
    };
    const rows = buildMorningMessageAppointmentsForIngepland(routeState, [
      { contactId: 'c1', status: 'ingepland' },
      { contactId: 'c2', appointmentStatus: 'confirmed' },
      { contactId: 'c3', status: 'klaar' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].contactId, 'c1');
    assert.equal(rows[1].contactId, 'c2');
    assert.equal(resolvePlannerAppointmentStatus({ appointmentStatus: 'confirmed' }), 'confirmed');
  });
});
