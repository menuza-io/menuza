# Master Menu Publishing

Menuza is the single source of truth for an organization's menu ("master menu").
Operators edit freely, then explicitly **publish** a version to the targets they
choose: their storefront website and any connected POS / delivery channels (Uber
Eats, DoorDash, Square, Clover, …). This is the TryOtter / StreamOrders model:
edit in one place, publish everywhere.

## How it works

### Publish

Every menu has a publish state shown in **Menu → Menus** (badge column) and on
the menu detail page:

| Badge           | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| Not published   | Never published. Customers see **live** edits (legacy behavior).                         |
| Published       | Customers see the last published version.                                                |
| Changes pending | Published before, and live edits exist since. Customers see the older published version. |

Pressing **Publish…** opens a dialog where the operator picks targets:

- **Storefront** — freezes the current live menu into a snapshot that the public
  site serves. This is what customers order from.
- **Channels** — one checkbox per active, write-capable integration. Publishing
  pushes the menu to each selected channel through the same provider sync used
  by Settings → Integrations (idempotent via `OrganizationMenuPosLink`).
  Selections are remembered for the next publish of this menu.

Publishing is **explicit only** — there is no auto-publish. A publish event is
logged with per-target outcomes (`succeeded` / `partial` / `failed`); one
channel failing never blocks the others, and never blocks the storefront.

### Storefront gating

The public menu endpoint (`/resources/sites.menu`) assembles customer-facing
menus through `buildPublicMenusForOrganization`:

- If a menu has a published snapshot, the snapshot is served. Live edits stay
  invisible until the next storefront publish.
- If a menu has never been published (all pre-existing menus), live data is
  served — identical to the old behavior, so nothing changes for existing
  organizations until their first publish.

Location-level overrides (per-location availability, prices, hidden items)
always apply live on top of the published content, and storefront media URLs are
resolved live with cache busters. Expired "unavailable until" holds are
recovered at serve time without a republish.

### Dirty tracking

Menu mutations (items, categories, modifier groups, options, assignment changes,
reorders, deletes) mark every **published** menu containing the changed entity
`hasUnpublishedChanges = true`. Entity→menu resolution walks the full graph,
including parent categories and nested modifier groups. Menus that have never
been published keep the old live behavior instead: their edge KV cache is purged
on every edit.

## Data model

- `OrganizationMenu.hasUnpublishedChanges` — live edits exist since the last
  publish.
- `OrganizationMenuPublished` — one row per menu: the frozen snapshot JSON
  (`content`), a monotonic `revision`, and who published it.
- `OrganizationMenuPublish` — audit log of publish events (targets, status,
  revision, outcome JSON).
- `OrganizationMenuChannelState` — per menu × integration: sticky `selected`
  flag plus the last sync outcome (status, pushed count, error, timestamp).

## Code map

| Concern               | Location                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| Snapshot + assembler  | `apps/app/app/utils/menu/public-projection.server.ts`                              |
| Publish orchestration | `apps/app/app/utils/menu/publish.server.ts`                                        |
| Dirty tracking        | `apps/app/app/utils/menu/dirty.server.ts`                                          |
| Storefront endpoint   | `apps/app/app/routes/resources+/sites.menu.ts`                                     |
| Publish UI            | `apps/app/app/components/menu/publish-*.tsx`, `menu-publish-panel.tsx`             |
| Route wiring          | `apps/app/app/routes/_app+/$orgSlug_+/menu+/menus._index.tsx`, `menus.$menuId.tsx` |

## Permissions

- Viewing publish state: any member with menu read access.
- Publishing: org members. Publishing to channels additionally requires org
  admin (the same permission as the manual integration sync).

## Testing

Integration tests live next to the modules:

- `apps/app/app/utils/menu/public-projection.server.test.ts` — snapshot
  round-trip fidelity, gating before/after publish, malformed snapshot fallback,
  hidden-entity exclusion, expired-hold recovery.
- `apps/app/app/utils/menu/publish.server.test.ts` — snapshot freeze, revision
  bump, dirty flag clearing, event logging, channel fan-out with per-target
  error isolation.
- `apps/app/app/utils/menu/dirty.server.test.ts` — dirty flag resolution across
  categories, items, and nested modifier groups.
