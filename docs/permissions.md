# Permissions

The Epic Stack's Permissions model takes after
[Role-Based Access Control (RBAC)](https://auth0.com/intro-to-iam/what-is-role-based-access-control-rbac).
Each user has a set of roles, and each role has a set of permissions. A user's
permissions are the union of the permissions of all their roles (with the more
permissive permission taking precedence).

The default development seed creates fine-grained permissions that include
`create`, `read`, `update`, and `delete` permissions for `user` and `note` with
the access of `own` and `any`. The default seed also creates `user` and `admin`
roles with the sensible permissions for those roles.

You can combine these permissions in different ways to support different roles
for different personas of users of your application.

The Epic Stack comes with built-in utilities for working with these permissions.
Here are some examples to give you an idea:

```ts
// server-side only utilities
const userCanDeleteAnyUser = await requireUserWithPermission(
	request,
	'delete:user:any',
)
const userIsAdmin = await requireUserWithRole(request, 'admin')
```

```ts
// UI utilities
const user = useUser()
const userCanCreateTheirOwnNotes = userHasPermission(user, 'create:note:own')
const userIsUser = userHasRole(user, 'user')
```

There is currently no UI for managing permissions, but you can use Drizzle
Studio for establishing these.

## Organization permissions

Organization roles use a separate permission context
(`Permission.context = 'organization'`) and are checked with
`requireUserWithOrganizationPermission` (from `@repo/auth`, or the request-aware
wrapper in `apps/app/app/utils/organization/permissions.server.ts`).

Built-in organization roles are seeded in `packages/database/setup-roles.ts`:

- `org_role_admin` — every organization permission
- `org_role_member` — notes, members, read-only marketing/menus, and the inert
  staffing own-scope grants (see [Staffing permissions](#staffing-permissions))
- `org_role_viewer` — read-only notes, members, marketing, and menus
- `org_role_guest` — no permissions

Product areas are gated with these permissions:

| Area                     | Permissions                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Notes                    | `create/read/update/delete:note:own\|org`                                                                             |
| Members                  | `read/create/update/delete:member:any`                                                                                |
| Organization settings    | `read/update:settings:any`                                                                                            |
| Website pages/forms/etc. | `read/update:website:any`                                                                                             |
| Website announcements    | `read/update:announcement:any`                                                                                        |
| Marketing broadcasts     | `read/update:campaign:any`                                                                                            |
| Marketing automations    | `read/update:automation:any`                                                                                          |
| Menus and drops          | `read/update:menu:any`                                                                                                |
| AI phone agent           | `read/update:phone_agent:any`                                                                                         |
| AI phone calls           | `read:phone_call:any` (caller numbers, transcripts, recordings)                                                       |
| AI phone call follow-up  | `update:phone_call:any` (complete/reopen calls and requests, tags)                                                    |
| AI phone call deletion   | `delete:phone_call:any`                                                                                               |
| Team chat channels       | `update:chat:any` (using chat needs only channel access, see `docs/team-chat.md`)                                     |
| Team chat groups         | `create:chat:group` (DMs need no extra permission; group creation only)                                               |
| Staff                    | 18 `staff`, `schedule`, `timeclock`, `timesheet`, `labor`, `hiring` permissions                                       |
| Reservations             | 8 `reservation`, `reservation_guest`, `reservation_settings`, `reservation_report`, `reservation_payment` permissions |

Organization admins can create custom roles from `/{orgSlug}/settings/roles`;
only the permission IDs allow-listed in
`apps/app/app/utils/organization/tenant-role-permissions.ts` may be assigned to
a tenant-owned role.

### Staffing permissions

The Staff module (team roster, time clock, schedule, labor cost, hiring) uses
its own permissions. They are added by control-plane migration
`0022_staffing_foundation` and mirrored in `ORG_PERMISSIONS`
(`packages/auth/src/organization-permissions.server.ts`), `@repo/staffing`
(`STAFFING_PERMISSIONS`), `TENANT_ROLE_PERMISSION_IDS`, the role editor groups,
and `packages/database/setup-roles.ts`. A unit test fails if the lists drift.

| Permission                                           | Covers                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `read:staff:any`, `update:staff:any`                 | Roster, profiles (non-sensitive), positions, assignments, PIN reset, terminate, rehire |
| `read:staff_pay:any`, `update:staff_pay:any`         | Individual pay rates and wage history, and any money figure per person                 |
| `read:staff_private:any`, `update:staff_private:any` | Date of birth, address, emergency contact                                              |
| `read:schedule:any`, `update:schedule:any`           | View and edit shifts, publish, templates, availability and time-off decisions          |
| `read:timesheet:any`, `update:timesheet:any`         | View and edit time cards; hours export                                                 |
| `approve:timesheet:any`                              | Approve, lock, and unlock time cards (off by default even for managers)                |
| `read:labor:any`                                     | Aggregate labor cost and labor percentage                                              |
| `read:labor_policy:any`, `update:labor_policy:any`   | Labor policy, time clock devices, pay periods                                          |
| `read:hiring:any`, `update:hiring:any`               | Job posts, applicants, stages, interviews, hire                                        |
| `read:schedule:own`, `create:timeclock:own`          | Own published shifts and own clock. **Inert** until a login is linked to a staff row   |

Rules:

- **Seeding.** The built-in admin gets all of them. The built-in member gets
  only the two `own` permissions, which do nothing until a staff link exists.
  Viewer and guest get none.
- **Existing custom roles get no staffing grants.** Staffing has no safe
  analogue to copy from (even `read:member:any` must not imply wage or schedule
  access), so an organization admin grants staffing permissions to each custom
  role explicitly.
- **Update implies read.** The role editor ticks the matching read grant for you
  (and clears dependent grants when you clear a read grant). The role save
  actions re-apply the rule on the server so a crafted form cannot store an
  update grant without its read grant. `approve:timesheet:any` implies
  `read:timesheet:any`. Pay, private details, and labor cost never imply each
  other or the roster. At runtime a stronger grant also satisfies the matching
  read requirement (`grantsSatisfying` in `@repo/staffing`).
- **Wage and money fields are omitted from responses** (not hidden in the UI)
  without `staff_pay` or `labor`. That is enforced where the data lives, in the
  regional tenant API.
- **Scope.** Staffing access is organization-wide: the generic module has one
  implicit scope per organization and no member scope grants. The staffing token
  still carries `scopeIds` (`null` = every scope) and tenant-api applies
  `scopeToScopes` on every staff route, so a vertical that has several places
  can store its own member grants and mint a narrower list. See ADR 047,
  decision 13.
- **Token lag.** Tokens are stateless, so narrowing access (scope ids, role
  grants, removing the member, turning a flag off) applies when the current
  token expires: up to **15 minutes**, or **5 minutes** for tokens carrying pay
  or private grants. Widening applies on the next mint.
- **Wages in timesheets.** The `timeclock` token carries `read:staff_pay:any`
  and `read:labor:any` only while `staffing.labor` is on (and only if the user
  holds them). Without them the timesheet API leaves every rate, pay and tip
  figure out of its responses, edit-log snapshots and exports. Impersonated
  sessions never see them. Setting tips needs `read:staff_pay:any`.
- **Preset creation.** The Roles page lists a "Staff role presets" panel with a
  "Create role" button per preset (admins only, and only while Staff is on).
  Each creates one editable custom role; a name that already exists is refused,
  never overwritten.
- **Presets.** The role editor's "Start from a template" list includes editable
  _Shift manager_, _General manager_, and _Hiring manager_ presets. They are
  ordinary custom roles, not a new built-in level.
- **Hidden while Staff is off.** The role editor, the role view page, and the
  template list show the Staff groups and presets only when `staffing.enabled`
  is on for the organization. Saving a role while they are hidden keeps any
  staffing grants the role already holds.

#### Feature flags

Permissions alone never open the Staff module. Every staffing surface is behind
org-level feature flags that **default to off** (a missing flag is off, and only
the stored JSON value `true` turns one on):

| Flag                  | Gates                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| `staffing.enabled`    | Master: sidebar group, every staff route, the Team section, token mint |
| `staffing.timeclock`  | Time clock section: kiosk pairing, timesheets                          |
| `staffing.scheduling` | Schedule section and publishing                                        |
| `staffing.labor`      | Rates in reports, labor summary, minting the `labor` grant             |
| `staffing.hiring`     | Job posts, applicants, onboarding                                      |

A child flag counts only while the master flag is also on. Flags are read with
`getFeatureFlag` (`@repo/common/feature-flags`), so a system-level flag can turn
a feature on for every organization and an organization-level flag (including an
explicit `false`) overrides it. Set them from the admin app's Feature flags page
(type boolean, level organization); keys do not need to be registered.

Enforcement lives in `apps/app/app/utils/staffing/access.server.ts`:

```ts
// Every staffing loader and action calls this first. Parent loaders can be
// skipped on data requests, so the layout is not enough.
await requireStaffingAccess(request, params.orgSlug, {
	feature: 'timeclock', // flag (404 when off)
	anyOf: ['read:timesheet:any', 'read:labor_policy:any'], // permission (403)
})
```

A flag that is off returns **404** (the module looks like it does not exist); a
missing permission returns **403**. The same helper decides which Staff links
the sidebar shows. The operator tokens for the regional tenant API are minted
only after the same flag and permission checks, and the regional node honors
only tokens the App minted. A flag cannot stop an already paired kiosk (its
device secret lives on the tablet), so revoke kiosks before turning a flag off.

### Reservations permissions

The Reservations module (host stand, booking sheet, waitlist, guestbook CRM,
setup, experiences, reports, and deposit/prepayment refunds) uses 8 organization
permissions added by control-plane migration `0025_reservations_foundation` and
mirrored in `ORG_PERMISSIONS`
(`packages/auth/src/organization-permissions.server.ts`), `@repo/reservations`
(`RESERVATIONS_PERMISSIONS`), `TENANT_ROLE_PERMISSION_IDS`, the role editor
groups, and `packages/database/setup-roles.ts`.

| Permission                        | Covers                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `read:reservation:any`            | View Today host stand, Book day sheet, floor availability, and Waitlist                      |
| `update:reservation:any`          | Create/edit/cancel bookings, seat/unseat/move tables, manage walk-ins and waitlist           |
| `read:reservation_guest:any`      | View Guestbook CRM profiles, tags, visit/no-show history, and notes                          |
| `update:reservation_guest:any`    | Edit guest profiles, tags, dietary/private notes, and merge duplicate guests                 |
| `read:reservation_settings:any`   | View floor plans, areas, tables, combos, services, turn times, pacing, policies, experiences |
| `update:reservation_settings:any` | Edit floor plans, areas, tables, combos, services, turn times, pacing, policies, experiences |
| `read:reservation_report:any`     | View covers, utilization, no-show/cancellation analytics, and export CSVs                    |
| `update:reservation_payment:any`  | Charge cancellation or no-show fees and request reservation refunds                          |

Rules:

- **Seeding.** The built-in `admin` organization role gets all 8 permissions.
  Built-in `member`, `viewer`, and `guest` roles get none, and existing custom
  roles receive none automatically.
- **Implied read permissions.** `update:reservation:any` implies
  `read:reservation:any`; `update:reservation_guest:any` implies
  `read:reservation_guest:any`; `update:reservation_settings:any` implies
  `read:reservation_settings:any` (`IMPLIED_READ_BY_UPDATE` in
  `@repo/reservations`). `update:reservation_payment:any` implies nothing: the
  `payments` token scope needs `read:reservation:any` as well, so grant both
  (the `finance` preset does). The role editor and server-side save actions
  enforce these implications, and `hasGrantSatisfying` honors them at runtime.
- **Role presets.** When `reservations.enabled` is on, Settings → Roles offers
  one-click presets (`RESERVATIONS_ROLE_PRESETS`; they are not seeded in a
  migration): `host` (`read` and `update:reservation:any`), `shift_manager`
  (`read` and `update:reservation:any`, `read:reservation_guest:any`,
  `read:reservation_report:any`), `reservations_manager` (reservation, settings
  and guest read and update, `read:reservation_report:any`), `guest_relations`
  and `guestbook_manager` (`read:reservation:any`, guest read and update),
  `finance` (`read:reservation:any`, `read:reservation_report:any`,
  `update:reservation_payment:any`) and `owner` (all 8). The Staffing role
  presets do not include reservation permissions.
- **Hidden while Reservations is off.** The role editor, role view page, and
  preset panels show the Reservations permission group and presets only when
  `reservations.enabled` is on for the organization. Editing a role while
  `reservations.enabled` is off preserves any existing Reservations permissions
  on that role.
- **Location scoping (`UserOrganization.locationScope`).** The scope is `all` or
  `selected` (with `UserOrganizationLocation` rows), the same one Staffing uses.
  `all` means every active location (`locationIds: null` in `rsv+jwt`).
  `selected` becomes a non-empty `locationIds` array:
  `requireReservationsAccess` and `GET /:orgSlug/reservations/token` intersect
  it with the organization's active locations (`403` when the intersection is
  empty), and `rsvGuard` in `apps/tenant-api` enforces `locationIds` on every
  location-scoped endpoint. The guestbook is organization-wide and is not
  filtered by location (known issue in
  [the guide](./reservations.md#known-issues-and-known-gaps)).
- **Shorter TTL and impersonation restrictions.** Operator `rsv+jwt` tokens have
  a 15-minute TTL, shortened to **5 minutes** when carrying a sensitive grant
  (`read:reservation_guest:any`, `update:reservation_guest:any`,
  `update:reservation_payment:any`; `SENSITIVE_GRANTS`) or during support
  impersonation (`impersonated: true`). Settings grants are not sensitive. Under
  impersonation, all write (`update:*`) and sensitive grants are stripped so
  support sessions are strictly read-only and cannot mutate settings or guests
  or issue refunds.

#### Reservations feature flags

Permissions alone never open the Reservations module. Every Reservations surface
and token mint is behind org-level feature flags read with `getFeatureFlag`
(`@repo/common/feature-flags`) that **default to off**:

| Flag                           | Gates                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `reservations.enabled`         | Master: sidebar group, every `/<orgSlug>/reservations/*` route, operator token mint                 |
| `reservations.online`          | Public `/reserve` widget on Sites, iOS/Android booking flows, and public hold/booking routes        |
| `reservations.waitlist`        | Operator Waitlist section and public online waitlist join                                           |
| `reservations.payments`        | Deposit, card guarantee and prepaid policies (`rsv_policies`) plus refund and fee routes            |
| `reservations.experiences`     | Operator Experiences section and public ticketed experiences                                        |
| `reservations.voice`           | AI phone agent reservation availability, hold + SMS link, and direct voice booking                  |
| `reservations.platform_fee_bp` | Numeric platform fee in basis points (`0..10000`, system default `250`) on deposits and prepayments |

Enforcement lives in `apps/app/app/utils/reservations/access.server.ts` via
`requireReservationsAccess(request, params.orgSlug, { feature, anyOf })`, which
returns **404** when a required flag is off and **403** when the member lacks
the required permission or has an empty location intersection.

## Platform (system) permissions

The admin app checks platform-level permissions
(`Permission.context = 'system'`) with `requireUserWithPermission` /
`requireAnyUserWithPermission` from `@repo/auth`, using the strings in
`packages/auth/src/system-permissions.ts`:

| Area                 | Permissions                           |
| -------------------- | ------------------------------------- |
| Platform broadcasts  | `read/update:platform_campaign:any`   |
| Platform automations | `read/update:platform_automation:any` |

The built-in `admin` system role is granted every system permission by the
`0013_website_announcement_marketing_permissions` migration and by
`setupRoles()`. System roles and their permissions are managed from the admin
app's Roles page (`/roles`), and organization roles (shared platform roles) are
managed from the same page.

## Seeding the production database

Check [the deployment docs](./deployment.md) for instructions on how to seed the
production database with the roles you want.
