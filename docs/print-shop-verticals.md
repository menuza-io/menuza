# Print shop verticals

The Print shop is a generic core plus one optional vertical (a business type).
The core designs, proofs, renders, prices, ships and refunds prints; the
vertical says what the business prints and where its places, items and extra QR
codes come from. This mirrors the phone agent
([phone-agent-verticals.md](./phone-agent-verticals.md)).

The core has no business-type vocabulary:
`apps/app/app/utils/print/vocabulary.test.ts` fails if a core source names one
(restaurant, menu, dish, table, location, reservation, guest, and so on) or the
platform's brand. Vertical code lives in its own folders and files.

## Concepts

**Products.** The core ships posters, flyers and window stickers
(`createPrintCatalog` in `@repo/common/print-shop`). A vertical adds its own
(`PrintCatalogExtension.products`), sets the order of the "new print" list
(`productOrder`) and may name the QR targets a product accepts (`qrTargets`; by
default every single-piece target, then "no QR code"). Product keys are stored
on designs, orders and vendor mappings: keep them stable once used.

**QR targets.** The core has `site` (a path on the organization's own site) and
`none`. A vertical adds kinds with a strict schema, default words per locale
(`copy`), and optionally `perPiece` (one printed piece per item, such as a card
per desk) and `pieceWord` (the word printed before a piece's label). The server
half (`PrintQrTargetServer`) says whether the target is offered to a user
(`available`), who may see its codes (`canView`), the starting target of a new
design (`defaultFor`), editor data, how the form is read back (`fromForm`), and
how a target resolves into pieces with code URLs and versioned facts
(`resolve`).

**Pieces and facts.** A snapshot holds one piece per printed item (`label`,
`qrUrl`) and the facts behind them (`id`, `label`, `version`). The core compares
facts on re-order and before payment: a piece removed, renamed or with a renewed
code (a higher `version`) makes the print stale until it is approved again.

**Scopes.** A business's places (a branch, office or venue), with opaque ids
(`PrintScope`): the footer address, the prices of featured items, and the
ship-to prefill of orders (`PrintOrder.scopeId`). Without a vertical there are
none, and the editor hides the address.

**Featured items.** Things the business sells (`PrintItemChoice`: name, price in
cents, photo key) that pages can show, priced for a scope. Without an item
source the editor hides the section.

## Registering a vertical

Four small files pick the vertical. Upstream ships the core in each; a fork
swaps in its own:

| File                                                 | Upstream               | What a vertical sets                               |
| ---------------------------------------------------- | ---------------------- | -------------------------------------------------- |
| `packages/common/src/print-shop-catalog.ts`          | `createPrintCatalog()` | `createPrintCatalog(extension)`: products, targets |
| `apps/app/app/utils/print/vertical.server.ts`        | `generalPrintVertical` | scopes, featured items, server side of its targets |
| `apps/app/app/components/print/vertical-ui.tsx`      | `{}`                   | labels, editor fields of its targets, page wording |
| `apps/admin/app/components/print/vertical-labels.ts` | `{}`                   | names of its products in Admin                     |

The UI contract (`PrintShopUiVertical` in
`components/print/vertical-ui-types.ts`) carries product names and descriptions
(they may override a core product's), target labels with an `empty` message
(nothing to print yet) and a `hidden` message (the user may not see the codes),
a `Fields` component per target whose inputs the server's `fromForm` reads back,
the featured-items wording, the scope's name, and optional page wording
(`copy`).

## Adding a vertical

1. Add `packages/common/src/print-shop-<name>.ts` with a
   `PrintCatalogExtension`, export it from `packages/common/package.json`, and
   pass it in `print-shop-catalog.ts`.
2. Add `apps/app/app/utils/print/<name>/vertical.server.ts` with a
   `PrintShopServerVertical` and register it in `vertical.server.ts`. Codes that
   are capabilities need `canView`; a source that can be down throws a 503
   `Response` from `resolve` (the editor then saves without approving).
3. Add `apps/app/app/components/print/<name>/vertical-ui.tsx` and register it in
   `vertical-ui.tsx`; add product names in Admin's `vertical-labels.ts`.
4. Keep business-type words in these files; the vocabulary test rejects them in
   the core.
