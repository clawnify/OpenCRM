---
version: alpha
name: Clawnify Apps
description: >-
  The shared design system for every app built on the Clawnify app builder
  (template-app-internal: Hono + React + Vite + tRPC + Tailwind + shadcn/ui).
  This file is the single source of truth for visuals. Every deployed app
  inherits it; an app or agency overrides individual tokens below to rebrand
  without touching component code. Lint with `npx @google/design.md lint
  DESIGN.md`; export to a Tailwind v4 @theme block with
  `npx @google/design.md export --format css-tailwind DESIGN.md > theme.css`.

colors:
  # ── Surfaces ──
  background: "#FFFFFF"        # app canvas, page background — WHITE by default (see Colors)
  surface: "#FFFFFF"          # cards, tables, panels, popovers
  surface-sunken: "#F1F5F9"   # table header fill, inset wells, hover rows
  # ── Text ──
  foreground: "#1A202C"       # primary text, headings, data values — the ink
  muted: "#475569"            # secondary text, labels, captions (AA on surface-sunken)
  faint: "#94A3B8"            # placeholders, disabled text, decorative icons only
  # ── Lines ──
  border: "#E2E8F0"           # hairlines, card outlines, zone dividers
  ring: "#1B1A19"             # focus ring: ink, never a hue (a coloured ring reads as an error)
  ring-halo: "#EDEBE7"        # the 3px neutral halo around a focused input
  link: "#2563EB"             # inline text links: the ONLY blue in the chrome
  # ── Brand action (primary = Clawnify coral, shared with the dashboard) ──
  primary: "#DD5164"          # the single coral CTA per screen — same hue as the dashboard
  primary-hover: "#C53A4E"    # darkens on hover (never lightens)
  on-primary: "#FFFFFF"
  # ── Status (muted, never pure-saturated) ──
  success: "#047857"
  success-tint: "#ECFDF5"
  warning: "#B45309"
  warning-tint: "#FFFBEB"
  danger: "#B91C1C"            # dark enough for AA even on danger-tint
  danger-hover: "#991B1B"
  danger-tint: "#FEF2F2"

  # ── Dark mode (applied via prefers-color-scheme / .dark) ──
  background-dark: "#0D1117"
  surface-dark: "#161B22"
  surface-sunken-dark: "#1C2128"
  foreground-dark: "#E6EDF3"
  muted-dark: "#9BA7B3"
  faint-dark: "#6E7681"
  border-dark: "#30363D"
  ring-dark: "#EFEEED"
  ring-halo-dark: "#2E2E2C"
  link-dark: "#4493F8"
  primary-dark: "#DD5164"      # coral holds on the dark canvas (no inversion)
  primary-hover-dark: "#C53A4E"
  on-primary-dark: "#FFFFFF"
  success-dark: "#3FB950"
  success-tint-dark: "#12261E"
  warning-dark: "#D29922"
  warning-tint-dark: "#2A2210"
  danger-dark: "#F85149"
  danger-hover-dark: "#FF6A60"
  danger-tint-dark: "#2D1518"

# All sizes in rem (relative to the 16px root) so type respects browser zoom /
# user font-size and maps 1:1 to Tailwind's rem utilities. px is reserved for
# 1px hairline borders and shadow geometry only (see Components / Elevation).
typography:
  display:
    fontFamily: Inter
    fontSize: 1.75rem     # 28px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.02em
  heading-1:
    fontFamily: Inter
    fontSize: 1.25rem     # 20px — page / toolbar title; B2B tools keep headings small
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.01em
  heading-2:
    fontFamily: Inter
    fontSize: 1rem        # 16px
    fontWeight: 600
    lineHeight: 1.3
  heading-3:
    fontFamily: Inter
    fontSize: 0.875rem    # 14px / text-sm
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: Inter
    fontSize: 0.875rem    # 14px / text-sm
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem   # 13px — dense tables, list rows, card body copy
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: Inter
    fontSize: 0.8125rem   # 13px — numbers in tables; tabular figures, right-aligned
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: '"tnum" 1, "cv01" 1'
  data-lg:
    fontFamily: Inter
    fontSize: 1.5rem      # 24px — KPI / stat values, tabular, bold
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: '"tnum" 1, "cv01" 1'
  eyebrow:
    fontFamily: Inter
    fontSize: 0.6875rem   # 11px — THE signature: zone titles inside cards/panels
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.08em # always uppercase, always muted
  label:
    fontFamily: Inter
    fontSize: 0.75rem     # 12px / text-xs — column headers, field labels, metadata
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.04em
  button:
    fontFamily: Inter
    fontSize: 0.875rem    # 14px / text-sm — button label size
    fontWeight: 500
    lineHeight: 1
  fine:
    fontFamily: Inter
    fontSize: 0.6875rem   # 11px — fine print, deltas, strikethrough comparisons
    fontWeight: 400
    lineHeight: 1.4

