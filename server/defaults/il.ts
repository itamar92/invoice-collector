import type { Settings } from '../settings.js';

/** Israeli defaults. The only place (with recipes/il/) where Israel-specific values live. */
const CATEGORY_NAMES = [
  'אחזקה ותיקונים', 'אינטרנט', 'ארנונה', 'דלק', 'הוצאות רפואיות', 'הנהלת חשבונות',
  'ועד בית', 'חזרות', 'חשבון גז', 'חשבון חשמל', 'טלפון', 'כיבודים ואוכל', 'מים',
  'ציוד משרדי', 'ציוד קבוע - מחשבים', 'קבלנות משנה', 'קידום ופרסום', 'תוכנות',
  'תחזוקה רכב', 'תרומות',
];

export const IL_DEFAULTS: Settings = {
  locale: 'he',
  currency: 'ILS',
  currencyLabel: 'שח',
  vatRate: 18,
  gmailLabel: null,
  gmailScopes: [],
  storageRoot: '',
  folderTemplate: '{root}/{year}/{category}',
  filenameTemplate: '{date}_{docType}_{vendor}_{description}_{amount}_{currency}',
  categories: CATEGORY_NAMES.map(name => ({ name, sendToAccounting: name !== 'הוצאות רפואיות' })),
  ai: { mode: 'none' },
  morning: { mode: null },
  setupComplete: false,
  backfillDone: false,
  backfillStartedAt: null,
  backfillFinishedAt: null,
  backfillResult: null,
  backfillError: null,
  pollMinutes: 15,
  timezone: 'Asia/Jerusalem',
  lastTickAt: null,
  lastTickError: null,
  lastAiSuccessAt: null,
  lastMissedScanAt: null,
};
