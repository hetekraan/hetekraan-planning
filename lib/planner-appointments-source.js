function eventOverlapsAmsterdamDay(e, dateStr, deps) {
  const bounds = deps.amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return false;
  const startMs = deps.eventStartMsGhl(e);
  if (Number.isNaN(startMs)) {
    if (e?._hkGhlBlockSlot) return true;
    if (e?._hkBlockReservationSynthetic) return true;
    return false;
  }
  const endMs = deps.eventEndMsGhl(e);
  if (Number.isNaN(endMs)) {
    return deps.getEventStartDayAmsterdam(e) === dateStr;
  }
  const { startMs: dayStart, endMs: dayEnd } = bounds;
  return startMs <= dayEnd && endMs >= dayStart;
}

function dedupeGhlRealEventsForDashboard(list, deps) {
  const byId = new Set();
  const pass1 = [];
  for (const e of list) {
    const id = deps.canonicalGhlEventId(e);
    if (id) {
      if (byId.has(id)) continue;
      byId.add(id);
    }
    pass1.push(e);
  }

  pass1.sort((a, b) => (deps.eventStartMsGhl(a) || 0) - (deps.eventStartMsGhl(b) || 0));

  const firstSeenMs = new Map();
  const out = [];
  for (const e of pass1) {
    const rawCid = e.contactId || e.contact_id || e.contact?.id;
    const cid = rawCid != null && String(rawCid).trim() !== '' ? String(rawCid).trim() : '';
    const ms = deps.eventStartMsGhl(e);
    if (cid && !Number.isNaN(ms)) {
      const first = firstSeenMs.get(cid);
      if (first === undefined) {
        firstSeenMs.set(cid, ms);
      } else if (ms - first < 60 * 60 * 1000) {
        continue;
      } else {
        firstSeenMs.set(cid, ms);
      }
    }
    out.push(e);
  }
  return out;
}

function dedupeGhlEventsForDashboard(list, deps) {
  const reals = list.filter((e) => !e._hkBlockReservationSynthetic);
  const synthetics = list.filter((e) => e._hkBlockReservationSynthetic);
  const dedupedReals = dedupeGhlRealEventsForDashboard(reals, deps);
  const realCids = new Set(
    dedupedReals
      .map((e) => {
        const raw = e.contactId || e.contact_id || e.contact?.id;
        return raw != null && String(raw).trim() ? String(raw).trim() : '';
      })
      .filter(Boolean)
  );
  const synthKeep = synthetics.filter((e) => {
    const raw = e.contactId || e.contact_id;
    const cid = raw != null && String(raw).trim() ? String(raw).trim() : '';
    return cid && !realCids.has(cid);
  });
  const merged = [...dedupedReals, ...synthKeep];
  merged.sort((a, b) => (deps.eventStartMsGhl(a) || 0) - (deps.eventStartMsGhl(b) || 0));
  return merged;
}

