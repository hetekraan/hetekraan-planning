/**
 * Browser-bridge voor de planner-pills (Slot + ETA).
 * SYNC: lib/morning-message-payload.js — houd deze implementaties identiek.
 * (lib/ wordt niet statisch geserveerd, daarom een aparte browser-kopie.)
 */

function cleanString(value) {
  return String(value || '').trim();
}

const TIME_RE = /^\d{1,2}:\d{2}$/;

export function formatMorningWindowPillLabel(win) {
  if (!win || typeof win !== 'object') return '';
  const from = cleanString(win.timeFrom);
  const to = cleanString(win.timeTo);
  if (TIME_RE.test(from) && TIME_RE.test(to)) {
    return from === to ? `Slot om ${from}` : `Slot ${from}-${to}`;
  }
  const planned = cleanString(win.plannedValue);
  if (TIME_RE.test(planned)) return `Slot om ${planned}`;
  return '';
}

export function formatEtaSentPillLabel(eta) {
  const v = cleanString(eta);
  return TIME_RE.test(v) ? `ETA ${v}` : 'ETA verstuurd';
}

export function resolveMorningSentWindowForContact(settings, contactId) {
  const cid = cleanString(contactId);
  if (!cid || !settings || typeof settings !== 'object') return null;
  if (!settings.lastSentAt) return null;
  const ids = Array.isArray(settings.lastSentContactIds) ? settings.lastSentContactIds : [];
  if (!ids.map(cleanString).includes(cid)) return null;
  const map =
    settings.lastSentWindowsByContactId && typeof settings.lastSentWindowsByContactId === 'object'
      ? settings.lastSentWindowsByContactId
      : null;
  const win = map ? map[cid] : null;
  if (!win || typeof win !== 'object') return null;
  if (!formatMorningWindowPillLabel(win)) return null;
  return win;
}
