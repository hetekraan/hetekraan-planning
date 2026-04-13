// api/optimize-route.js
// Probeert Distance Matrix API voor volledige tijdvenster-optimalisatie.
// Valt terug op Directions API (optimize:true) als Distance Matrix niet beschikbaar is.
//
// Modi:
// - Standaard (geen `mode`): bestaand gedrag (één batch, optioneel preserveOrder).
// - `mode: "partitionedDay"`: harde ochtend (09:00–13:00) / middag (13:00–17:00) splitsing,
//   start vanaf depot, eerste ochtendstop op 09:00, middag vanaf laatste ochtendadres met
//   klok ≥ 13:00 en ≥ einde laatste ochtendklus; optioneel `returnToDepot: true` → reistijd
//   laatste stop → depot in response.

const DEPOT = 'Cornelis Dopperkade, Amsterdam';
/**
 * Legacy default: interne klok start 09:00 (depot-impliciet).
 * Bij `partitionedDay` middagfase wordt `initialClockMinutes` expliciet gezet (≥ 13:00).
 */
const START_TIME = 9 * 60;

const MORNING_BLOCK = { start: 9 * 60, end: 13 * 60 };
const AFTERNOON_BLOCK = { start: 13 * 60, end: 17 * 60 };

/** Ochtendvenster (o.a. "ochtend" in parseTimeWindow eindigt 13:00). Alleen als fallback zonder dayPart. */
function isMorningTimeWindow(tw) {
  return tw != null && tw.end <= 13 * 60;
}

/**
 * Eerste-klant-09:00-pin: primair `dayPart === 0` van de client; anders fallback op timeWindow.
 */
function isMorningStopForFirstCustomerPin(appointment, tw) {
  const dp = appointment?.dayPart;
  if (dp !== null && dp !== undefined) return Number(dp) === 0;
  return isMorningTimeWindow(tw);
}

/** Vaste aankomst eerste ochtendstop; wacht tot venster opent indien nodig. */
function firstMorningCustomerArrivalMinutes(tw) {
  let eta = START_TIME;
  if (tw && eta < tw.start) eta = tw.start;
  return eta;
}

function parseTimeWindow(str) {
  if (!str || str === 'null') return null;
  const s = str.toLowerCase().trim();
  if (s.includes('ochtend')) return { start: 8 * 60, end: 13 * 60 };
  if (s.includes('middag')) return { start: 12 * 60, end: 18 * 60 };
  if (s.includes('avond')) return { start: 17 * 60, end: 20 * 60 };

  const rondMatch = s.match(/rond\s+(\d{1,2})[:.h](\d{2})/);
  if (rondMatch) {
    const t = parseInt(rondMatch[1]) * 60 + parseInt(rondMatch[2]);
    return { start: t - 30, end: t + 60 };
  }
  const rangeMatch = s.match(/(\d{1,2})[:.h](\d{2})\s*[-–tot ]+\s*(\d{1,2})[:.h](\d{2})/);
  if (rangeMatch) {
    return {
      start: parseInt(rangeMatch[1]) * 60 + parseInt(rangeMatch[2]),
      end: parseInt(rangeMatch[3]) * 60 + parseInt(rangeMatch[4]),
    };
  }
  const singleMatch = s.match(/(\d{1,2})[:.h](\d{2})/);
  if (singleMatch) {
    const t = parseInt(singleMatch[1]) * 60 + parseInt(singleMatch[2]);
    return { start: t - 30, end: t + 60 };
  }
  return null;
}

function minutesToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function roundUpQuarter(m) {
  return Math.ceil(m / 15) * 15;
}

/**
 * @typedef {{ initialClockMinutes: number, pinFirstMorningCustomer: boolean }} ScheduleOpts
 */

