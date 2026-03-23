// Genereert een PDF-factuur die lijkt op de Tellow stijl van Hetekraan.
// Geeft een Buffer terug.

import PDFDocument from 'pdfkit';

const COMPANY = {
  name:    'Hetekraan',
  address: 'Zomerdijk 4',
  city:    '1631DC Oudendijk NH',
  country: 'Nederland',
  phone:   '0645471515',
  email:   'hetekraan@gmail.com',
  website: 'www.hetekraan.nl',
  kvk:     '75718057',
  btw:     'NL001625638B35',
  iban:    'NL37RABO0345687019',
  bic:     'RABONL2U',
};

const BTW_RATE = 0.21;

function formatEur(amount) {
  return '€ ' + amount.toFixed(2).replace('.', ',');
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return date.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function generateInvoicePDF({ invoiceNumber, customer, lines }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const now        = new Date();
    const dueDate    = addDays(now, 14);
    const pageWidth  = doc.page.width - 100; // margins

    // ── KLEUREN & FONTS ──────────────────────────────────────────────────────
    const BLACK  = '#1a1a1a';
    const GRAY   = '#666666';
    const LGRAY  = '#cccccc';
    const ACCENT = '#e65c20'; // oranje zoals hetekraan.nl

    // ── HEADER: bedrijfsnaam groot ───────────────────────────────────────────
    doc.fillColor(ACCENT)
       .font('Helvetica-Bold')
       .fontSize(26)
       .text(COMPANY.name, 50, 50);

    // ── BEDRIJFSGEGEVENS links ────────────────────────────────────────────────
    const companyY = 90;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    const companyLines = [
      COMPANY.address,
      COMPANY.city,
      COMPANY.country,
      `Tel: ${COMPANY.phone}`,
      `E-mail: ${COMPANY.email}`,
      `Website: ${COMPANY.website}`,
      `KVK: ${COMPANY.kvk}`,
      `BTW-id: ${COMPANY.btw}`,
      `IBAN: ${COMPANY.iban}`,
      `BIC: ${COMPANY.bic}`,
    ];
    companyLines.forEach((line, i) => {
      doc.text(line, 50, companyY + i * 13);
    });

    // ── FACTUURINFO rechts ────────────────────────────────────────────────────
    const rightX = 370;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    doc.text(`Factuurdatum:`,  rightX, companyY);
    doc.text(`Vervaldatum:`,   rightX, companyY + 13);
    doc.text(`Factuur`,        rightX, companyY + 26);

    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9);
    doc.text(formatDate(now),        rightX + 90, companyY,      { align: 'right', width: 90 });
    doc.text(formatDate(dueDate),    rightX + 90, companyY + 13, { align: 'right', width: 90 });
    doc.text(invoiceNumber,          rightX + 90, companyY + 26, { align: 'right', width: 90 });

    // ── KLANTGEGEVENS ─────────────────────────────────────────────────────────
    const customerY = companyY + companyLines.length * 13 + 20;

    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
       .text(customer.name || 'Klant', 50, customerY);

    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    let cy = customerY + 15;
    if (customer.address) { doc.text(customer.address, 50, cy); cy += 13; }
    if (customer.city)    { doc.text(customer.city,    50, cy); cy += 13; }
    if (customer.country) { doc.text(customer.country, 50, cy); cy += 13; }

    // ── TABEL HEADER ──────────────────────────────────────────────────────────
    const tableY = Math.max(cy + 20, 280);
    const cols = { desc: 50, qty: 310, price: 360, btw: 420, total: 470 };

    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9);
    doc.text('Omschrijving',      cols.desc,  tableY);
    doc.text('Aantal',            cols.qty,   tableY);
    doc.text('Bedrag',            cols.price, tableY);
    doc.text('BTW',               cols.btw,   tableY);
    doc.text('Totaal excl. BTW',  cols.total, tableY);

    // lijn onder header
    doc.moveTo(50, tableY + 14).lineTo(545, tableY + 14).strokeColor(LGRAY).stroke();

    // ── REGELS ────────────────────────────────────────────────────────────────
    let rowY = tableY + 20;
    let subtotalExcl = 0;

    doc.font('Helvetica').fontSize(9).fillColor(BLACK);

    for (const line of lines) {
      const exclBTW = line.price / (1 + BTW_RATE);
      subtotalExcl += exclBTW;

      doc.text(line.desc,           cols.desc,  rowY, { width: 250 });
      doc.text('1',                 cols.qty,   rowY);
      doc.text(formatEur(exclBTW),  cols.price, rowY);
      doc.text('21%',               cols.btw,   rowY);
      doc.text(formatEur(exclBTW),  cols.total, rowY);

      rowY += 18;
    }

    // ── TOTAALBLOK ────────────────────────────────────────────────────────────
    const btwAmount = subtotalExcl * BTW_RATE;
    const total     = subtotalExcl + btwAmount;

    doc.moveTo(50, rowY + 4).lineTo(545, rowY + 4).strokeColor(LGRAY).stroke();
    rowY += 14;

    const totRight = 545;
    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    doc.text('Subtotaal',    cols.total, rowY);
    doc.text(formatEur(subtotalExcl), totRight, rowY, { align: 'right', width: 75 });

    rowY += 14;
    doc.text('BTW 21%',      cols.total, rowY);
    doc.text(formatEur(btwAmount), totRight, rowY, { align: 'right', width: 75 });

    rowY += 14;
    doc.moveTo(cols.total, rowY).lineTo(totRight, rowY).strokeColor(LGRAY).stroke();
    rowY += 8;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK);
    doc.text('Totaal',       cols.total, rowY);
    doc.text(formatEur(total), totRight, rowY, { align: 'right', width: 75 });

    // ── BETAALVERZOEK ─────────────────────────────────────────────────────────
    rowY += 40;
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
       .text(
         'We verzoeken u vriendelijk het bovenstaande bedrag voor de genoemde vervaldatum te voldoen ' +
         'op onze bankrekening onder vermelding van het factuurnummer.',
         50, rowY, { width: pageWidth }
       );

    doc.end();
  });
}

// Berekent totaal incl. BTW op basis van de regellijst
export function calcInvoiceTotal(lines) {
  return lines.reduce((s, l) => s + l.price, 0);
}
