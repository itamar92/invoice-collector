# Design

Warm and friendly, tidy and dense. A soft rosy ground, white rounded panels, basil green for actions.
Phone first: the owner clears the queue with a thumb in a couple of minutes.

Tokens live in `src/index.css` (`@theme`); shared components in `src/components/ui.tsx`; the shell in `src/Layout.tsx`.
Tailwind's default palette is switched off, so only the colours below exist.

## Colour

| Token | Value | Use |
| --- | --- | --- |
| `ground` / `ground-deep` | `#f8f1ee` / `#f0e5e0` | Page background / secondary button fill, rail hover |
| `white` | `#ffffff` | Panels, inputs, tab bar |
| `ink` / `muted` | `#2a2130` / `#6c5f70` | Text / secondary text, labels, hints |
| `line` / `line-strong` | `#eee4df` / `#d8c9c3` | Row rules / input borders |
| `accent` / `-deep` / `-tint` | `#1f7a55` / `#17604a` / `#dcf0e6` | Primary actions, active nav, links, focus |
| `alert` / `-deep` / `-tint` | `#cf3f33` / `#a32b21` / `#fde6e1` | Needs you: failures, attention count, discarding actions |
| `warn` / `-deep` / `-tint` | `#e6a41a` / `#7a5200` / `#fdf0cf` | Waiting on a decision, cautions |
| `info` / `-deep` / `-tint` | `#6a7be0` / `#3644a6` / `#e6eafc` | In process, neutral notes |
| `ok` / `-tint` | `#2e9a6b` / `#dcf0e6` | Filed, done, success |
| `idle` / `-tint` | `#a79ca8` / `#efebef` | Ignored, dismissed |
| `lilac-deep` / `-tint` | `#6f3a8c` / `#f1e4f8` | Avatar tiles only |

Each state colour keeps one meaning on every screen. Coral is never decoration.

## Type

- Headings: Fredoka Variable, weight 600 (class `display`). Page title 26px, 30px from `md`; section title 18px.
- Everything else: Noto Sans Hebrew Variable. Body 15px, secondary 13px, hints 12px. Emphasis is weight 600.
- Both fonts are bundled (`@fontsource-variable/*`); the UI makes no outside font requests.
- Figures are tabular. Dates and amounts use `.num`; paths, emails and JSON use `.ltr`.

## Shape and depth

- Panels: 20px radius, `shadow-soft`, 16px padding (20px from `md`). Class `panel`, or the `Card` component.
- Controls: 12px radius (`rounded-xl`), 40px minimum height. Small tags 6-8px.
- Two shadows only: `shadow-soft` for panels and raised buttons, `shadow-bar` for the bottom tab bar.
- Never nest a panel inside a panel. Group inside a panel with a `ground` or tinted block instead.

## Components

- **Button**: `primary` green; `secondary` `ground-deep` fill; `danger` coral tint, kept apart from its neighbours
  with extra space; `ghost` green text. Presses scale to 0.98.
- **Avatar**: a vendor's initial on a soft tile. The tint is derived from the name, so a vendor keeps its colour.
- **StateBadge**: a dot and a label, no pill. A filled dot is settled, a ring is still on its way.
- **CountBadge**: coral bubble for things that need the owner, neutral otherwise.
- **ErrorText**: coral tint with the alert icon. **Notice**: tinted block in `info`, `ok` or `warn`.
- **Rows** (`rowCls`): thin `line` rule between rows, none after the last. Linked rows highlight with `ground`.
- **Icons**: `Icon` in `ui.tsx`, one 20px grid, 1.75 stroke, round joins. No emoji or Unicode glyphs as icons.

## Layout

- Phone: top bar (brand, run-now), fixed bottom tab bar with four tabs plus a menu tab that opens a sheet for
  backfill, settings and logout. Content column with 16px gutters and room for the tab bar.
- Desktop (`md`+): 240px rail on the start side with all six destinations, worker status at the bottom; content
  capped at 56rem.
- Lists are rows, not tables: two lines on phone, aligned columns on desktop. The only true table is settings
  categories.
- Item screen: fields before the document on phone; side by side on `lg`, the document pinned.
- Right-to-left throughout; use logical properties (`ms-`, `pe-`, `start-`, `text-end`).

## Do not

- White cards on grey with pill badges, or a teal or indigo accent.
- Hard black outlines, square corners, heavy condensed headings, loud full-colour shells.
- Themed gimmicks (numbered markers, connecting lines, textures) or decorative motion.
- Dark mode, neon, monospace for anything but code, keys and JSON.
- Sparse layouts: keep many rows per screen.
