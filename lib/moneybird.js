const MB_BASE = 'https://moneybird.com/api/v2';
const MB_TOKEN = process.env.MONEYBIRD_API_TOKEN;
const MB_ADMIN = process.env.MONEYBIRD_ADMINISTRATION_ID;

if (!MB_TOKEN || !MB_ADMIN) {
  console.warn('[moneybird] MONEYBIRD_API_TOKEN of MONEYBIRD_ADMINISTRATION_ID ontbreekt');
}

function mbHeaders() {
  return {
    Authorization: `Bearer ${MB_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function normalizePhone(phone) {
  const p = String(phone || '').trim();
  if (!p) return '';
  const hasPlus = p.startsWith('+');
  const digits = p.replace(/[^\d]/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

function normalizeText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function normalizeZipcode(v) {
  const raw = normalizeText(v).toUpperCase().replace(/\s+/g, '');
  const m = raw.match(/^(\d{4})([A-Z]{2})$/);
  if (!m) return '';
  return `${m[1]} ${m[2]}`;
}

function normalizeCountry(v) {
  const t = normalizeText(v).toLowerCase();
  if (!t) return '';
  if (t === 'nl' || t === 'nederland' || t === 'netherlands') return 'Netherlands';
  return normalizeText(v);
}

function parseDutchAddressLine(line) {
  const src = normalizeText(line);
  if (!src) return { address1: '', zipcode: '', city: '', parsed: false };
  const m = src.match(/^(.*?)(?:,)?\s*(\d{4}\s?[A-Za-z]{2})\s+(.+)$/);
  if (!m) return { address1: src, zipcode: '', city: '', parsed: false };
  const address1 = normalizeText(m[1].replace(/,\s*$/, ''));
  const zipcode = normalizeZipcode(m[2]);
  const city = normalizeText(m[3]);
  if (!zipcode || !city) return { address1: src, zipcode: '', city: '', parsed: false };
  return { address1: address1 || src, zipcode, city, parsed: true };
}

export function buildStructuredAddressFromContact(input = {}, logCtx = null) {
  const addressRaw =
    normalizeText(input.address1) ||
    normalizeText(input.address) ||
    normalizeText(input.fullAddressLine) ||
    '';
  const zipcodeRaw = normalizeZipcode(input.zipcode || input.postalCode || input.postcode || '');
  const cityRaw = normalizeText(input.city || input.plaats || input.woonplaats || '');
  const countryRaw = normalizeCountry(input.country || input.land || '');
  let address1 = addressRaw;
  let zipcode = zipcodeRaw;
  let city = cityRaw;
  if ((!zipcode || !city) && addressRaw) {
    const parsed = parseDutchAddressLine(addressRaw);
    if (parsed.parsed) {
      address1 = parsed.address1 || addressRaw;
      if (!zipcode) zipcode = parsed.zipcode;
      if (!city) city = parsed.city;
      console.info(
        '[moneybird] contact_address_normalized',
        JSON.stringify({
          contactId: logCtx?.contactId || null,
          appointmentId: logCtx?.appointmentId || null,
          normalizedZipcode: zipcode || null,
          normalizedCity: city || null,
          usedParse: true,
        })
      );
    } else if (logCtx) {
      console.info(
        '[moneybird] contact_address_parse_fallback',
        JSON.stringify({
          contactId: logCtx.contactId || null,
          appointmentId: logCtx.appointmentId || null,
          hasAddress: Boolean(addressRaw),
          hadZipcodeInput: Boolean(zipcodeRaw),
          hadCityInput: Boolean(cityRaw),
        })
      );
    }
  } else if (addressRaw && logCtx) {
    console.info(
      '[moneybird] contact_address_normalized',
      JSON.stringify({
        contactId: logCtx.contactId || null,
        appointmentId: logCtx.appointmentId || null,
        normalizedZipcode: zipcode || null,
        normalizedCity: city || null,
        usedParse: false,
      })
    );
  }
  const country = countryRaw || (zipcode ? 'Netherlands' : '');
  return {
    address1: normalizeText(address1),
    zipcode: normalizeZipcode(zipcode),
    city: normalizeText(city),
    country,
  };
}

function hasAddressData(c) {
  return Boolean(normalizeText(c?.address1) || normalizeZipcode(c?.zipcode) || normalizeText(c?.city));
}

function addressLooksInferior(existing, desired) {
  const exA = normalizeText(existing?.address1);
  const exZ = normalizeZipcode(existing?.zipcode);
  const exC = normalizeText(existing?.city);
  const deA = normalizeText(desired?.address1);
  const deZ = normalizeZipcode(desired?.zipcode);
  const deC = normalizeText(desired?.city);
  if (!deA && !deZ && !deC) return false;
  if (!exA && (deA || deZ || deC)) return true;
  if (!exZ && deZ) return true;
  if (!exC && deC) return true;
  if ((exZ || exC) && deA) {
    const exNorm = exA.toLowerCase();
    const zNorm = exZ.toLowerCase();
    const cNorm = exC.toLowerCase();
    if (zNorm && exNorm.includes(zNorm)) return true;
    if (cNorm && exNorm.includes(cNorm.toLowerCase())) return true;
  }
  return false;
}

function buildContactSyncPatch(existing, desired) {
  const patch = {};
  const existingEmail = normalizeText(existing?.email).toLowerCase();
  const desiredEmail = normalizeText(desired?.email).toLowerCase();
  const existingPhone = normalizePhone(existing?.phone);
  const desiredPhone = normalizePhone(desired?.phone);
  const existingAddress = buildStructuredAddressFromContact(existing);
  const desiredAddress = buildStructuredAddressFromContact(desired);
  if (!existingEmail && desiredEmail) patch.email = desiredEmail;
  if (!existingPhone && desiredPhone) patch.phone = desiredPhone;
  const improveAddress = addressLooksInferior(existingAddress, desiredAddress);
  if (improveAddress) {
    if (desiredAddress.address1) patch.address1 = desiredAddress.address1;
    if (desiredAddress.zipcode) patch.zipcode = desiredAddress.zipcode;
    if (desiredAddress.city) patch.city = desiredAddress.city;
    if (desiredAddress.country) patch.country = desiredAddress.country;
  }
  return { patch, existingAddress, desiredAddress };
}

export function planMoneybirdContactSyncPatch(existing, desired) {
  return buildContactSyncPatch(existing, desired);
}

function toMoneybirdError(status, body, fallback) {
  const details = typeof body === 'string' ? body : JSON.stringify(body || {});
  const msg = `${fallback} (status ${status})`;
  const err = new Error(`${msg}: ${details.slice(0, 500)}`);
  err.status = status;
  err.details = body;
  return err;
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    const txt = await res.text().catch(() => '');
    return txt || null;
  }
}

async function mbRequest(path, options = {}) {
  if (!MB_TOKEN || !MB_ADMIN) {
    throw new Error('Moneybird niet geconfigureerd (MONEYBIRD_API_TOKEN/MONEYBIRD_ADMINISTRATION_ID)');
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${MB_BASE}/${MB_ADMIN}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...mbHeaders(),
        ...(options.headers || {}),
      },
    });
    const body = await readJsonSafe(res);
    if (!res.ok) {
      throw toMoneybirdError(res.status, body, `Moneybird request failed: ${options.method || 'GET'} ${path}`);
    }
    return body;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Moneybird timeout na ${timeoutMs}ms (${options.method || 'GET'} ${path})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function findContactByEmailOrPhone({ email, phone } = {}) {
  const emailNorm = normalizeText(email).toLowerCase();
  const phoneNorm = normalizePhone(phone);
  const query = emailNorm || phoneNorm;
  if (!query) return { found: false, contact: null, reason: 'no_email_or_phone' };
  const data = await mbRequest(`/contacts.json?query=${encodeURIComponent(query)}`, { method: 'GET' });
  const contacts = Array.isArray(data) ? data : [];
  const contact = contacts.find((c) => {
    const cEmail = normalizeText(c?.email).toLowerCase();
    const cPhone = normalizePhone(c?.phone);
    if (emailNorm && cEmail === emailNorm) return true;
    if (!emailNorm && phoneNorm && cPhone === phoneNorm) return true;
    return false;
  }) || contacts[0] || null;
  return { found: !!contact, contact };
}

/**
 * Zoek bestaand Moneybird-contact voor zakelijke factuur: company_name match, bij voorkeur + zelfde e-mail.
 */
async function findMoneybirdContactForCompanyParty(party) {
  const company = normalizeText(party?.companyName);
  if (!company) return { found: false, contact: null, reason: 'no_company_name' };
  const emailNorm = normalizeText(party?.email).toLowerCase();
  const queries = [company];
  if (emailNorm) queries.push(emailNorm);
  for (const q of queries) {
    const data = await mbRequest(`/contacts.json?query=${encodeURIComponent(q)}`, { method: 'GET' });
    const list = Array.isArray(data) ? data : [];
    const sameCo = list.filter(
      (c) => normalizeText(c?.company_name).toLowerCase() === company.toLowerCase()
    );
    if (emailNorm) {
      const hit = sameCo.find((c) => normalizeText(c?.email).toLowerCase() === emailNorm);
      if (hit) return { found: true, contact: hit };
    }
    if (sameCo.length === 1) return { found: true, contact: sameCo[0] };
    if (sameCo.length > 1 && emailNorm) {
      const hit = sameCo.find((c) => normalizeText(c?.email).toLowerCase() === emailNorm);
      if (hit) return { found: true, contact: hit };
    }
  }
  return { found: false, contact: null };
}

export async function findContactForInvoiceParty(party) {
  if (!party || party.invoiceType !== 'bedrijf' || !party.companyName) {
    return findContactByEmailOrPhone({ email: party?.email, phone: party?.phone });
  }
  return findMoneybirdContactForCompanyParty(party);
}

/**
 * Moneybird POST /contacts.json verwacht root `{ contact: { ... } }` (anders 400 "Contact is required").
 * Lege strings weglaten — geen `email` key zonder waarde.
 */
function buildMoneybirdContactCreateBody({ name, email, phone, address } = {}) {
  const nameNorm = normalizeText(name) || 'Klant';
  const emailNorm = normalizeText(email).toLowerCase();
  const phoneNorm = normalizePhone(phone);
  const normalizedAddress = buildStructuredAddressFromContact({ address1: address, country: 'Netherlands' });

  /** @type {Record<string, string>} */
  const contact = {};
  if (nameNorm) contact.company_name = nameNorm;
  if (emailNorm) contact.email = emailNorm;
  if (phoneNorm) contact.phone = phoneNorm;
  if (normalizedAddress.address1) contact.address1 = normalizedAddress.address1;
  if (normalizedAddress.zipcode) contact.zipcode = normalizedAddress.zipcode;
  if (normalizedAddress.city) contact.city = normalizedAddress.city;
  if (normalizedAddress.country) contact.country = normalizedAddress.country;

  return { contact, meta: { nameNorm, hadEmail: !!emailNorm } };
}

function splitNameForMoneybirdPerson(displayName) {
  const t = normalizeText(displayName) || 'Klant';
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstname: 'Klant', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0].slice(0, 60), lastname: '-' };
  return { firstname: parts[0].slice(0, 60), lastname: parts.slice(1).join(' ').slice(0, 120) };
}

/**
 * Moneybird contact body vanuit invoiceParty (bedrijf of particulier).
 */
function buildMoneybirdContactCreateBodyFromParty(party) {
  if (!party || party.invoiceType !== 'bedrijf' || !party.companyName) {
    const normalizedAddress = buildStructuredAddressFromContact({
      address1: party?.address1,
      postalCode: party?.postalCode,
      city: party?.city,
      country: party?.country || 'Netherlands',
    });
    return buildMoneybirdContactCreateBody({
      name: party?.displayName || 'Klant',
      email: party?.email,
      phone: party?.phone,
      address: normalizedAddress.address1,
    });
  }

  const emailNorm = normalizeText(party.email).toLowerCase();
  const phoneNorm = normalizePhone(party.phone);
  const attn = normalizeText(party.attention) || normalizeText(party.displayName) || '';
  const { firstname, lastname } = splitNameForMoneybirdPerson(attn);

  /** @type {Record<string, string>} */
  const c = {};
  c.company_name = normalizeText(party.companyName);
  if (firstname) c.firstname = firstname;
  if (lastname) c.lastname = lastname;
  if (emailNorm) c.email = emailNorm;
  if (phoneNorm) c.phone = phoneNorm;
  const normalizedAddress = buildStructuredAddressFromContact({
    address1: party?.address1,
    postalCode: party?.postalCode,
    city: party?.city,
    country: party?.country || 'Netherlands',
  });
  if (normalizedAddress.address1) c.address1 = normalizedAddress.address1;
  if (normalizedAddress.zipcode) c.zipcode = normalizedAddress.zipcode;
  if (normalizedAddress.city) c.city = normalizedAddress.city;
  if (normalizedAddress.country) c.country = normalizedAddress.country;
  const kvk = normalizeText(party.kvk);
  if (kvk) c.chamber_of_commerce = kvk;
  const btw = normalizeText(party.vatNumber);
  if (btw) c.tax_number = btw;

  return {
    contact: c,
    meta: { nameNorm: c.company_name, hadEmail: !!emailNorm, mode: 'company' },
  };
}

export async function createContact({ name, email, phone, address, invoiceParty } = {}) {
  const { contact: inner, meta } = invoiceParty
    ? buildMoneybirdContactCreateBodyFromParty(invoiceParty)
    : buildMoneybirdContactCreateBody({ name, email, phone, address });
  if (!inner.email && !inner.phone && !inner.address1 && meta.nameNorm === 'Klant') {
    return { created: false, contact: null, reason: 'insufficient_contact_data' };
  }

  const bodyObj = { contact: inner };
  console.info(
    '[moneybird] contact_create_request',
    JSON.stringify({
      keys: Object.keys(inner),
      hasEmail: !!inner.email,
      hasPhone: !!inner.phone,
      hasAddress: !!inner.address1,
      companyNameLen: inner.company_name ? inner.company_name.length : 0,
      mode: meta?.mode || 'private',
    })
  );

  try {
    const raw = await mbRequest('/contacts.json', {
      method: 'POST',
      body: JSON.stringify(bodyObj),
    });
    const created =
      raw && typeof raw === 'object' && raw.id != null
        ? raw
        : raw?.contact && typeof raw.contact === 'object'
          ? raw.contact
          : raw;
    console.info(
      '[moneybird] contact_create_response',
      JSON.stringify({
        id: created?.id != null ? String(created.id) : null,
        hasEmailReturned: Boolean(normalizeText(created?.email)),
      })
    );
    if (!inner.email) {
      console.info(
        '[moneybird] contact_created_without_email',
        JSON.stringify({
          id: created?.id != null ? String(created.id) : null,
          hasPhone: !!inner.phone,
          hasAddress: !!inner.address1,
        })
      );
    }
    return { created: !!created?.id, contact: created || null };
  } catch (err) {
    console.error(
      '[moneybird] contact_create_failed',
      JSON.stringify({
        status: err?.status,
        message: String(err?.message || err).slice(0, 400),
      })
    );
    return { created: false, contact: null, reason: 'moneybird_contact_create_failed' };
  }
}

async function updateContact(contactId, patch = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const norm = k === 'phone' ? normalizePhone(v) : normalizeText(v);
    if (norm) clean[k] = norm;
  }
  if (!Object.keys(clean).length) return { updated: false, contact: null, reason: 'no_patch' };
  try {
    const raw = await mbRequest(`/contacts/${encodeURIComponent(String(contactId))}.json`, {
      method: 'PATCH',
      body: JSON.stringify({ contact: clean }),
    });
    const contact =
      raw && typeof raw === 'object' && raw.id != null
        ? raw
        : raw?.contact && typeof raw.contact === 'object'
          ? raw.contact
          : raw;
    return { updated: !!contact?.id, contact: contact || null, patch: clean };
  } catch (err) {
    console.warn(
      '[moneybird] contact_sync_update_failed',
      JSON.stringify({
        moneybirdContactId: String(contactId || ''),
        keys: Object.keys(clean),
        message: String(err?.message || err).slice(0, 200),
        status: err?.status || null,
      })
    );
    return { updated: false, contact: null, reason: 'moneybird_contact_update_failed', patch: clean };
  }
}

export async function findOrCreateContact(name, email, phone, address, options = {}) {
  const invoiceParty = options?.invoiceParty || null;
  const match = await findContactForInvoiceParty(
    invoiceParty || { invoiceType: 'particulier', email, phone, companyName: '' }
  );
  if (match?.found && match?.contact?.id) {
    const desired = invoiceParty
      ? buildMoneybirdContactCreateBodyFromParty(invoiceParty).contact
      : buildMoneybirdContactCreateBody({ name, email, phone, address }).contact;
    const hadEmailBefore = Boolean(normalizeText(match.contact?.email));
    const hadAddressBefore = hasAddressData(match.contact);
    const desiredAddress = buildStructuredAddressFromContact({
      address1: desired?.address1,
      zipcode: desired?.zipcode,
      city: desired?.city,
      country: desired?.country,
    });
    console.info(
      '[moneybird] contact_sync_before',
      JSON.stringify({
        moneybirdContactId: String(match.contact.id),
        hadEmailBefore,
        hadAddressBefore,
        hasEmailDesired: Boolean(normalizeText(desired?.email)),
        hasAddressDesired: Boolean(desiredAddress.address1 || desiredAddress.zipcode || desiredAddress.city),
      })
    );
    const { patch, existingAddress } = buildContactSyncPatch(match.contact, desired);
    let syncedContact = match.contact;
    if (Object.keys(patch).length) {
      console.info(
        '[moneybird] contact_sync_update_needed',
        JSON.stringify({
          moneybirdContactId: String(match.contact.id),
          keys: Object.keys(patch),
          normalizedZipcode: normalizeZipcode(patch.zipcode || desiredAddress.zipcode) || null,
          normalizedCity: normalizeText(patch.city || desiredAddress.city) || null,
        })
      );
      const updated = await updateContact(match.contact.id, patch);
      if (updated?.updated && updated?.contact) {
        syncedContact = updated.contact;
        const hasEmailAfter = Boolean(normalizeText(syncedContact?.email));
        const hasAddressAfter = hasAddressData(syncedContact);
        console.info(
          '[moneybird] contact_sync_updated',
          JSON.stringify({
            moneybirdContactId: String(match.contact.id),
            hadEmailBefore,
            hasEmailAfter,
            hadAddressBefore,
            hasAddressAfter,
            normalizedZipcode: normalizeZipcode(syncedContact?.zipcode || patch.zipcode) || null,
            normalizedCity: normalizeText(syncedContact?.city || patch.city) || null,
          })
        );
        if (!hadEmailBefore && hasEmailAfter) {
          console.info(
            '[moneybird] contact_email_missing_updated',
            JSON.stringify({
              moneybirdContactId: String(match.contact.id),
              hadEmailBefore: false,
              hasEmailAfter: true,
            })
          );
        }
      }
    } else {
      console.info(
        '[moneybird] contact_sync_update_needed',
        JSON.stringify({
          moneybirdContactId: String(match.contact.id),
          keys: [],
          normalizedZipcode: existingAddress.zipcode || null,
          normalizedCity: existingAddress.city || null,
        })
      );
    }
    return {
      contactId: String(match.contact.id),
      matched: true,
      created: false,
      contact: syncedContact,
    };
  }
  const created = await createContact({ name, email, phone, address, invoiceParty });
  if (created?.created && created?.contact?.id) {
    return {
      contactId: String(created.contact.id),
      matched: false,
      created: true,
      contact: created.contact,
    };
  }
  return {
    contactId: null,
    matched: false,
    created: false,
    reason: created?.reason || match?.reason || 'contact_not_found_or_created',
  };
}

// Exacte match op `reference`; bewust begrensd tot 10 pagina's voor performance.
export async function findExistingInvoiceByReference(reference) {
  const ref = normalizeText(reference);
  if (!ref) return { found: false, invoice: null };
  const refLower = ref.toLowerCase();

  let invoice = null;
  let queryReachedPage10 = false;
  let recentReachedPage10 = false;
  // Zoek eerst gericht met query (meerdere pagina's voor zekerheid).
  for (let page = 1; page <= 10; page += 1) {
    const queryData = await mbRequest(
      `/sales_invoices.json?query=${encodeURIComponent(ref)}&page=${page}`,
      { method: 'GET' }
    );
    const queryInvoices = Array.isArray(queryData) ? queryData : [];
    invoice = queryInvoices.find((inv) => normalizeText(inv?.reference).toLowerCase() === refLower) || null;
    if (page === 10 && queryInvoices.length > 0 && !invoice) queryReachedPage10 = true;
    if (invoice || queryInvoices.length === 0) break;
  }

  // Fallback: scan recente facturen pagina's zonder query (exacte ref-match).
  if (!invoice) {
    for (let page = 1; page <= 10; page += 1) {
      const recentData = await mbRequest(`/sales_invoices.json?page=${page}`, { method: 'GET' });
      const recentInvoices = Array.isArray(recentData) ? recentData : [];
      invoice = recentInvoices.find((inv) => normalizeText(inv?.reference).toLowerCase() === refLower) || null;
      if (page === 10 && recentInvoices.length > 0 && !invoice) recentReachedPage10 = true;
      if (invoice || recentInvoices.length === 0) break;
    }
  }
  if (!invoice && (queryReachedPage10 || recentReachedPage10)) {
    console.warn('[moneybird] invoice lookup horizon mogelijk bereikt (10 pagina\'s)', { reference: ref });
  }
  return { found: !!invoice, invoice };
}

export async function createSalesInvoice({ contactId, lines, reference, description }) {
  if (!contactId) return { created: false, invoice: null, reason: 'missing_contact_id' };
  const details = Array.isArray(lines)
    ? lines.map((l) => ({
      description: normalizeText(l?.desc),
      price: String(Number(l?.price) || 0),
      amount: '1',
      tax_rate_id: null,
    })).filter((l) => l.description && Number(l.price) > 0 && Number.isFinite(Number(l.price)))
    : [];
  if (details.length === 0) return { created: false, invoice: null, reason: 'no_valid_lines' };
  const invoice = await mbRequest('/sales_invoices.json', {
    method: 'POST',
    body: JSON.stringify({
      sales_invoice: {
        contact_id: contactId,
        reference: normalizeText(reference || description),
        details_attributes: details,
      },
    }),
  });
  return {
    created: !!invoice?.id,
    invoice: invoice || null,
  };
}

export async function updateSalesInvoiceDraft({ invoiceId, lines, reference, description } = {}) {
  const id = normalizeText(invoiceId);
  if (!id) return { updated: false, invoice: null, reason: 'missing_invoice_id' };
  const details = Array.isArray(lines)
    ? lines.map((l) => ({
      description: normalizeText(l?.desc),
      price: String(Number(l?.price) || 0),
      amount: '1',
      tax_rate_id: null,
    })).filter((l) => l.description && Number(l.price) > 0 && Number.isFinite(Number(l.price)))
    : [];
  if (details.length === 0) return { updated: false, invoice: null, reason: 'no_valid_lines' };
  try {
    const invoice = await mbRequest(`/sales_invoices/${encodeURIComponent(id)}.json`, {
      method: 'PATCH',
      body: JSON.stringify({
        sales_invoice: {
          ...(normalizeText(reference) ? { reference: normalizeText(reference) } : {}),
          ...(normalizeText(description) ? { description: normalizeText(description) } : {}),
          details_attributes: details,
        },
      }),
    });
    return { updated: !!invoice?.id, invoice: invoice || null };
  } catch (err) {
    return {
      updated: false,
      invoice: null,
      reason: 'invoice_update_failed',
      status: err?.status,
      message: String(err?.message || err),
    };
  }
}

export async function getSalesInvoiceById(invoiceId) {
  const id = normalizeText(invoiceId);
  if (!id) return { found: false, invoice: null, reason: 'missing_invoice_id' };
  const invoice = await mbRequest(`/sales_invoices/${encodeURIComponent(id)}.json`, { method: 'GET' });
  return { found: !!invoice?.id, invoice: invoice || null };
}

export function resolveSalesInvoicePaymentUrl(invoice) {
  const inv = invoice && typeof invoice === 'object' ? invoice : {};
  const paymentUrl = normalizeText(inv.payment_url);
  if (paymentUrl) return { url: paymentUrl, source: 'payment_url' };
  const url = normalizeText(inv.url);
  if (url) return { url, source: 'url' };
  const publicViewUrl = normalizeText(inv.public_view_url);
  if (publicViewUrl) return { url: publicViewUrl, source: 'legacy_public_view_url' };
  return { url: '', source: '' };
}

export async function sendSalesInvoiceByEmail({ invoiceId, emailAddress, emailMessage } = {}) {
  const id = normalizeText(invoiceId);
  const email = normalizeText(emailAddress).toLowerCase();
  if (!id) return { sent: false, reason: 'missing_invoice_id' };
  if (!email) return { sent: false, reason: 'missing_email' };
  const data = await mbRequest(`/sales_invoices/${encodeURIComponent(id)}/send_invoice.json`, {
    method: 'PATCH',
    body: JSON.stringify({
      sales_invoice_sending: {
        delivery_method: 'Email',
        email_address: email,
        ...(normalizeText(emailMessage) ? { email_message: normalizeText(emailMessage) } : {}),
      },
    }),
  });
  return {
    sent: true,
    result: data || null,
  };
}
