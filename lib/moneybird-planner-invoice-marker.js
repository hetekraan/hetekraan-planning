/**
 * True als er op een [moneybird]-regel een echte factuur-URL (https?) staat.
 * Gebruikt voor o.a. retry-knop (planner).
 */
export function hasMoneybirdPlannerInvoiceUrlInNotes(notes, jobDescription) {
  const raw = `${String(notes || '')}\n${String(jobDescription || '')}`;
  const block = raw.match(/\[moneybird\][^\n\r]*/i);
  if (!block) return false;
  return /\burl=https?:\/\//i.test(block[0]);
}