export async function loadPlannerAppointmentsSource(input, deps) {
  const {
    date,
    locId,
    calId,
    apiKey,
    baseUrl,
    plannerNotitiesFieldId,
    plannerInternalFixedStartFieldId,
    invoicePartyFieldIdsForPlanner,
    traceLastEditedContactId,
  } = input;
  const gaT0 = Date.now();
  const gaPerf = {
    route: 'getAppointments',
    ghl_calendar_events_ms: 0,
    blocked_slots_ms: 0,
    redis_b1_synthetic_ms: 0,
    contact_fetch_sum_ms: 0,
    filter_dedupe_map_ms: 0,
  };
  const bounds = deps.amsterdamCalendarDayBoundsMs(date);
  if (!bounds) throw new Error('Ongeldige datum');
  const { startMs, endMs } = bounds;
  const blockSlotUserId = await deps.resolveBlockSlotAssignedUserId(baseUrl, apiKey, locId, calId);
  const url = `${baseUrl}/calendars/events?locationId=${encodeURIComponent(locId)}&calendarId=${encodeURIComponent(calId)}&startTime=${startMs}&endTime=${endMs}`;
  const calKey = deps.amsterdamDayReadCacheKeyCalendarEvents(locId, calId, date);
  const tCalEv = Date.now();
  let events = deps.amsterdamDayReadCacheGet(calKey);
  if (events !== undefined) {
    gaPerf.ghl_calendar_events_ms = Date.now() - tCalEv;
  } else {
    const response = await deps.fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
    });
    const rawText = await response.text().catch(() => '');
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }
    gaPerf.ghl_calendar_events_ms = Date.now() - tCalEv;
    events = data?.events || [];
    if (response.ok) deps.amsterdamDayReadCacheSet(calKey, events);
  }

  deps.markBlockLikeOnCalendarEvents(events);

  const blkKey = deps.amsterdamDayReadCacheKeyBlockedSlots(locId, calId, startMs, endMs, blockSlotUserId);
  const tBlk = Date.now();
  let blockedAsEvents = deps.amsterdamDayReadCacheGet(blkKey);
  if (blockedAsEvents === undefined) {
    const fetched = await deps.fetchBlockedSlotsAsEvents(baseUrl, {
      locationId: locId,
      calendarId: calId,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      apiKey,
      assignedUserId: blockSlotUserId,
    });
    blockedAsEvents = Array.isArray(fetched) ? fetched : [];
    deps.amsterdamDayReadCacheSet(blkKey, blockedAsEvents);
  }
  gaPerf.blocked_slots_ms = Date.now() - tBlk;
  if (blockedAsEvents.length) events = [...events, ...blockedAsEvents];

  let blockBookingSynthetic = [];
  try {
    const tRedis = Date.now();
    blockBookingSynthetic = await deps.cachedListConfirmedSyntheticEventsForDate(date);
    gaPerf.redis_b1_synthetic_ms = Date.now() - tRedis;
  } catch (err) {
    console.warn('[ghl] getAppointments block reservations:', err?.message || err);
  }
  for (const ev of blockBookingSynthetic) {
    const cid = String(ev.contactId || ev.contact_id || '').trim();
    if (!cid) continue;
    events.push({
      ...ev,
      id: `hk-b1:${cid}:${date}`,
      _hkBlockReservationSynthetic: true,
    });
  }

  const overlapsAmsterdamDay = events.map((e) => eventOverlapsAmsterdamDay(e, date, deps));
  const contactIdKey = (id) => (id == null ? '' : String(id).trim());
  const uniqueCids = [
    ...new Set(
      events
        .map((e, i) => (overlapsAmsterdamDay[i] ? contactIdKey(e.contactId || e.contact_id) : ''))
        .filter(Boolean)
    ),
  ];

  const contactMap = {};
  const tContacts0 = Date.now();
  await Promise.all(
    uniqueCids.map(async (cidKey) => {
      try {
        const cr = await deps.fetchWithRetry(`${baseUrl}/contacts/${encodeURIComponent(cidKey)}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
        });
        if (!cr.ok) return;
        const cd = await cr.json();
        contactMap[cidKey] = cd?.contact || cd;
      } catch (_) {}
    })
  );
  gaPerf.contact_fetch_sum_ms = Date.now() - tContacts0;

  function enrichEvent(e, contact) {
    e.contact = contact;
    if (contact?.id) e.contactId = contact.id;
    const canonStreetHouse = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.straat_huisnummer);
    const canonPostcode = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.postcode);
    const canonWoonplaats = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.woonplaats);
    const splitCanon = deps.splitAddressLineToStraatHuis(canonStreetHouse);
    const straat = splitCanon.straatnaam || '';
    const huisnr = splitCanon.huisnummer || '';
    const postcode =
      canonPostcode ||
      String(contact.postalCode || '')
        .replace(/\s+/g, ' ')
        .trim();
    const woonplaats = canonWoonplaats || contact.city || '';
    const fromCf = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const canonical = deps.readCanonicalAddressLine(contact);
    e.parsedAddress = canonical;
    if (traceLastEditedContactId && String(contact?.id || '') === String(traceLastEditedContactId)) {
      const traceFull = fromCf || canonical || '';
      console.log('[TRACE][mapped_address_after_edit]', {
        contactId: contact.id,
        straat_huisnummer: canonStreetHouse || null,
        postcode: canonPostcode || null,
        woonplaats: canonWoonplaats || null,
        address1: String(contact.address1 || '').trim() || null,
        fullAddressLine: traceFull || null,
      });
    }
    if (fromCf) {
      e.parsedStraatnaam = straat;
      e.parsedHuisnummer = huisnr;
      e.parsedPostcode = postcode;
      e.parsedWoonplaats = woonplaats;
    } else if (canonical) {
      e.parsedStraatnaam = canonical;
      e.parsedHuisnummer = '';
      e.parsedPostcode = '';
      e.parsedWoonplaats = '';
      deps.logCanonicalAddressRead('getAppointments_fallback_address1', {
        contactId: contact.id,
        preview: canonical.slice(0, 100),
      });
    } else {
      e.parsedStraatnaam = '';
      e.parsedHuisnummer = '';
      e.parsedPostcode = '';
      e.parsedWoonplaats = '';
    }
    const canonType = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.type_onderhoud);
    const canonWerkzaamheden = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.probleemomschrijving);
    const werkzaamheden = canonWerkzaamheden || deps.getField(contact, deps.FIELD_IDS.probleemomschrijving);
    e.parsedJobType = canonType || '';
    if (e._hkBlockReservationSynthetic) {
      const blk = e._hkSyntheticBlock === 'afternoon' ? 'afternoon' : 'morning';
      const windowLabel = blk === 'afternoon' ? deps.SLOT_LABEL_AFTERNOON_NL : deps.SLOT_LABEL_MORNING_NL;
      const titleStr = typeof e.title === 'string' ? e.title : '';
      const techTitle = titleStr.includes('__hk_block_res__');
      e.parsedWork =
        werkzaamheden ||
        (techTitle ? `Online geboekt — ${blk === 'morning' ? 'ochtend' : 'middag'} (${windowLabel})` : e.title);
    } else {
      e.parsedWork = werkzaamheden || e.title;
    }
    const canonPriceTotal = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.prijs_totaal);
    e.parsedPrice = canonPriceTotal || deps.getField(contact, deps.FIELD_IDS.prijs);
    const plannerNotities = plannerNotitiesFieldId ? deps.getField(contact, plannerNotitiesFieldId) : '';
    e.parsedNotes = plannerNotities || deps.getField(contact, deps.FIELD_IDS.opmerkingen);
    e.parsedTimeWindow =
      deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.tijdslot) ||
      deps.getField(contact, deps.FIELD_IDS.tijdafspraak) ||
      null;
    const rawInternalFixed = plannerInternalFixedStartFieldId
      ? deps.getField(contact, plannerInternalFixedStartFieldId, 'planner_internal_fixed_start')
      : '';
    const parsedInternalFixed = deps.normalizeInternalFixedPinFromBody(rawInternalFixed);
    e.internalFixedPin = parsedInternalFixed;
    e.internalFixedStartTime = parsedInternalFixed?.time || '';
    try {
      console.info(
        '[planner] fixed_time_loaded',
        JSON.stringify({
          contactId: contact?.id ? String(contact.id) : null,
          appointmentId: e?.id ? String(e.id) : null,
          fieldId: plannerInternalFixedStartFieldId || null,
          hasValue: Boolean(parsedInternalFixed),
          pinType: parsedInternalFixed?.type || null,
          pinTime: parsedInternalFixed?.time || null,
        })
      );
    } catch (_) {}
    const confirmedDayPartRaw = String(
      deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.boeking_bevestigd_dagdeel) || ''
    )
      .trim()
      .toLowerCase();
    e.parsedConfirmedDayPart =
      confirmedDayPartRaw === 'morning' || confirmedDayPartRaw === 'afternoon' ? confirmedDayPartRaw : null;
    e.parsedConfirmedDate = String(
      deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum) || ''
    ).trim();
    e.parsedConfirmedStatus = String(
      deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status) || ''
    )
      .trim()
      .toLowerCase();
    e.parsedPaymentStatus = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.betaal_status) || '';
    const canonPrijsRegels = deps.getField(contact, deps.BOOKING_FORM_FIELD_IDS.prijs_regels);
    let parsedPrijsRegels = deps.parseStructuredPriceRulesString(canonPrijsRegels);
    if (parsedPrijsRegels.length === 0) {
      const prijsRegelsRaw = deps.getField(contact, deps.FIELD_IDS.prijs_regels);
      parsedPrijsRegels = deps.parseStructuredPriceRulesString(prijsRegelsRaw);
    }
    e.parsedExtras = parsedPrijsRegels;
    e.invoiceFields = {
      factuurType: deps.readInvoicePartyField(contact, 'factuur_type', invoicePartyFieldIdsForPlanner),
      factuurBedrijfsnaam: deps.readInvoicePartyField(contact, 'factuur_bedrijfsnaam', invoicePartyFieldIdsForPlanner),
      factuurTav: deps.readInvoicePartyField(contact, 'factuur_tav', invoicePartyFieldIdsForPlanner),
      factuurEmail: deps.readInvoicePartyField(contact, 'factuur_email', invoicePartyFieldIdsForPlanner),
      factuurKvk: deps.readInvoicePartyField(contact, 'factuur_kvk', invoicePartyFieldIdsForPlanner),
      factuurBtwNummer: deps.readInvoicePartyField(contact, 'factuur_btw_nummer', invoicePartyFieldIdsForPlanner),
      factuurAdres: deps.readInvoicePartyField(contact, 'factuur_adres', invoicePartyFieldIdsForPlanner),
      factuurPostcode: deps.readInvoicePartyField(contact, 'factuur_postcode', invoicePartyFieldIdsForPlanner),
      factuurPlaats: deps.readInvoicePartyField(contact, 'factuur_plaats', invoicePartyFieldIdsForPlanner),
      factuurReferentie: deps.readInvoicePartyField(contact, 'factuur_referentie', invoicePartyFieldIdsForPlanner),
    };
  }

  const tEnrich0 = Date.now();
  const enriched = events.map((e, i) => {
    if (!overlapsAmsterdamDay[i]) return e;
    const rawCid = e.contactId || e.contact_id;
    if (!rawCid) return e;
    const cidKey = contactIdKey(rawCid);
    if (!cidKey) return e;
    e.contactId = rawCid;
    const contact = contactMap[cidKey];
    if (contact) enrichEvent(e, contact);
    return e;
  });
  gaPerf.contact_enrich_sync_ms = Date.now() - tEnrich0;

  const tFilt0 = Date.now();
  const filtered = enriched.filter((e, i) => overlapsAmsterdamDay[i]);
  const overlapDropped = enriched.length - filtered.length;
  if (overlapDropped > 0) {
    console.log(
      JSON.stringify({
        event: 'BOOKING_COMPLETE_FILTER',
        phase: 'overlap_amsterdam_day',
        dateStr: date,
        before: enriched.length,
        after: filtered.length,
        dropped: overlapDropped,
      })
    );
  }
  gaPerf.filter_overlap_ms = Date.now() - tFilt0;
  const tDedupe0 = Date.now();
  const unique = dedupeGhlEventsForDashboard(filtered, deps);
  if (filtered.length !== unique.length) {
    console.log(
      JSON.stringify({
        event: 'BOOKING_COMPLETE_FILTER',
        phase: 'dedupe',
        dateStr: date,
        before: filtered.length,
        after: unique.length,
        dropped: filtered.length - unique.length,
      })
    );
  }
  gaPerf.dedupe_ms = Date.now() - tDedupe0;
  const tMapAppt0 = Date.now();
  const appointments = unique.map((ev, i) => deps.mapEnrichedGhlEventToAppointment(ev, i, date));
  gaPerf.map_appointments_ms = Date.now() - tMapAppt0;
  gaPerf.total_ms = Date.now() - gaT0;
  gaPerf.unique_contact_fetches = uniqueCids.length;
  gaPerf.event_count_before_filter = enriched.length;

  return {
    appointments,
    contactMap,
    uniqueCids,
    enrichedCount: enriched.length,
    gaPerf,
    locId,
    date,
  };
}
