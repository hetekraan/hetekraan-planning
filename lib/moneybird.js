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
  const addressNorm = normalizeText(address);

  /** @type {Record<string, string>} */
  const contact = {};
  if (nameNorm) contact.company_name = nameNorm;
  if (emailNorm) contact.email = emailNorm;
  if (phoneNorm) contact.phone = phoneNorm;
  if (addressNorm) contact.address1 = addressNorm;

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
    return buildMoneybirdContactCreateBody({
      name: party?.displayName || 'Klant',
      email: party?.email,
      phone: party?.phone,
      address: party?.address1,
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
  const addr = normalizeText(party.address1);
  if (addr) c.address1 = addr;
  const zip = normalizeText(party.postalCode);
  if (zip) c.zipcode = zip;
  const city = normalizeText(party.city);
  if (city) c.city = city;
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

export async function findOrCreateContact(name, email, phone, address, options = {}) {
  const invoiceParty = options?.invoiceParty || null;
  const match = await findContactForInvoiceParty(
    invoiceParty || { invoiceType: 'particulier', email, phone, companyName: '' }
  );
  if (match?.found && match?.contact?.id) {
    return {
      contactId: String(match.contact.id),
      matched: true,
      created: false,
      contact: match.contact,
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
