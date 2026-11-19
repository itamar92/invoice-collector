# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One owner per instance (self-hosted, single user). They open it often from a phone, sometimes from a desktop,
for a couple of minutes at a time.

## Product Purpose

Collects invoices and receipts from Gmail, extracts their fields with per-vendor recipes and an AI fallback,
files the PDF in Dropbox and hands the expense to the accounting system (Morning). The owner's main job in the
UI is to clear what needs them: decide on new vendors (business / personal / ignore), fix items that failed,
then leave. Success is an empty queue and nothing silently lost.

## Positioning

Self-hosted and rule-based first: explicit per-vendor recipes do the work, AI is only the fallback, and nothing
is filed or sent to accounting without passing validation and duplicate checks.

## Operating Context

Gmail (optionally one label) as the source, Dropbox as the archive, Morning as the accounting destination.
Paper receipts come in as a photo or PDF, uploaded in the app or sent to a Telegram bot.
A background worker runs on its own; the UI shows its last run and lets the owner trigger one. A one-time
backfill covers the period before go-live. Israeli defaults: ILS, VAT 18%, Hebrew vendor names.

## Capabilities and Constraints

- Screens: Attention queue, item detail, invoices list, backfill, vendors, missed emails, settings, setup wizard, login.
- Hebrew, right-to-left UI. Paths, filenames, emails, JSON and amounts stay left-to-right inside it.
- All UI text lives in `src/i18n/he.ts`; features, data and wording are kept in a redesign.
- React 19 + Vite + Tailwind 4, served by the same Express server. No external requests from the UI
  (self-hosted; fonts and assets must ship with the app).
- Secrets are write-only in the UI: only configured / not configured is ever shown.

## Brand Commitments

Name: אוסף החשבוניות. No logo or other brand assets exist.
The owner rejects: a generic SaaS dashboard look (white cards on grey, pill badges, teal/indigo accent),
decoration or heavy motion, sparse low-density layouts, a dark techy look, and (tried and rejected) a loud
themed look with hard outlines, flat squares and heavy condensed type. Wanted: warm and friendly, soft shapes,
a bit of colour and personality, still tidy.

## Evidence on Hand

Synthetic demo data via `npm run demo` (`scripts/seed-demo.ts`): invented vendors and items in every state.

## Product Principles

- The queue comes first: what needs a decision is always the first thing seen.
- One tap per decision, reachable with a thumb.
- Dense and scannable: many rows per screen, amounts and dates aligned.
- Nothing hidden: failures, disconnected services and worker status are always visible.
