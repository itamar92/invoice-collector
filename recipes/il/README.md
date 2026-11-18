# Israeli starter recipes

Declarative recipes (validated by `RecipeSchema`, regex via RE2) loaded by `loadStarterRecipes()`.
`vendors.json` maps each vendor key to its display name and default category (a name from the
Settings category list in `server/defaults/il.ts`; `kvish6` has none on purpose).
Only labels, layout patterns and company sender addresses were carried over from the source parsers:
no amounts, customer or account numbers, vehicle numbers or personal names.

Sources: `S` = account-manager `.claude/skills/invoice-expert/vendor-parsers/*.js` (+ `vendor-mapping.json`),
`N` = the n8n "Parsing Invoices" code nodes (+ Switch routing rules).

| Recipe | Source | Match | Notes |
|---|---|---|---|
| hot-mobile | S + N | sender | n8n version added the alternative total labels |
| partner | S + N | sender | total regex taken from n8n (the repo parser hard-coded the amount); `{` is the shekel glyph artifact |
| iec-hashmal | S + N | sender | one alternation covers the regular bill and the online-payment total labels; the amount-before-label RTL variant is not expressible |
| delek-ocr | S + N | text marker | OCR layout: amount on the line above the total label |
| arnona-hod-hasharon | S + N | sender | description is plain "ארנונה" (month range is not a placeholder) |
| akum | S | text markers | no known sender address in the source |
| carrefour | S (`carrefour.js` + `carrefour-global.js` merged) | text marker | same company, one recipe |
| heichal-hatarbut | S | text marker | |
| liveplay | S | sender domain | |
| tzmigei-shabtai | S | text marker | company tax id from the source deliberately not copied |
| bug-holland | S | sender domain | |
| ginzburg-music | S | text marker | description read from the "פרטים" line |
| kvish6 | S | text markers | no default category (travel is not in the category list) |
| or-habarak | S | text marker | vehicle number not copied; the free-mail sender in the source is deliberately not shipped (no free-mail senders in starter recipes) |
| eni-mobile | S | text marker | |
| morning | S + N | sender | **aiAlways** |
| 10ten | S + N | sender | **aiAlways** |
| meta-ads | S | text marker | **aiAlways** |
| cloudflare | S | sender | **aiAlways** |

## aiAlways recipes (only `match` filled)

- **morning**: Morning is a billing platform; the issuing business is read by position on the page and differs per invoice, so no fixed labels identify it.
- **10ten**: the source takes the largest plausible number in the text as the total; there is no label to anchor a pattern on.
- **meta-ads**: dates are English ("Mar 5, 2026"), which the recipe date formats do not support.
- **cloudflare**: dates are English ("March 5, 2026") and the invoice is in USD, which the recipe date formats do not support.

## Category mapping (source category to Settings category)

חשמל ומים to חשבון חשמל, ארנונה וועד בית to ארנונה, קבלני משנה to קבלנות משנה, רכב - דלק to דלק,
רכב - אחזקה תיקונים וחניה to תחזוקה רכב, כלי עבודה ציוד ואחזקה to אחזקה ותיקונים, כיבודים to כיבודים ואוכל,
פרסום to קידום ופרסום, תוכנה to תוכנות, סלולרי to טלפון. Partner keeps אינטרנט (its parser describes the document as an internet bill).
