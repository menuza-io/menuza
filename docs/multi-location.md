# Multi-location control

Tools for owners with several locations (#125, #365, #332, #374, #418, #417).
Everything here is control-plane business data: no guest data, no regional call.

## Where things live

| Tool                         | Screen                                          | Server code                                                                                     |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Settings registry            | (none)                                          | `packages/common/src/location-settings-registry.ts` (the one place to add a copyable setting)   |
| Copy settings, add a holiday | Settings, Locations, "All locations" menu       | `utils/location/copy-settings.server.ts`, `packages/common/src/location-settings-copy.ts`       |
| Pause or resume many         | Locations list, select rows                     | `utils/location/bulk-ordering.server.ts` (calls `applyOrderingControl`, the Orders page writer) |
| Status                       | `/<org>/status` and the Status dashboard block  | `packages/common/src/location-health.ts`, `utils/status/location-status.server.ts`              |
| Tags, CSV                    | Settings, Locations, Tags and import            | `utils/location/tags.server.ts`, `locations-csv(.server).ts`                                    |
| Compare and edit             | Settings, Locations, Compare and edit a setting | `utils/location/bulk-edit.server.ts`                                                            |
| Chain defaults and locks     | Settings, Locations, Chain defaults and locks   | `utils/location/chain-defaults.server.ts`                                                       |

## Rules

- **Location scope** is resolved in one place, `resolveMemberLocationIds`
  (`utils/location/member-scope.server.ts`): explicit grants plus every location
  carrying a granted tag, read at the time. The staffing, reservations, loyalty
  and discounts resolvers delegate to it, so every token mint and scoped loader
  sees tags. `location-scope-guards.test.ts` fails if another file reads the
  grant tables. Tags and chain defaults are head office only (a member with
  every location): a scoped member who could tag locations could widen their own
  access.
- **Bulk writes** go through `commitLocationPatches`: one `db.batch`, so every
  location changes or none. (`db.transaction` on D1 does not wrap in a
  transaction.) D1 allows 100 bound parameters per statement: load by
  organization and filter in memory, chunk inserts.
- **Overrides** are not stored. A location overrides a chain default when its
  value differs from it. The default is copied into each inheriting location's
  own columns when it changes, so Sites and the region read the same columns as
  before. A location that already differs keeps its value and is listed.
- **Locks** are enforced by the server on every write path to a registry
  setting: the location form (compares in "form view" so an untouched save is
  never a change), copy, compare and edit, and the Google Business Profile and
  POS location imports. Clearing an override on a locked setting is allowed: it
  moves the location onto the locked default. Station and the phone agent never
  write a registry setting (they write pause and busy mode, Station register
  settings and the phone agent's own settings).
- **Status** checks run on page load from data the App has. Not covered: whether
  a kitchen screen or printer is online (per Station terminal, in the regional
  database).

## Adding a setting

Add one entry to `LOCATION_SETTINGS_REGISTRY` (columns, `read`, `write`,
`summarize`, `parse`, and `readForForm` if the edit form fills in a default) and
its Lingui labels in `components/locations/location-setting-labels.ts`. Copy,
compare and edit, chain defaults and locks then cover it.

## Deploy order

App only (one control-plane migration,
`0060_location_tags_and_setting_policies`, adds tables). Nothing changes for the
regions, Station, Sites or POS contract 11.