// Bereken ETAs voor een gegeven volgorde met reistijdenmatrix (in minuten)
function calcETAs(order, travel, timeWindows, jobDurations, appointments, opts) {
  const initialClock = opts?.initialClockMinutes ?? START_TIME;
  const pinFirst = opts?.pinFirstMorningCustomer !== false;
  const etas = [];
  let currentIdx = 0;
  let currentTime = initialClock;

  for (let step = 0; step < order.length; step++) {
    const i = order[step];
    const travelMin = travel[currentIdx][i + 1];
    const tw = timeWindows[i];

    let eta;
    if (pinFirst && step === 0 && isMorningStopForFirstCustomerPin(appointments[i], tw)) {
      eta = firstMorningCustomerArrivalMinutes(tw);
    } else {
      let arrival = currentTime + travelMin;
      if (tw && arrival < tw.start) arrival = tw.start;
      eta = roundUpQuarter(arrival);
    }
    etas.push(eta);
    currentTime = eta + jobDurations[i];
    currentIdx = i + 1;
  }
  return etas;
}

// Greedy algoritme met volledige reistijdenmatrix
function greedySchedule(n, travel, timeWindows, jobDurations, appointments, opts) {
  const initialClock = opts?.initialClockMinutes ?? START_TIME;
  const pinFirst = opts?.pinFirstMorningCustomer !== false;

  const visited = new Array(n).fill(false);
  const order = [];
  let currentIdx = 0;
  let currentTime = initialClock;

  for (let step = 0; step < n; step++) {
    let bestCandidate = -1;
    let bestScore = Infinity;

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const travelMin = travel[currentIdx][i + 1];
      const tw = timeWindows[i];
      let arrival = currentTime + travelMin;
      if (pinFirst && step === 0 && isMorningStopForFirstCustomerPin(appointments[i], tw)) {
        arrival = firstMorningCustomerArrivalMinutes(tw);
      }
      let score = travelMin;

      if (tw) {
        if (arrival > tw.end) {
          score += (arrival - tw.end) * 8;
        } else if (arrival < tw.start) {
          score += (tw.start - arrival) * 0.2;
          score -= Math.max(0, tw.end - arrival) * 0.05;
        }
      }

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = i;
      }
    }

    visited[bestCandidate] = true;
    order.push(bestCandidate);
    const twPick = timeWindows[bestCandidate];
    let arrival = currentTime + travel[currentIdx][bestCandidate + 1];
    if (pinFirst && step === 0 && isMorningStopForFirstCustomerPin(appointments[bestCandidate], twPick)) {
      arrival = firstMorningCustomerArrivalMinutes(twPick);
    } else if (twPick && arrival < twPick.start) {
      arrival = twPick.start;
    }
    const etaPick =
      pinFirst && step === 0 && isMorningStopForFirstCustomerPin(appointments[bestCandidate], twPick)
        ? arrival
        : roundUpQuarter(arrival);
    currentTime = etaPick + jobDurations[bestCandidate];
    currentIdx = bestCandidate + 1;
  }
  return order;
}

