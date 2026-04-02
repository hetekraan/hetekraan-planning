/**
 * Planning / GHL: werktijden en dagdeel-split (Amsterdam).
 * Houd gelijk met opening hours in GHL (bijv. 08:00–18:00; middag vanaf 13:00).
 */

export const WORK_DAY_START_HOUR = 8;
export const WORK_DAY_END_HOUR = 18;

/** Startuur middagblok in Amsterdam (vrije slots / events met uur >= dit → middag). */
export const DAYPART_SPLIT_HOUR = 13;

/** Custom fields & dashboard (nl, en-dash). */
export const SLOT_LABEL_MORNING_NL = '08:00–13:00';
export const SLOT_LABEL_AFTERNOON_NL = '13:00–18:00';

/** Suggest-UI (spaties rond streepje). */
export const SLOT_LABEL_MORNING_SPACE = '08:00 - 13:00';
export const SLOT_LABEL_AFTERNOON_SPACE = '13:00 - 18:00';

/** Standaard GHL-start bij boeking als geen exacte suggest-tijd. */
export const DEFAULT_BOOK_START_MORNING = '08:00';
export const DEFAULT_BOOK_START_AFTERNOON = '13:00';
