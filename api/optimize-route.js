// api/optimize-route.js
// Probeert Distance Matrix API voor volledige tijdvenster-optimalisatie.
// Valt terug op Directions API (optimize:true) als Distance Matrix niet beschikbaar is.

const DEPOT      = 'Cornelis Dopperkade, Amsterdam';
/**
 * Eerste **ochtendklant** arriveert om dit tijdstip (minuten sinds middernacht), ongeacht rijtijd vanaf depot.
 * (Niet: om 09:00 vertrekken bij depot — de interne klok startte daarvoor impliciet op depot+rit.)
 */
const START_TIME = 9 * 60;

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
  if (s.includes('middag'))  return { start: 12 * 60, end: 18 * 60 };
  if (s.includes('avond'))   return { start: 17 * 60, end: 20 * 60 };

  const rondMatch = s.match(/rond\s+(\d{1,2})[:.h](\d{2})/);
  if (rondMatch) {
    const t = parseInt(rondMatch[1]) * 60 + parseInt(rondMatch[2]);
    return { start: t - 30, end: t + 60 };
  }
  const rangeMatch = s.match(/(\d{1,2})[:.h](\d{2})\s*[-–tot ]+\s*(\d{1,2})[:.h](\d{2})/);
  if (rangeMatch) {
    return {
      start: parseInt(rangeMatch[1]) * 60 + parseInt(rangeMatch[2]),
      end:   parseInt(rangeMatch[3]) * 60 + parseInt(rangeMatch[4]),
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
  const h   = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function roundUpQuarter(m) {
  return Math.ceil(m / 15) * 15;
}

// Bereken ETAs voor een gegeven volgorde met reistijdenmatrix (in minuten)
function calcETAs(order, travel, timeWindows, jobDurations, appointments) {
  const etas = [];
  let currentIdx  = 0; // depot
  let currentTime = START_TIME;

  for (let step = 0; step < order.length; step++) {
    const i         = order[step];
    const travelMin = travel[currentIdx][i + 1];
    const tw        = timeWindows[i];

    let eta;
    if (step === 0 && isMorningStopForFirstCustomerPin(appointments[i], tw)) {
      eta = firstMorningCustomerArrivalMinutes(tw);
    } else {
      let arrival = currentTime + travelMin;
      if (tw && arrival < tw.start) arrival = tw.start;
      eta = roundUpQuarter(arrival);
    }
    etas.push(eta);
    currentTime = eta + jobDurations[i];
    currentIdx  = i + 1;
  }
  return etas;
}

// Greedy algoritme met volledige reistijdenmatrix
function greedySchedule(n, travel, timeWindows, jobDurations, appointments) {
  const visited = new Array(n).fill(false);
  const order   = [];
  let currentIdx  = 0;
  let currentTime = START_TIME;

  for (let step = 0; step < n; step++) {
    let bestCandidate = -1;
    let bestScore     = Infinity;

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const travelMin = travel[currentIdx][i + 1];
      const tw        = timeWindows[i];
      let arrival     = currentTime + travelMin;
      if (step === 0 && isMorningStopForFirstCustomerPin(appointments[i], tw)) {
        arrival = firstMorningCustomerArrivalMinutes(tw);
      }
      let score       = travelMin;

      if (tw) {
        if (arrival > tw.end) {
          score += (arrival - tw.end) * 8;        // te laat: zware straf
        } else if (arrival < tw.start) {
          score += (tw.start - arrival) * 0.2;    // te vroeg: wachtstraf
          score -= Math.max(0, tw.end - arrival) * 0.05; // urgentie bonus
        }
      }

      if (score < bestScore) {
        bestScore     = score;
        bestCandidate = i;
      }
    }

    visited[bestCandidate] = true;
    order.push(bestCandidate);
    const twPick = timeWindows[bestCandidate];
    let arrival  = currentTime + travel[currentIdx][bestCandidate + 1];
    if (step === 0 && isMorningStopForFirstCustomerPin(appointments[bestCandidate], twPick)) {
      arrival = firstMorningCustomerArrivalMinutes(twPick);
    } else if (twPick && arrival < twPick.start) {
      arrival = twPick.start;
    }
    const etaPick = step === 0 && isMorningStopForFirstCustomerPin(appointments[bestCandidate], twPick)
      ? arrival
      : roundUpQuarter(arrival);
    currentTime = etaPick + jobDurations[bestCandidate];
    currentIdx  = bestCandidate + 1;
  }
  return order;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { appointments, preserveOrder, origin: originRaw } = req.body;
  if (!appointments || appointments.length < 1) {
    return res.status(400).json({ error: 'Geen afspraken' });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY ontbreekt' });

  const origin =
    typeof originRaw === 'string' && originRaw.trim() ? originRaw.trim() : DEPOT;

  const n            = appointments.length;
  const timeWindows  = appointments.map(a => parseTimeWindow(a.timeWindow));
  const jobDurations = appointments.map(a => a.jobDuration || 30);
  const allLocations = [origin, ...appointments.map(a => a.address)];
  /** Vaste volgorde (bv. na slepen): indices 0..n-1 */
  const fixedOrder   = preserveOrder === true ? appointments.map((_, i) => i) : null;

  // ── Poging 1: Distance Matrix API ──────────────────────────────────────────
  let order, etas, legInfo;
  let usedDistanceMatrix = false;

  try {
    const originsParam = allLocations.map(l => encodeURIComponent(l)).join('|');
    const destsParam   = allLocations.map(l => encodeURIComponent(l)).join('|');
    const matrixUrl    = `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${originsParam}&destinations=${destsParam}&region=nl&language=nl&key=${key}`;

    const matRes  = await fetch(matrixUrl);
    const matData = await matRes.json();

    if (matData.status === 'OK') {
      const travel = matData.rows.map(row =>
        row.elements.map(el => el.status === 'OK' ? Math.ceil((el.duration?.value || 0) / 60) : 60)
      );

      order    = fixedOrder || greedySchedule(n, travel, timeWindows, jobDurations, appointments);
      etas     = calcETAs(order, travel, timeWindows, jobDurations, appointments);
      legInfo  = order.map((apptIdx, i) => {
        const fromIdx = i === 0 ? 0 : order[i - 1] + 1;
        return { durationSeconds: travel[fromIdx][apptIdx + 1] * 60 };
      });
      usedDistanceMatrix = true;
    }
  } catch (_) {}

  // ── Fallback: Directions API ────────────────────────────────────────────────
  if (!usedDistanceMatrix) {
    const addrJoined = appointments.map(a => a.address).join('|');
    const waypoints    = fixedOrder
      ? addrJoined
      : `optimize:true|${addrJoined}`;
    const url = `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(DEPOT)}` +
      `&waypoints=${encodeURIComponent(waypoints)}` +
      `&region=nl&language=nl&key=${key}`;

    const gmRes  = await fetch(url);
    const gmData = await gmRes.json();

    if (gmData.status !== 'OK') {
      return res.status(500).json({ error: gmData.status, message: gmData.error_message });
    }

    const legs = gmData.routes?.[0]?.legs || [];

    if (fixedOrder) {
      // Depot → stop1 → … → stopN → depot: eerste n legs zijn de echte ritten
      const legDurMin = legs.slice(0, n).map(l => Math.ceil((l.duration?.value || 0) / 60));
      let currentTime = START_TIME;
      etas    = [];
      legInfo = [];
      for (let step = 0; step < n; step++) {
        const apptIdx = step;
        const travelMin = legDurMin[step] || 0;
        const tw        = timeWindows[apptIdx];
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
      const legDurMin = legs.map(l => Math.ceil((l.duration?.value || 0) / 60));

      let currentTime = START_TIME;
      etas    = [];
      legInfo = [];

      gmOrder.forEach((apptIdx, step) => {
        const travelMin = legDurMin[step] || 0;
        const tw        = timeWindows[apptIdx];
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

  // Schendingen detecteren
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

  const methodTag = usedDistanceMatrix
    ? (fixedOrder ? 'distance-matrix+fixed-order' : 'distance-matrix')
    : (fixedOrder ? 'directions+fixed-order' : 'directions-fallback');

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
