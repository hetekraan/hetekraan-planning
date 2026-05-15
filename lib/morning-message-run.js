/**
 * Orchestratie: optimize route → bouw vensters → verstuur ochtendmeldingen.
 */

import { amsterdamWeekdaySun0 } from './amsterdam-calendar-day.js';
import { getRouteLiveState } from './route-live-store.js';
import { triggerLiveRouteRecalculation } from './route-live-optimizer.js';
import {
  getMorningMessageSettings,
  recordMorningMessagesSent,
} from './morning-message-store.js';
import { buildMorningMessageAppointmentsForIngepland } from './morning-message-payload.js';
import { sendMorningMessagesBatch } from './morning-message-send.js';

function cleanString(value) {
  return String(value || '').trim();
}

export function isWeekendDateStr(dateStr) {
  const wd = amsterdamWeekdaySun0(dateStr);
  return wd === 0 || wd === 6;
}

/**
 * @param {{
 *   locationId: string,
 *   dateStr: string,
 *   by: 'auto_cron' | 'manual' | string,
 *   skipIfAlreadySent?: boolean,
 *   skipEnabledCheck?: boolean,
 *   loadAppointmentsForDate: (dateStr: string) => Promise<{ appointments: Array<object> }>,
 *   sendDeps: { apiKey: string, geplandeAankomstFieldId: string, fetchFn?: typeof fetch },
 *   optimizeDeps?: object,
 * }} input
 */
export async function runMorningMessagesForDay(input) {
  const locationId = cleanString(input.locationId);
  const dateStr = cleanString(input.dateStr);
  const by = cleanString(input.by) || 'manual';
  if (!locationId || !dateStr) {
    return { ok: false, code: 'BAD_INPUT' };
  }

  if (isWeekendDateStr(dateStr)) {
    return { ok: true, skipped: true, code: 'WEEKEND' };
  }

  const settingsOut = await getMorningMessageSettings(locationId, dateStr);
  const settings = settingsOut.settings;
  if (!input.skipEnabledCheck && settings.enabled === false) {
    return { ok: true, skipped: true, code: 'DISABLED' };
  }
  if (input.skipIfAlreadySent && settings.lastSentAt) {
    return { ok: true, skipped: true, code: 'ALREADY_SENT', lastSentAt: settings.lastSentAt };
  }

  let appointments = [];
  try {
    const loaded = await input.loadAppointmentsForDate(dateStr);
    appointments = Array.isArray(loaded?.appointments) ? loaded.appointments : [];
  } catch (err) {
    return { ok: false, code: 'LOAD_APPOINTMENTS_FAILED', error: err?.message || String(err) };
  }

  const ingepland = appointments.filter(
    (a) => a?.contactId && cleanString(a.status).toLowerCase() === 'ingepland'
  );
  if (!ingepland.length) {
    return { ok: true, skipped: true, code: 'NO_INGEPLAND' };
  }

  const recalc = await triggerLiveRouteRecalculation({
    locationId,
    dateStr,
    appointments,
    reason: by === 'auto_cron' ? 'morning_messages_cron' : 'morning_messages_manual',
    updatedBy: by,
    deps: input.optimizeDeps || {},
  });
  if (!recalc?.ok) {
    return {
      ok: false,
      code: recalc?.code || 'ROUTE_OPTIMIZE_FAILED',
      recalc,
    };
  }

  const routeState = recalc.routeState || (await getRouteLiveState(locationId, dateStr)) || null;
  if (!routeState) {
    return { ok: false, code: 'ROUTE_STATE_MISSING' };
  }

  const payload = buildMorningMessageAppointmentsForIngepland(routeState, appointments);
  if (!payload.length) {
    return { ok: true, skipped: true, code: 'NO_PAYLOAD' };
  }

  const sendOut = await sendMorningMessagesBatch(payload, input.sendDeps);
  const windowsByContactId = Object.fromEntries(
    payload.map((row) => [
      row.contactId,
      {
        timeFrom: row.timeFrom,
        timeTo: row.timeTo,
        plannedValue: row.plannedValue,
        windowPhrase: row.windowPhrase,
      },
    ])
  );

  await recordMorningMessagesSent(locationId, dateStr, {
    revision: routeState.revision,
    count: sendOut.sent,
    by,
    contactIds: payload.map((r) => r.contactId),
    windowsByContactId,
  });

  console.info(
    'morning_messages_auto_sent',
    JSON.stringify({
      locationId,
      dateStr,
      count: sendOut.sent,
      revision: routeState.revision,
      by,
      errors: sendOut.errors?.length || 0,
    })
  );

  return {
    ok: sendOut.ok,
    sent: sendOut.sent,
    errors: sendOut.errors,
    revision: routeState.revision,
    routeState,
    settings: settingsOut.settings,
  };
}

export function countIngeplandAppointments(appointments) {
  return (Array.isArray(appointments) ? appointments : []).filter(
    (a) => a?.contactId && cleanString(a.status).toLowerCase() === 'ingepland'
  ).length;
}