async function fetchDistanceMatrixTravelMinutes(key, allLocations) {
  const originsParam = allLocations.map((l) => encodeURIComponent(l)).join('|');
  const destsParam = allLocations.map((l) => encodeURIComponent(l)).join('|');
  const matrixUrl =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${originsParam}&destinations=${destsParam}&region=nl&language=nl&key=${key}`;

  const matRes = await fetch(matrixUrl);
  const matData = await matRes.json();
  if (matData.status !== 'OK') return null;
  return matData.rows.map((row) =>
    row.elements.map((el) => (el.status === 'OK' ? Math.ceil((el.duration?.value || 0) / 60) : 60))
  );
}

/**
 * @returns {Promise<{ order: number[], etas: number[], legInfo: { durationSeconds: number }[], travel: number[][] } | null>}
 */
async function optimizeSubsetMatrix({
  key,
  origin,
  appointments,
  scheduleOpts,
  fixedOrder,
}) {
  const n = appointments.length;
  if (n < 1) return { order: [], etas: [], legInfo: [], travel: [] };

  const allLocations = [origin, ...appointments.map((a) => a.address)];
  const travel = await fetchDistanceMatrixTravelMinutes(key, allLocations);
  if (!travel) return null;

  const timeWindows = appointments.map((a) => parseTimeWindow(a.timeWindow));
  const jobDurations = appointments.map((a) => a.jobDuration || 30);

  const order = fixedOrder || greedySchedule(n, travel, timeWindows, jobDurations, appointments, scheduleOpts);
  const etas = calcETAs(order, travel, timeWindows, jobDurations, appointments, scheduleOpts);
  const legInfo = order.map((apptIdx, i) => {
    const fromIdx = i === 0 ? 0 : order[i - 1] + 1;
    return { durationSeconds: travel[fromIdx][apptIdx + 1] * 60 };
  });
  return { order, etas, legInfo, travel };
}

async function travelMinutesOneLeg(key, fromAddr, toAddr) {
  const travel = await fetchDistanceMatrixTravelMinutes(key, [fromAddr, toAddr]);
  if (!travel || !travel[0]) return null;
  return travel[0][1];
}

function collectViolations(order, etas, timeWindows) {
  const violations = [];
  order.forEach((apptIdx, i) => {
    const tw = timeWindows[apptIdx];
    if (!tw) return;
    if (etas[i] > tw.end) {
      violations.push({
        apptIdx,
        eta: minutesToTime(etas[i]),
        window: `${minutesToTime(tw.start)}-${minutesToTime(tw.end)}`,
      });
    }
  });
  return violations;
}

/**
 * Interne vaste start (operationeel), veldnaam `internalFixedStart` of `internalFixedStartTime`, "HH:mm".
 * Niet hetzelfde als het klant-boekingsslot (`timeWindow` / `dayPart`).
 */
function parseInternalFixedStartMinutes(appt) {
  const s = String(appt?.internalFixedStart ?? appt?.internalFixedStartTime ?? '')
    .trim()
    .replace(/^~/, '');
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Harde regels: interne start binnen dagdeel-blok (ochtend t/m 13:00 / middag vanaf 13:00). */
function validateInternalPinsPartitioned(appointments, morningOrigIndices, afternoonOrigIndices) {
  const messages = [];
  for (const gi of morningOrigIndices) {
    const a = appointments[gi];
    const t = parseInternalFixedStartMinutes(a);
    if (t == null) continue;
    const job = a.jobDuration || 30;
    if (t + job > MORNING_BLOCK.end) {
      messages.push(
        `Interne start ${minutesToTime(t)} (+ ${job} min) eindigt na 13:00 (ochtendblok). Kies een eerdere tijd of kortere klus.`
      );
    }
  }
  for (const gi of afternoonOrigIndices) {
    const a = appointments[gi];
    const t = parseInternalFixedStartMinutes(a);
    if (t == null) continue;
    const job = a.jobDuration || 30;
    if (t < AFTERNOON_BLOCK.start) {
      messages.push(
        `Middagafspraak: interne start ${minutesToTime(t)} ligt vóór 13:00. Zet de afspraak op ochtend of kies een tijd vanaf 13:00.`
      );
    }
    if (t + job > AFTERNOON_BLOCK.end) {
      messages.push(`Interne start ${minutesToTime(t)} (+ ${job} min) eindigt na 17:00 (middagblok).`);
    }
  }
  return messages;
}

/**
 * Partition-subset met harde interne starttijden: vrije stops greedy vóór elke pin (deadline),
 * pins op exacte minuut, daarna resterende vrije stops.
 * @returns {Promise<null|{order:number[],etas:number[],legInfo:object[],travel:number[][]}|{error:string}>}
 */
async function optimizeSubsetMatrixWithInternalPins({ key, origin, appointments, scheduleOpts, partBlock }) {
  const n = appointments.length;
  if (n < 1) return { order: [], etas: [], legInfo: [], travel: [] };

  const pinMinutes = appointments.map((a) => parseInternalFixedStartMinutes(a));
  if (!pinMinutes.some((t) => t != null)) return null;

  if (n === 1) {
    return optimizeSubsetMatrix({ key, origin, appointments, scheduleOpts, fixedOrder: [0] });
  }

  const allLocations = [origin, ...appointments.map((a) => a.address)];
  const travel = await fetchDistanceMatrixTravelMinutes(key, allLocations);
  if (!travel) return null;

  const jobDurations = appointments.map((a) => a.jobDuration || 30);
  const pinEntries = [];
  for (let i = 0; i < n; i++) {
    if (pinMinutes[i] != null) pinEntries.push({ idx: i, t: pinMinutes[i] });
  }
  pinEntries.sort((a, b) => a.t - b.t || a.idx - b.idx);

  const order = [];
  const etasMin = [];
  const legInfo = [];
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));

  let cursorMatrixIdx = 0;
  let cursorTime = scheduleOpts?.initialClockMinutes ?? partBlock.start;
  if (pinEntries.length && pinEntries[0].t < cursorTime) {
    cursorTime = pinEntries[0].t;
  }

  const travelFromCursor = (localIdx) => travel[cursorMatrixIdx][localIdx + 1];

  function appendFree(localIdx) {
    const tm = travelFromCursor(localIdx);
    legInfo.push({ durationSeconds: tm * 60 });
    let arrival = cursorTime + tm;
    arrival = Math.max(arrival, partBlock.start);
    const eta = roundUpQuarter(arrival);
    order.push(localIdx);
    etasMin.push(eta);
    cursorTime = eta + jobDurations[localIdx];
    cursorMatrixIdx = localIdx + 1;
    remaining.delete(localIdx);
  }

  function appendPinned(localIdx, forcedMin) {
    const tm = travelFromCursor(localIdx);
    legInfo.push({ durationSeconds: tm * 60 });
    const earliest = roundUpQuarter(cursorTime + tm);
    if (earliest > forcedMin) {
      return `Intern vaste start ${minutesToTime(forcedMin)} niet haalbaar: vroegste aankomst ~${minutesToTime(earliest)} (reistijd).`;
    }
    order.push(localIdx);
    etasMin.push(forcedMin);
    cursorTime = forcedMin + jobDurations[localIdx];
    cursorMatrixIdx = localIdx + 1;
    remaining.delete(localIdx);
    return null;
  }

  function greedyFillBefore(deadlineMin) {
    while (true) {
      const frees = [...remaining].filter((i) => pinMinutes[i] == null);
      if (!frees.length) return;
      let best = -1;
      let bestTm = Infinity;
      for (const i of frees) {
        const tm = travelFromCursor(i);
        const etaQ = roundUpQuarter(Math.max(cursorTime + tm, partBlock.start));
        const fin = etaQ + jobDurations[i];
        if (deadlineMin < 1e9 && fin > deadlineMin) continue;
        if (tm < bestTm) {
          bestTm = tm;
          best = i;
        }
      }
      if (best < 0) return;
      appendFree(best);
    }
  }

  for (const pin of pinEntries) {
    greedyFillBefore(pin.t);
    if (!remaining.has(pin.idx)) {
      return { error: 'Interne vaste starts sluiten elkaar uit (zelfde stop of onmogelijke volgorde).' };
    }
    const errPin = appendPinned(pin.idx, pin.t);
    if (errPin) return { error: errPin };
  }

  greedyFillBefore(1e12);
  while (remaining.size) {
    const i = [...remaining][0];
    if (pinMinutes[i] != null) {
      const errPin = appendPinned(i, pinMinutes[i]);
      if (errPin) return { error: errPin };
    } else {
      appendFree(i);
    }
  }

  return { order, etas: etasMin, legInfo, travel };
}

/**
 * Harde klantblokken + depot → ochtend → (overgang) → middag → optioneel terug naar depot.
 */
async function handlePartitionedDay(req, res, key, appointments, returnToDepot) {
  const n = appointments.length;
  if (n < 1) {
    return res.status(400).json({ error: 'Geen afspraken' });
  }

  const morningOrigIndices = [];
  const afternoonOrigIndices = [];
  for (let i = 0; i < n; i++) {
    if (Number(appointments[i]?.dayPart) === 0) morningOrigIndices.push(i);
    else afternoonOrigIndices.push(i);
  }

  const pinMsgs = validateInternalPinsPartitioned(appointments, morningOrigIndices, afternoonOrigIndices);
  if (pinMsgs.length) {
    return res.status(400).json({ error: pinMsgs[0], messages: pinMsgs });
  }

  const mApps = morningOrigIndices.map((gi) => ({
    ...appointments[gi],
    address: appointments[gi].address,
    timeWindow: '09:00-13:00',
    jobDuration: appointments[gi].jobDuration || 30,
    dayPart: 0,
    internalFixedStart: appointments[gi].internalFixedStart || appointments[gi].internalFixedStartTime || undefined,
  }));

  const globalOrder = [];
  const globalEtasMin = [];
  const globalLegInfo = [];
  const violations = [];

  /** Ochtendfase */
  if (mApps.length > 0) {
    const usePins = mApps.some((a) => parseInternalFixedStartMinutes(a) != null);
    let r = usePins
      ? await optimizeSubsetMatrixWithInternalPins({
          key,
          origin: DEPOT,
          appointments: mApps,
          scheduleOpts: {
            initialClockMinutes: MORNING_BLOCK.start,
            pinFirstMorningCustomer: false,
          },
          partBlock: MORNING_BLOCK,
        })
      : await optimizeSubsetMatrix({
          key,
          origin: DEPOT,
          appointments: mApps,
          scheduleOpts: {
            initialClockMinutes: MORNING_BLOCK.start,
            pinFirstMorningCustomer: true,
          },
          fixedOrder: mApps.length === 1 ? [0] : null,
        });

    if (r && r.error) {
      return res.status(400).json({ error: r.error });
    }

    if (!r) {
      return res.status(500).json({ error: 'DISTANCE_MATRIX_FAILED', message: 'Afstands-matrix tijdelijk niet beschikbaar' });
    }

    const twM = mApps.map(() => MORNING_BLOCK);
    violations.push(
      ...collectViolations(r.order, r.etas, twM).map((v) => ({
        ...v,
        apptIdx: morningOrigIndices[v.apptIdx],
      }))
    );

    for (let s = 0; s < r.order.length; s++) {
      const localIdx = r.order[s];
      globalOrder.push(morningOrigIndices[localIdx]);
      globalEtasMin.push(r.etas[s]);
      globalLegInfo.push(r.legInfo[s] || { durationSeconds: 0 });
    }
  }

  /** Middagfase */
  const aApps = afternoonOrigIndices.map((gi) => ({
    ...appointments[gi],
    address: appointments[gi].address,
    timeWindow: '13:00-17:00',
    jobDuration: appointments[gi].jobDuration || 30,
    dayPart: 1,
    internalFixedStart: appointments[gi].internalFixedStart || appointments[gi].internalFixedStartTime || undefined,
  }));

  if (aApps.length > 0) {
    let afternoonOrigin = DEPOT;
    let afternoonClock = AFTERNOON_BLOCK.start;

    if (mApps.length > 0) {
      const lastLocalMorningIdx = mApps.length - 1;
      const lastMorningGlobal = morningOrigIndices[lastLocalMorningIdx];
      const lastMorningAddr = String(appointments[lastMorningGlobal]?.address || '').trim();
      if (lastMorningAddr) afternoonOrigin = lastMorningAddr;

      const lastMorningEta = globalEtasMin[globalEtasMin.length - 1];
      const lastMorningJob = mApps[lastLocalMorningIdx].jobDuration || 30;
      afternoonClock = Math.max(AFTERNOON_BLOCK.start, lastMorningEta + lastMorningJob);
    }

    const usePinsPm = aApps.some((a) => parseInternalFixedStartMinutes(a) != null);
    let r = usePinsPm
      ? await optimizeSubsetMatrixWithInternalPins({
          key,
          origin: afternoonOrigin,
          appointments: aApps,
          scheduleOpts: {
            initialClockMinutes: afternoonClock,
            pinFirstMorningCustomer: false,
          },
          partBlock: AFTERNOON_BLOCK,
        })
      : await optimizeSubsetMatrix({
          key,
          origin: afternoonOrigin,
          appointments: aApps,
          scheduleOpts: {
            initialClockMinutes: afternoonClock,
            pinFirstMorningCustomer: false,
          },
          fixedOrder: aApps.length === 1 ? [0] : null,
        });

    if (r && r.error) {
      return res.status(400).json({ error: r.error });
    }

    if (!r) {
      return res.status(500).json({ error: 'DISTANCE_MATRIX_FAILED', message: 'Afstands-matrix tijdelijk niet beschikbaar' });
    }

    const twA = aApps.map(() => AFTERNOON_BLOCK);
    violations.push(
      ...collectViolations(r.order, r.etas, twA).map((v) => ({
        ...v,
        apptIdx: afternoonOrigIndices[v.apptIdx],
      }))
    );

    for (let s = 0; s < r.order.length; s++) {
      const localIdx = r.order[s];
      globalOrder.push(afternoonOrigIndices[localIdx]);
      globalEtasMin.push(r.etas[s]);
      globalLegInfo.push(r.legInfo[s] || { durationSeconds: 0 });
    }
  }

  let returnLegToDepotMinutes = null;
  if (returnToDepot && globalOrder.length > 0) {
    const lastG = globalOrder[globalOrder.length - 1];
    const lastAddr = String(appointments[lastG]?.address || '').trim();
    if (lastAddr) {
      returnLegToDepotMinutes = await travelMinutesOneLeg(key, lastAddr, DEPOT);
    }
  }

  return res.status(200).json({
    mode: 'partitionedDay',
    order: globalOrder,
    etas: globalEtasMin.map(minutesToTime),
    violations,
    legInfo: globalLegInfo,
    method: 'partitionedDay+distance-matrix',
    originUsed: 'depot+transition',
    destinationUsed: returnToDepot ? 'depot' : 'none',
    returnLegToDepotMinutes: returnLegToDepotMinutes != null ? returnLegToDepotMinutes : undefined,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { appointments, preserveOrder, origin: originRaw, mode, returnToDepot } = req.body;
  if (!appointments || appointments.length < 1) {
    return res.status(400).json({ error: 'Geen afspraken' });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY ontbreekt' });

  if (mode === 'partitionedDay') {
    const wantReturn = returnToDepot !== false;
    return handlePartitionedDay(req, res, key, appointments, wantReturn);
  }

  const origin = typeof originRaw === 'string' && originRaw.trim() ? originRaw.trim() : DEPOT;

  const n = appointments.length;
  const timeWindows = appointments.map((a) => parseTimeWindow(a.timeWindow));
  const jobDurations = appointments.map((a) => a.jobDuration || 30);
  const allLocations = [origin, ...appointments.map((a) => a.address)];
  /** Vaste volgorde (bv. na slepen): indices 0..n-1 */
  const fixedOrder = preserveOrder === true ? appointments.map((_, i) => i) : null;

  const defaultScheduleOpts = { initialClockMinutes: START_TIME, pinFirstMorningCustomer: true };

  // ── Poging 1: Distance Matrix API ──────────────────────────────────────────
  let order;
  let etas;
  let legInfo;
  let usedDistanceMatrix = false;

  try {
    const travel = await fetchDistanceMatrixTravelMinutes(key, allLocations);
    if (travel) {
      order = fixedOrder || greedySchedule(n, travel, timeWindows, jobDurations, appointments, defaultScheduleOpts);
      etas = calcETAs(order, travel, timeWindows, jobDurations, appointments, defaultScheduleOpts);
      legInfo = order.map((apptIdx, i) => {
        const fromIdx = i === 0 ? 0 : order[i - 1] + 1;
        return { durationSeconds: travel[fromIdx][apptIdx + 1] * 60 };
      });
      usedDistanceMatrix = true;
    }
  } catch (_) {}

  // ── Fallback: Directions API ────────────────────────────────────────────────
  if (!usedDistanceMatrix) {
    const addrJoined = appointments.map((a) => a.address).join('|');
    const waypoints = fixedOrder ? addrJoined : `optimize:true|${addrJoined}`;
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(DEPOT)}` +
      `&waypoints=${encodeURIComponent(waypoints)}` +
      `&region=nl&language=nl&key=${key}`;

    const gmRes = await fetch(url);
    const gmData = await gmRes.json();

    if (gmData.status !== 'OK') {
      return res.status(500).json({ error: gmData.status, message: gmData.error_message });
    }

    const legs = gmData.routes?.[0]?.legs || [];

    if (fixedOrder) {
      const legDurMin = legs.slice(0, n).map((l) => Math.ceil((l.duration?.value || 0) / 60));
      let currentTime = START_TIME;
      etas = [];
      legInfo = [];
      for (let step = 0; step < n; step++) {
        const apptIdx = step;
        const travelMin = legDurMin[step] || 0;
        const tw = timeWindows[apptIdx];
        let eta;
        if (step === 0 && isMorningStopForFirstCustomerPin(appointments[apptIdx], tw)) {
          eta = firstMorningCustomerArrivalMinutes(tw);
        } else {
          let arrival = currentTime + travelMin;
          if (tw && arrival < tw.start) arrival = tw.start;
          eta = roundUpQuarter(arrival);
        }
        etas.push(eta);
        currentTime = eta + jobDurations[apptIdx];
        legInfo.push({ durationSeconds: travelMin * 60 });
      }
      order = fixedOrder;
    } else {
      const gmOrder = gmData.routes?.[0]?.waypoint_order || appointments.map((_, i) => i);
      const legDurMin = legs.map((l) => Math.ceil((l.duration?.value || 0) / 60));

      let currentTime = START_TIME;
      etas = [];
      legInfo = [];

      gmOrder.forEach((apptIdx, step) => {
        const travelMin = legDurMin[step] || 0;
        const tw = timeWindows[apptIdx];
        let eta;
        if (step === 0 && isMorningStopForFirstCustomerPin(appointments[apptIdx], tw)) {
          eta = firstMorningCustomerArrivalMinutes(tw);
        } else {
          let arrival = currentTime + travelMin;
          if (tw && arrival < tw.start) arrival = tw.start;
          eta = roundUpQuarter(arrival);
        }
        etas.push(eta);
        currentTime = eta + jobDurations[apptIdx];
        legInfo.push({ durationSeconds: travelMin * 60 });
      });

      order = gmOrder;
    }
  }

  const violations = collectViolations(order, etas, timeWindows);

  const methodTag = usedDistanceMatrix
    ? fixedOrder
      ? 'distance-matrix+fixed-order'
      : 'distance-matrix'
    : fixedOrder
      ? 'directions+fixed-order'
      : 'directions-fallback';

  const originTag = origin === DEPOT ? 'depot' : 'custom';

  return res.status(200).json({
    order,
    etas: etas.map(minutesToTime),
    violations,
    legInfo,
    method: methodTag,
    originUsed: originTag,
  });
}