rounded:
  # Values map 1:1 to Tailwind v4's --radius-* scale and are token-bound — a
  # component names the class (`rounded-sm`), never a literal px, so an app
  # rebrands by overriding --radius-* in its @theme. Do NOT ship shadcn's stock
  # single `--radius: 0.625rem`: it derives md/lg only ~2px apart and rounds
  # atoms to 8–12px, so buttons read chunky. Set the four vars explicitly.
  sm: 0.25rem  # 4px  — atoms: buttons, inputs, chips → class `rounded-sm` / --radius-sm
  md: 0.375rem # 6px  — rarely used; the step between an atom and a container
  lg: 0.5rem   # 8px  — containers: cards, panels, popovers → `rounded-lg` / --radius-lg
  xl: 0.75rem  # 12px — modals, large dialogs → `rounded-xl` / --radius-xl
  full: 9999px # avatars, status badges, toggles, data pills (a pill cap, not a scalable measure)

spacing:
  base: 0.5rem           # 8px
  xs: 0.25rem            # 4px
  sm: 0.5rem             # 8px
  md: 0.75rem            # 12px
  lg: 1rem               # 16px
  xl: 1.5rem             # 24px
  "2xl": 2rem            # 32px
  gutter: 1rem           # 16px
  icon-gap: 0.375rem     # gap-x-1.5 — gap between a button's icon and its label
  zone-padding: 1.25rem  # 20px — horizontal+vertical padding inside a card zone
  container-max: 75rem   # 1200px
  sidebar-width: 16.25rem # 260px
  button-height: 2rem    # 32px / h-8 — the compact desktop button height
  tap-target: 2.25rem    # 36px — input height / touch min (buttons run denser; see button-height)
  tap-target-agent: 2.5rem # 40px — interactive height in agent/touch mode (buttons grow to this)

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    iconGap: "{spacing.icon-gap}"
    padding: 0 0.5rem        # py-0 px-2 (0.5rem = --spacing × 2); height is fixed, so no vertical padding
    height: "{spacing.button-height}"  # 32px / h-8 — compact, Linear-tier; grows to tap-target-agent in agent/touch mode
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.border}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    iconGap: "{spacing.icon-gap}"
    padding: 0 0.5rem        # py-0 px-2 (0.5rem = --spacing × 2); height is fixed, so no vertical padding
    height: "{spacing.button-height}"  # 32px / h-8 — compact, Linear-tier; grows to tap-target-agent in agent/touch mode
  button-secondary-hover:
    backgroundColor: "{colors.surface-sunken}"
  button-ghost:                # transparent at rest (no fill until hover)
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    iconGap: "{spacing.icon-gap}"
  button-ghost-hover:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.foreground}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    border: "1px solid {colors.border}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    iconGap: "{spacing.icon-gap}"
  button-danger-hover:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger-hover}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.border}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 0.5rem 0.625rem
    height: "{spacing.tap-target}"
  input-focus:
    border: "1px solid {colors.ring}"
  input-placeholder:
    textColor: "{colors.faint}"
    typography: "{typography.body-sm}"
  link:
    textColor: "{colors.link}"
  card:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"        # container → 8px (Tailwind `rounded-lg`)
  card-zone:
    padding: "{spacing.zone-padding}"
    borderTop: "1px solid {colors.border}"   # every zone after the first
  eyebrow:
    textColor: "{colors.muted}"
    typography: "{typography.eyebrow}"        # render text-transform: uppercase
  table-header:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: 0.625rem 0.75rem
  table-row-hover:
    backgroundColor: "{colors.surface-sunken}"
  chip:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.muted}"
    border: "1px solid {colors.border}"
    typography: "{typography.fine}"
    rounded: "{rounded.sm}"
    padding: 0.25rem 0.5rem
  badge-success:                 # tinted fill + a thin same-hue border (the "Beta / Upgrade" pill)
    backgroundColor: "{colors.success-tint}"
    textColor: "{colors.success}"
    border: "1px solid color-mix(in srgb, {colors.success} 28%, transparent)"
    typography: "{typography.label}"     # 0.75rem / text-xs for the size…
    fontWeight: 400                       # …but normal weight — pills are quiet, not bold
    rounded: "{rounded.full}"
    padding: 0.125rem 0.5rem
  badge-warning:
    backgroundColor: "{colors.warning-tint}"
    textColor: "{colors.warning}"
    border: "1px solid color-mix(in srgb, {colors.warning} 28%, transparent)"
    typography: "{typography.label}"     # 0.75rem / text-xs for the size…
    fontWeight: 400                       # …but normal weight — pills are quiet, not bold
    rounded: "{rounded.full}"
    padding: 0.125rem 0.5rem
  badge-danger:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
    border: "1px solid color-mix(in srgb, {colors.danger} 28%, transparent)"
    typography: "{typography.label}"     # 0.75rem / text-xs for the size…
    fontWeight: 400                       # …but normal weight — pills are quiet, not bold
    rounded: "{rounded.full}"
    padding: 0.125rem 0.5rem
  stat:
    textColor: "{colors.foreground}"
    typography: "{typography.data-lg}"
  stat-meta:
    textColor: "{colors.muted}"
    typography: "{typography.fine}"
  sidebar-item:                  # nav rows read as primary: foreground text + foreground icons
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 0.4375rem 0.625rem
  sidebar-item-active:           # the active row is a soft brand (coral primary) tint pill + primary text/icon
    backgroundColor: "color-mix(in srgb, {colors.primary} 12%, transparent)"
    textColor: "{colors.primary}"
    fontWeight: 600
  segmented:                     # tab / view switcher track (holds the segments)
    backgroundColor: "{colors.surface-sunken}"
    rounded: "{rounded.lg}"        # container → 8px (Tailwind `rounded-lg`)
    padding: 0.125rem
  segmented-item:                # inactive segment — transparent, muted text
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
  segmented-item-active:         # active segment — RAISED WHITE pill, never an ink fill
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.sm}"
---

