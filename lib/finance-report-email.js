/**
 * Stelt het dagelijks financieel overzicht samen (HTML + platte tekst).
 * Puur presentatie — geen API-calls — zodat het los te testen is.
 */

import { formatDutchDate } from './btw-aangifte.js';

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

function euro(n) {
  return EUR.format(Number(n) || 0);
}

function sum(items, key = 'amount') {
  return (items || []).reduce((acc, it) => acc + (Number(it?.[key]) || 0), 0);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dateNl(dateStr) {
  return dateStr ? formatDutchDate(dateStr) : '—';
}

function link(url, label) {
  const u = String(url || '').trim();
  if (!u) return esc(label);
  return `<a href="${esc(u)}" style="color:#2563eb;text-decoration:none;">${esc(label)}</a>`;
}

const EMPTY = '<p style="margin:4px 0 0;color:#16a34a;">Niets openstaand</p>';

function section(title, bodyHtml) {
  return `
    <h2 style="font-size:16px;margin:24px 0 8px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:4px;">${esc(title)}</h2>
    ${bodyHtml}
  `;
}

function table(headers, rowsHtml) {
  const ths = headers
    .map(
      (h) =>
        `<th align="${h.align || 'left'}" style="text-align:${h.align || 'left'};font-size:12px;color:#6b7280;padding:4px 8px;border-bottom:1px solid #e5e7eb;">${esc(h.label)}</th>`
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>${ths}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

function td(content, align = 'left') {
  return `<td align="${align}" style="text-align:${align};padding:6px 8px;border-bottom:1px solid #f3f4f6;">${content}</td>`;
}

function purchaseTable(items) {
  if (!items.length) return EMPTY;
  const rows = items
    .map((it) => {
      const label = it.reference ? `${it.supplier} (${it.reference})` : it.supplier;
      return `<tr>${td(link(it.url, label))}${td(dateNl(it.dueDate))}${td(euro(it.amount), 'right')}</tr>`;
    })
    .join('');
  return table(
    [{ label: 'Leverancier' }, { label: 'Vervaldatum' }, { label: 'Bedrag', align: 'right' }],
    rows
  );
}

function salesTable(items) {
  if (!items.length) return EMPTY;
  const rows = items
    .map((it) => {
      const label = it.reference ? `${it.customer} (${it.reference})` : it.customer;
      return `<tr>${td(link(it.url, label))}${td(dateNl(it.dueDate))}${td(euro(it.amount), 'right')}</tr>`;
    })
    .join('');
  return table(
    [{ label: 'Klant' }, { label: 'Vervaldatum' }, { label: 'Bedrag', align: 'right' }],
    rows
  );
}

function mutationTable(items) {
  if (!items.length) return EMPTY;
  const rows = items
    .map(
      (it) =>
        `<tr>${td(dateNl(it.date))}${td(link(it.url, it.counterparty))}${td(euro(it.amount), 'right')}</tr>`
    )
    .join('');
  return table(
    [{ label: 'Datum' }, { label: 'Tegenpartij' }, { label: 'Bedrag', align: 'right' }],
    rows
  );
}

function noAttachmentTable(items) {
  if (!items.length) return EMPTY;
  const rows = items
    .map((it) => {
      const label = it.reference ? `${it.supplier} (${it.reference})` : it.supplier;
      return `<tr>${td(link(it.url, label))}${td(euro(it.amount), 'right')}</tr>`;
    })
    .join('');
  return table([{ label: 'Leverancier' }, { label: 'Bedrag', align: 'right' }], rows);
}

/**
 * @param {{
 *   dateStr: string,
 *   isMonday: boolean,
 *   purchaseDue: Array,
 *   salesOverdue: Array|null,
 *   unprocessed: Array,
 *   noAttachment: Array,
 *   btw: {quarter:string, deadlineLabel:string, daysUntil:number}|null,
 * }} data
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildFinanceReportEmail(data) {
  const {
    dateStr,
    isMonday = false,
    purchaseDue = [],
    salesOverdue = null,
    unprocessed = [],
    noAttachment = [],
    btw = null,
  } = data || {};

  const totalTeBetalen = sum(purchaseDue);
  const totalTeHerinneren = isMonday ? sum(salesOverdue || []) : 0;

  const subject = `Financieel overzicht ${dateNl(dateStr)} — te betalen ${euro(totalTeBetalen)}`;

  // Samenvattingsregel bovenaan.
  const summaryParts = [`<strong>Te betalen:</strong> ${euro(totalTeBetalen)}`];
  if (isMonday) {
    summaryParts.push(`<strong>Te herinneren:</strong> ${euro(totalTeHerinneren)}`);
  }
  const summary = `<p style="font-size:15px;margin:0 0 8px;color:#111827;">${summaryParts.join(' &nbsp;·&nbsp; ')}</p>`;

  let html = '';
  html += summary;
  html += section('Te betalen', purchaseTable(purchaseDue));
  if (isMonday) {
    html += section('Te herinneren klanten', salesTable(salesOverdue || []));
  }
  html += section('Betaald zonder bonnetje/factuur', mutationTable(unprocessed));
  html += section('Facturen zonder bijlage', noAttachmentTable(noAttachment));
  if (btw) {
    const body = `<p style="margin:4px 0 0;color:#b45309;">De btw-aangifte (${esc(btw.quarter)}) moet uiterlijk <strong>${esc(btw.deadlineLabel)}</strong> ingediend en betaald zijn (over ${btw.daysUntil} dag${btw.daysUntil === 1 ? '' : 'en'}).</p>`;
    html += section('BTW-aangifte', body);
  }

  const wrapped = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#111827;">
    <h1 style="font-size:18px;margin:0 0 12px;">Dagelijks financieel overzicht</h1>
    <p style="font-size:13px;color:#6b7280;margin:0 0 12px;">${dateNl(dateStr)}</p>
    ${html}
  </div>`;

  const text = buildText({
    dateStr,
    isMonday,
    totalTeBetalen,
    totalTeHerinneren,
    purchaseDue,
    salesOverdue,
    unprocessed,
    noAttachment,
    btw,
  });

  return { subject, html: wrapped, text };
}

function buildText(d) {
  const lines = [];
  lines.push(`Dagelijks financieel overzicht — ${dateNl(d.dateStr)}`);
  lines.push('');
  lines.push(`Te betalen: ${euro(d.totalTeBetalen)}`);
  if (d.isMonday) lines.push(`Te herinneren: ${euro(d.totalTeHerinneren)}`);
  lines.push('');

  lines.push('== Te betalen ==');
  if (!d.purchaseDue.length) lines.push('Niets openstaand');
  else
    d.purchaseDue.forEach((it) =>
      lines.push(`- ${it.supplier}${it.reference ? ` (${it.reference})` : ''} — ${euro(it.amount)} — verval ${dateNl(it.dueDate)} — ${it.url}`)
    );
  lines.push('');

  if (d.isMonday) {
    lines.push('== Te herinneren klanten ==');
    const s = d.salesOverdue || [];
    if (!s.length) lines.push('Niets openstaand');
    else
      s.forEach((it) =>
        lines.push(`- ${it.customer}${it.reference ? ` (${it.reference})` : ''} — ${euro(it.amount)} — verval ${dateNl(it.dueDate)} — ${it.url}`)
      );
    lines.push('');
  }

  lines.push('== Betaald zonder bonnetje/factuur ==');
  if (!d.unprocessed.length) lines.push('Niets openstaand');
  else
    d.unprocessed.forEach((it) =>
      lines.push(`- ${dateNl(it.date)} — ${it.counterparty} — ${euro(it.amount)} — ${it.url}`)
    );
  lines.push('');

  lines.push('== Facturen zonder bijlage ==');
  if (!d.noAttachment.length) lines.push('Niets openstaand');
  else
    d.noAttachment.forEach((it) =>
      lines.push(`- ${it.supplier}${it.reference ? ` (${it.reference})` : ''} — ${euro(it.amount)} — ${it.url}`)
    );
  lines.push('');

  if (d.btw) {
    lines.push('== BTW-aangifte ==');
    lines.push(`Uiterlijk ${d.btw.deadlineLabel} (${d.btw.quarter}) indienen en betalen — over ${d.btw.daysUntil} dagen.`);
  }

  return lines.join('\n');
}
