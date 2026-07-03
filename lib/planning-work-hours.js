/**
 * Twee begrippen (Phase 0 / Model B):
 *
 * 1) **Klant-boekingsblokken** (communicatie, custom fields, suggest-UI): ochtend **09:00–13:00**,
 *    middag **13:00–17:00** (Europe/Amsterdam). Zie `SLOT_LABEL_*` en `CUSTOMER_BLOCK_*_HOUR`.
 *
 * 2) **Interne werkdag-venster** (overlap met blokken / blocked-slots in `ghl-calendar-blocks.js`):
 *    **08:00–18:00** — breder venster waarbinnen we bepaalt of iets de “werkdag” raakt.
 *    Dit is niet hetzelfde als het beloofde klantvenster.
 *
 * `DAYPART_SPLIT_HOUR` blijft **13** (middag start om 13:00, gelijk met klant-middagblok).
 */

/** Intern: begin/einde werkdag voor block-overlap checks (Amsterdam muurtijd). */
export const WORK_DAY_START_HOUR = 8;
export const WORK_DAY_END_HOUR = 18;

/** Startuur middagblok; events met uur >= dit → afternoon (sync met klant middag 13:00). */
export const DAYPART_SPLIT_HOUR = 13;

/** Klant-ochtendblok [start, end) in uren Amsterdam (alleen voor expliciete logica / toekomstige module). */
export const CUSTOMER_BLOCK_MORNING_START_HOUR = 9;
export const CUSTOMER_BLOCK_MORNING_END_HOUR = 13;
/** Klant-middagblok [start, end). */
export const CUSTOMER_BLOCK_AFTERNOON_START_HOUR = 13;
export const CUSTOMER_BLOCK_AFTERNOON_END_HOUR = 17;

/** Custom fields & dashboard — klantvenster (nl, en-dash). */
export const SLOT_LABEL_MORNING_NL = '09:00–13:00';
export const SLOT_LABEL_AFTERNOON_NL = '13:00–17:00';

/** Suggest-UI & berichten (spaties rond streepje). */
export const SLOT_LABEL_MORNING_SPACE = '09:00 - 13:00';
export const SLOT_LABEL_AFTERNOON_SPACE = '13:00 - 17:00';

/**
 * Legacy: standaard GHL-start bij oude boekingspad (wall time) — ochtend **08:00**, niet 09:00.
 * Niet gebruiken voor nieuwe klant-copy; wél voor bestaande confirm/tokens tot Model B.
 */
export const DEFAULT_BOOK_START_MORNING = '08:00';
export const DEFAULT_BOOK_START_AFTERNOON = '13:00';

/**
 * Klant-aankomstvenster ("we komen tussen X en Y") rond de route-ETA.
 * ALTIJD 2,5 uur breed; ETA in het midden (ETA ± 1u15). Schuift tegen de randen
 * 09:00 / 18:00 (opschuiven, nooit afkappen — breedte blijft 150 min).
 *
 * LET OP: deze grenzen (09:00–18:00) staan LOS van de boekingsblokken
 * (ochtend 09:00–13:00 / middag 13:00–17:00) en van de optimizer-blokken.
 * Een late route-ETA mag een venster tot 18:00 opleveren, ook al eindigt het
 * middag-boekingsblok/optimizer-blok om 17:00.
 */
export const CUSTOMER_ARRIVAL_WINDOW_HALF_MINUTES = 75; // 1u15 aan weerszijden van de ETA
export const CUSTOMER_ARRIVAL_WINDOW_WIDTH_MINUTES = 150; // 2,5 uur totaal
export const CUSTOMER_ARRIVAL_WINDOW_START_MINUTES = CUSTOMER_BLOCK_MORNING_START_HOUR * 60; // 09:00
export const CUSTOMER_ARRIVAL_WINDOW_END_MINUTES = WORK_DAY_END_HOUR * 60; // 18:00