# Clawnify Apps — Design System

## Overview

Clawnify apps are **internal tools and management platforms for mid-market companies**: catalogs, quote-to-invoice queues, CRMs, project trackers, client portals, admin panels. The buyer is an operations person or the agency serving them, not a consumer. So the look is **dense, quiet, and engineered** — the tier of Linear, Attio, and Ramp, not the tier of a vibe-coded demo.

The job of this file is twofold. First, a **floor**: enough opinion to eliminate the generic "AI-generated interface" aesthetic (purple gradients, glowing buttons, emoji section headers, oversized hero type). Second, a **signature**: a small set of recognizable moves — codified from the Clawnify pricing cards (`apps/web/src/app/pricing/page.tsx`), the most detailed surface we've shipped — so that every app, whatever its domain, is identifiably *a Clawnify app* the way every Linear screen is identifiably Linear.

The format follows the [Google Labs DESIGN.md spec](https://github.com/google-labs-code/design.md), same as the websites' `docs/internal/DESIGN.md`. Tokens in frontmatter give agents and tooling exact values; the prose explains *why*.

## The Clawnify Signature

Five moves, applied everywhere. An app missing these looks generic; an app with all five looks like ours.

### 1. Labeled zones, not blobs

A Clawnify container is **anatomy, not a padded box**. Cards, panels, and detail views are divided into stacked zones by hairline `border` dividers (`card-zone`), and **every zone opens with an `eyebrow`** — an 11px uppercase tracked label in `muted` naming what the zone contains:

```
┌──────────────────────────────────┐
│ INVOICE                          │  ← eyebrow
│ Q3-0042 · Meridian GmbH          │
│ $4,820.00  [⬛ Mark paid]        │
├──────────────────────────────────┤  ← hairline divider
│ LINE ITEMS                       │  ← eyebrow
│ …                                │
├──────────────────────────────────┤
│ ACTIVITY                         │
│ …                                │
└──────────────────────────────────┘
```

This is the single highest-leverage move. Generic AI UIs ship one `<h3>` and a wall of content; a sectioned, self-labeled card reads as deliberately engineered. Forms group fields under eyebrows. Sidebars title their nav groups with eyebrows. Detail panes split summary / fields / history into zones.

### 2. One coral action

**The primary button is Clawnify coral (`primary` = `#DD5164`) — and there is exactly one per screen.** It darkens on hover (`primary-hover`), never lightens. This is the same coral the dashboard uses for its primary CTA, so a generated app and the dashboard read as one product — that single shared hue is what makes the whole platform feel like one SaaS. Coral is the **default**; an app or agency can override `primary`/`primary-hover` to its own brand color (see *Overriding This File*) and every button reflows.

Everything else in the chrome stays **monochrome**. The coral is rationed to that one solid CTA — the only other coral on screen is the soft 12% tint marking the **active sidebar item** (a location indicator, not an action). Color elsewhere is reserved for:

- **Blue (`link`)** — inline text links. Never buttons, never fills. Focus rings are ink (`ring`), never a hue.
- **Status tones** — `success`/`warning`/`danger`, tinted badges and validation only.

So the rule isn't "no color in the chrome" — it's **one colored action, monochrome everything else, and color otherwise belongs to the data** (status badges, category pills, charts). Secondary and ghost actions stay neutral; a screen with two coral buttons has none. That discipline — a single brand CTA against an otherwise gray-white, ink-text interface — is what keeps a coral-buttoned app reading as a serious tool rather than a vibe-coded gradient demo.

### 3. Engineered numbers

Numbers are treated as instrumentation, not text:

- Every numeric column, KPI, and price uses `data`/`data-lg` with **tabular figures** (`"tnum"`), right-aligned in tables so digits and totals stack.
- Key numbers carry a **fine-print meta line** beneath (`stat-meta`): a delta, a comparison, a strikethrough former value ("~~$580/mo~~ · billed yearly"). Give the meta line a **fixed height** so toggling state never shifts layout — the pricing page's `h-4` trick.
- Numeric tables show a **footer aggregate** (sum / avg / count).

### 4. Chip vocabulary

Enumerable values — plan names, model tiers, file types, tags shown as facts rather than statuses — render as **chips**: `fine` type, `surface-sunken` fill, hairline border, `sm` radius. Status that demands attention gets a **badge** instead: `full` radius (a pill), **`text-xs` (0.75rem) at normal (400) weight** — pills are quiet, not bold — a tinted background (`success-tint`/`warning-tint`/`danger-tint`) **with a thin same-hue border**, colored text, and an optional 11–12px leading icon — the "Beta / Upgrade" pill look. Chips are facts; badges are signals. Don't conflate them.

### 5. Micro-iconography

Icons are 12–16px `lucide-react` line icons, always paired with text, never decorative. Small confirmation checks use `strokeWidth={2.5}` so they stay legible at 12px. No emoji, no filled icon sets, no icon-only primary actions.

## Colors

Neutral-dominant; the full palette ships in light and dark (`*-dark` applies under `prefers-color-scheme: dark` / `.dark`). The dark palette is GitHub-dim (`#0D1117` canvas) rather than pure black — easier on the eyes for all-day tools.

- **`background` (#FFFFFF):** the canvas. **White by default — always.** The page background is white unless the brief explicitly asks for a different one (a tinted canvas, a dark app, a branded shell); only then override this token. With a white canvas, `surface` cards no longer read raised by a tonal step, so they separate by their **`border`** (the interface is border-driven and nearly flat anyway — see Elevation). Don't reach for shadows to compensate.
- **`surface` (#FFFFFF):** cards, tables, panels, popovers. Content lives here — same white as the canvas, set apart by a `border`.
- **`surface-sunken` (#F1F5F9):** table-header fills, hovered rows, chips, inset wells, the active sidebar item. The "one step back" tone.
- **`foreground` (#1A202C):** all primary text and data values — the ink. Never pure `#000`.
- **`muted` (#475569):** secondary text. Deliberately darker than the usual slate-500 so it passes WCAG AA (4.5:1) even on `surface-sunken` — table headers and eyebrows must stay readable.
- **`faint` (#94A3B8):** placeholders, disabled states, decorative icons. Never for text that must be read.
- **`border` (#E2E8F0):** the workhorse — card outlines, zone dividers, table separators, input borders.
- **`primary` (#DD5164) / `primary-hover` (#C53A4E):** Clawnify coral — the single brand CTA per screen, shared with the dashboard. Darkens on hover. The default; overridable per app.
- **`link` (#2563EB):** the only chromatic blue, confined to inline links. Never a button.
- **`ring` (ink):** focus indication. Never the app's hue: next to a red or coral accent, a coloured focus ring reads as an error.
- **Status triplets:** each of `success`/`warning`/`danger` has a text tone and a `*-tint` background, both with dark variants. Tints exist **so components never hardcode a hex** — `button-danger-hover` and the badges reference them.

## Typography

One family — **Inter** (fallback: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`). Hierarchy comes from **size and weight contrast**, not color or family changes. The roles that separate a real tool from a generic one:

- **`eyebrow`** — 11px / 600 / 0.08em tracking, uppercase, `muted`. The zone-naming device (signature #1).
- **`label`** — 12px / 600 / 0.04em. Column headers and field labels, set in `muted`.
- **`data` / `data-lg`** — tabular figures for every number (signature #3).
- **`fine`** — 11px fine print: meta lines, deltas, chip text, footnotes.
- **`heading-1` is only 20px.** Internal tools keep titles small; the content is the star. A 48px hero is a marketing-site move and instantly reads as "not a real tool." `display` (28px) exists for the rare empty-product splash and nothing else.

## Layout

A 1200px max-width container for table/list apps; a full-bleed flex layout with a fixed **260px sidebar** for navigation-heavy apps (CRM, multi-section dashboards). Spacing follows a strict **8px scale** with a 4px half-step — consistent rhythm is most of what makes an interface feel designed.

Standard chrome:

- **Toolbar** — sticky top bar, page title (`heading-1`) left, actions right, `border` underneath.
- **Sidebar** — `surface`, `border` on the right edge, nav groups separated by hairline dividers with a muted Title-case group label per section. Rows (`sidebar-item`) are **foreground** text with foreground icons — they read as primary, not muted. The **active row is a soft brand-coral (`primary`) tint pill** with primary-coral text and icon (`sidebar-item-active`) — the active nav state is the one place the brand color marks *location* rather than the single CTA action. Locked/disabled rows go `faint`.
- **Cards** use `zone-padding` (20px) per zone so grouped content breathes; **table rows** stay tight (8–10px vertical). Cards relax; tables compress.

## Elevation & Depth

The interface is **nearly flat**. Hierarchy comes from `border` first — with a white canvas, the `border` *is* what sets a `surface` card apart — plus the `surface` → `surface-sunken` tonal step for headers, hovered rows, and inset wells. Not shadows. Shadows are reserved for elements that genuinely float:

- **Resting cards/tables:** no shadow — a `border` only.
- **Popovers, dropdowns, menus:** `0 4px 12px rgba(0,0,0,0.12)`.
- **Modals, toasts:** `0 8px 24px rgba(0,0,0,0.16)`.

No glows, no colored shadows, no layered drop-shadows on static content. If everything is elevated, nothing is.

**Keylines over imagery.** The 1px `border` token is for chrome on flat surfaces. When an element sits *on top of a photo or a map* — a marker, an avatar over an image, a chip on a thumbnail — its separating border is instead **white and thin** (≈1.5–2px), a crisp keyline that reads against any busy background, paired with a soft drop shadow. The one exception is a border that **encodes data**: a category-coloured marker ring is the data (color = data), so it keeps its hue — but still goes thin (2px, not a heavy 3–4px). So: decorative separation over imagery → white keyline; a border that *means* something → its data color, kept thin.

## Shapes & Motion

Soft-but-engineered: **4px** on interactive atoms (buttons, inputs, chips → `rounded-sm`), **8px** on containers (cards, panels, popovers → `rounded-lg`), **12px** on modals (`rounded-xl`); avatars, badges, and toggles are `full`. Don't mix a sharp corner and a pill in the same view.

**Wiring it in Tailwind v4 / shadcn.** Set the four scale steps explicitly in your `@theme` so the utility classes resolve to these exact values:

```css
@theme {
  --radius-sm: 0.25rem;  /* atoms:      rounded-sm */
  --radius-md: 0.375rem; /* the in-between step */
  --radius-lg: 0.5rem;   /* containers: rounded-lg */
  --radius-xl: 0.75rem;  /* modals:     rounded-xl */
}
```

Do **not** keep shadcn's stock single `--radius: 0.625rem` (which derives `--radius-sm/md/lg` only ~2px apart): it rounds buttons to 8–12px and they read chunky and demo-ish. Also re-check the components you pull from the registry — some ship `rounded-md`/`rounded-lg` on buttons/inputs; repoint those to `rounded-sm` so atoms land at 4px. Because the classes are token-bound, an app rebrands its corner radius by overriding these four vars — never by editing a component.

Transitions are quick and functional: **0.15s ease** on background/border/color. No bounce, no spring, no decorative motion. Hover states are **barely visible** — a one-step tonal shift to `surface-sunken`, never a scale or color jump.

## Components

Built on **shadcn/ui** primitives, restyled to these tokens. The shadcn defaults are a fine skeleton but ship too rounded and too gray-flat; the tokens above pull them to this tier.

### Compose shadcn natively — don't reinvent

**Always reach for the shadcn component (or the documented composition of shadcn components) before hand-rolling one.** shadcn ships, or composes, almost everything an internal tool needs — and each piece already carries the accessibility, keyboard, focus, and portal behavior you'd otherwise reimplement (and get subtly wrong). The job here is to *restyle via tokens*, not to rebuild.

- **Use the documented composition for things that have no single root.** A date picker isn't a `<DatePicker>` — it's a `Popover` wrapping a `Calendar`; a combobox is `Popover` + `Command`; a confirm is an `AlertDialog`. Build those shapes, don't invent a bespoke equivalent. (E.g. the date field: `Popover` → `PopoverTrigger asChild` on a `Button` → `PopoverContent` → `Calendar mode="single">`.)
- **Never `window.confirm` / `alert` / `prompt`.** They're forbidden (§ Agent & human dual-mode) and break agent mode. Destructive confirms are an `AlertDialog`; everything else is `Dialog`.
- **Restyle through tokens, not by forking the primitive.** Changing a corner radius or color is a token override (`--radius-*`, `--primary`), not a one-off edit inside the component — that's what keeps one-file rebranding working.
- **If you override a primitive's padding, audit its sub-parts.** A primitive's parts often assume the default padding. The classic trap: setting `p-0` on `DialogContent` while `DialogFooter` still carries `-mx-4 -mb-4` (negative margins meant to cancel the default `p-4`) — with `p-0` those negatives push the footer *outside* the rounded dialog. If you go `p-0`, add `overflow-hidden` to the content and neutralize the footer's bleed (`mx-0 mb-0`), or keep the default padding and inset per-section instead.

- **Buttons** — `button-primary` (coral, the one CTA per screen), `button-secondary` (white, bordered — the default for most actions), `button-ghost` (toolbar/row actions), `button-danger` (red text, `danger-tint` hover). An `inline-flex` row, `items-center justify-center`. Label is `text-sm` (0.875rem / `font-medium` 500); radius is `rounded` (0.25rem); an icon (`shrink-0`, `size-4`) sits `gap-x-1.5` (0.375rem) from the label. Height is `button-height` (2rem / 32px / `h-8`) with `py-0` and `px-2` (0.5rem) — compact and dense, the Linear/Attio tier, not a chunky 40px web button. In **agent/touch mode** it grows to `tap-target-agent` (2.5rem / 40px). Icon + label, never icon-only for a primary action.
- **Inputs** — bordered `surface` fill; focus swaps the border to `ring` (ink) plus a 3px neutral `ring-halo`. No heavy glow.
- **Cards** — `card` shell + stacked `card-zone`s, each opened by an `eyebrow` (signature #1). A one-zone card is fine; it still gets its eyebrow.
- **Tables** — `surface-sunken` header in `label` type, `border` between rows, hover in `surface-sunken`, numeric columns in `data` right-aligned, footer aggregate.
- **Segmented controls / tabs** — a `surface-sunken` track holding the segments; the active segment is a **raised white (`surface`) pill** with a hairline `border` and a faint shadow (`0 1px 2px rgba(0,0,0,0.06)`), inactive segments transparent with `muted` text. **Never fill the active tab with `foreground`/ink** — a solid dark fill reads as an accent or a CTA, and fills are reserved for the one coral primary. The selected state is *raised*, not *coloured* (the macOS / Linear segmented pattern). Use it for view switchers and small option groups (e.g. date ranges); for primary page navigation prefer the sidebar.
- **Chips vs badges** — see signature #4.
- **Stats / KPIs** — `stat` value + fixed-height `stat-meta` line (signature #3).
- **Empty states** — never a bare "No data." One line of explanation plus the primary action: "No invoices yet. Generate your first from a quote." **Render the empty state borderless** — quiet centered text + the one action floating in generous whitespace, *not* wrapped in a bordered/`card` box. An empty bordered box reads as a broken or unloaded component; the border only earns its place once there are rows to contain. Apply the border (and zone anatomy) to the *populated* list/table, and swap to plain centered space when the count is zero.
- **Dialogs** — every dialog is the shadcn `Dialog` (Radix under the hood, portaled to `<body>`) and **always closes with a `DialogFooter`**: actions right-aligned, the single coral `button-primary` last, a **`DialogClose asChild`** secondary `Cancel` before it (so Esc, the X, and Cancel all resolve the same way). Wrap the body in a `<form>` with the primary as `type="submit"`, so Enter submits and the browser handles required-field focus. Group fields with `Field` / `FieldGroup` (label + control + help/error per field) rather than ad-hoc `<div>` stacks. Header is a `DialogTitle` (+ `DialogDescription` when the title alone isn't self-evident). Over a map or any high-`z-index` surface, the overlay/content sit above it (the chrome's stacking tops out at the map's controls). Canonical shape:

  ```tsx
  <Dialog>
    <form onSubmit={save}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>Make changes to your profile here.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue="Pedro Duarte" />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button type="submit">Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </form>
  </Dialog>
  ```

### Category color palette (for data pills, tags, owners)

Categorical *data* values (tags, owners, company names) get a stable color by hashing the value to one of ten muted pairs — the same value always maps to the same color across the app. This is the one place chroma is welcome, because it's data, not chrome. Background / text (light mode):

`#FEF2F2`/`#DC2626` · `#ECFDF5`/`#059669` · `#EFF6FF`/`#2563EB` · `#FFFBEB`/`#D97706` · `#F5F3FF`/`#7C3AED` · `#F0FDFA`/`#0D9488` · `#FDF2F8`/`#DB2777` · `#FFF7ED`/`#EA580C` · `#FAF5FF`/`#9333EA` · `#F0FDF4`/`#16A34A`

In dark mode, render the same text color over a 12%-opacity background of itself (`color-mix(in srgb, <text> 12%, transparent)`) — don't ship light pastel fills onto dark surfaces.

```ts
function pillColor(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return PILL_COLORS[Math.abs(hash) % PILL_COLORS.length];
}
```

## The Floor: Even a Todo App

The signature is **not reserved for big apps**. The simplest possible request — "make me a todo app" — must still come out looking engineered. The minimum any Clawnify app ships with, however trivial the brief:

```
┌─ Toolbar ──────────────────────────────────────┐
│ Todos                              [▣ Add task]│  ← heading-1 + coral CTA, border below
└────────────────────────────────────────────────┘
┌─ Card ─────────────────────────────────────────┐
│ TASKS · 4 OPEN                                 │  ← eyebrow with live count
│ ☐ Send Q3 invoices            ⬡ today          │  ← 36px rows, chip for metadata
│ ☐ Review supplier quote       ⬡ tomorrow       │
│ ☑ Book freight pickup                          │  ← done: muted + strikethrough
├────────────────────────────────────────────────┤
│ COMPLETED THIS WEEK                 3          │  ← second zone, tabular count
└────────────────────────────────────────────────┘
```

Concretely, the non-negotiables for a minimal app:

1. **A toolbar** with the app name in `heading-1` and the single primary action as a coral `button-primary`. Never a floating centered `<h1>`.
2. **Content in a `card` with eyebrow-labeled zones** — even one list gets its eyebrow (`TASKS · 4 OPEN`). The count in the eyebrow is the cheapest way to make a list feel instrumented.
3. **A real empty state** — "No tasks yet. Add your first above." — not a blank card.
4. **Metadata as chips**, dates/counts in `data` type, completed items in `muted` with strikethrough.
5. **The canvas/surface separation** — white `background` page, `surface` card set apart by its `border`. Never content floating directly on the canvas.
6. **Both modes** — dark palette via `prefers-color-scheme`, agent mode via `data-agent`. These come free from the tokens and template; don't strip them "because it's simple."

If the brief is trivial, spend the saved effort on these six, not on inventing layout. A todo app with a labeled, counted, chip-annotated zone card reads as a tool; the same data in a centered max-w-md gradient card reads as a demo.

### Agent & human dual-mode

Every Clawnify app runs for two callers: a human in the dashboard and an agent driving a browser. Detect agent mode (`?agent` / `mode=agent`) and set `data-agent` on `<html>`. In agent mode: bump interactive targets to `tap-target-agent` (40–44px), make every action a visible `<button>` with a descriptive `aria-label`, and hide hover-only affordances (drag handles, ellipsis menus, click-to-edit). Never gate an action behind hover or right-click in agent mode. Use semantic HTML (`<table>`/`<th>`/`<td>`, real `<button>`s, correct `<input type>`); never `alert()`/`confirm()`/`prompt()` or `localStorage`.

## Overriding This File

This is the platform default that ships inside `template-app-internal`. An individual app — or an agency white-labeling client work — overrides tokens here (swap the coral `primary` for the app's own brand color, the font, the radii) and every component reflows through the Tailwind utilities already in the markup. **No component file ever contains a raw hex code, font name, or fixed pixel value** — including tint backgrounds and active states; if a recipe needs a tone, it gets a token first. That rule is what makes one-file rebranding actually work.

## Do's and Don'ts

- **Do** open every card zone, form group, and sidebar section with an `eyebrow`. **Don't** ship a padded blob with one heading.
- **Do** keep the primary button coral (`primary`, the brand default) — exactly one per screen, hover darkens. **Don't** paint buttons blue (blue is links and focus only) or ship two coral buttons in one view.
- **Do** show the active tab/segment as a raised white pill on a `surface-sunken` track. **Don't** fill the active tab with ink/`foreground` — a solid dark fill reads as an accent or CTA.
- **Do** set numeric columns in tabular figures, right-aligned, with footer aggregates. **Don't** let digits jitter between rows.
- **Do** give key numbers a fixed-height meta line (delta, comparison). **Don't** let state toggles shift layout.
- **Do** use chips for facts and tinted badges for signals. **Don't** use a red badge as decoration.
- **Do** keep the page `background` **white** by default — override to a tinted/dark canvas only when the brief explicitly asks. **Don't** ship an off-white or gray canvas unprompted.
- **Do** convey hierarchy with borders and tonal steps. **Don't** add shadows to resting cards or use colored/glowing shadows.
- **Do** keep headings small (20px page title). **Don't** ship a 48px marketing hero inside an internal tool.
- **Don't** use gradients anywhere — especially the purple/indigo gradient that flags AI-generated UI.
- **Don't** use emoji as section headers or icons; use `lucide-react` line icons at 12–16px.
- **Do** write real empty states with a next action. **Don't** leave a bare "No data."
- **Do** keep hover states one tonal step. **Don't** scale, glow, or color-shift on hover.
- **Do** maintain WCAG AA (4.5:1 body text) — `muted` is tuned to pass even on `surface-sunken`. **Don't** use `faint` for anything that must be read.
- **Do** stay responsive: stack columns on mobile, keep tap targets ≥ `tap-target`, let tables scroll horizontally. **Don't** ship a desktop-only grid.
- **Do** change branding by editing tokens in this file. **Don't** hardcode a hex, font, or pixel value in a component — tints and active states included.

> **Known lint warnings:** `npx @google/design.md lint` flags `border`/`borderTop` component sub-tokens (the spec doesn't model borders yet — we keep them because borders carry the hierarchy here) and every `*-dark` color as unreferenced (the spec doesn't model dark mode). Both are spec gaps, shared with the websites' `docs/internal/DESIGN.md`. Any *other* warning — contrast, orphan light-mode tokens, raw hex — is a real defect; fix it.

## See Also

- **`apps/web/src/app/pricing/page.tsx`** — the canonical exemplar of the structural signature (zoned cards, eyebrows, engineered numbers, chips). Its CTA predates the coral-primary default; follow the tokens for button color, this file for everything else.
- **`docs/internal/DESIGN.md`** — the websites' platform-default brand (same spec, marketing tier).
- **`docs/internal/template-strategy.md`** — why there is exactly one app template.
- **[Google Labs DESIGN.md spec](https://github.com/google-labs-code/design.md)** — upstream format.
