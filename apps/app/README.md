<div align="center">
  <h1 align="center"><a href="#">The Epic Startup App Portal🚀</a></h1>
  <strong align="center">
    Ditch analysis paralysis and start shipping Epic Startup.
  </strong>
</div>

<hr />

## Docs

[Read the docs](https://github.com/mohammedzamakhan/epic-startup/blob/main/docs)
(please 🙏).

## Dashboards

The organization page (`/$orgSlug`) is each member's personal **Home**: a grid
of blocks built with `react-grid-layout` v2. Members can also create custom
dashboards at `/$orgSlug/dashboards/$dashboardId` and share them with other
members of the organization.

- **Blocks:** Stats, Notes chart, Onboarding checklist, Top contributors, and
  report blocks. A report block shows a saved report of the organization or a
  built-in report template.
- **Edit layout mode:** move blocks with the drag handle, resize, add, and
  remove blocks. Only Home has **Reset to default**, which deletes the stored
  Home so the default layout returns. Changes save automatically, about 500 ms
  after the last edit.
- **Switcher:** the dashboard title is a menu listing Home, My dashboards, and
  Shared with me.
- **Sharing:** the owner can share a custom dashboard with active organization
  members, each with **View** or **Edit** access. Edit recipients can change
  blocks and layout. Only the owner can rename, share, or delete a dashboard.
  Home cannot be shared.
- **Responsive and RTL:** below 768 px the grid is a single read-only column. In
  right-to-left locales the layout is mirrored for display and stored
  unmirrored.
- **Limits:** 30 blocks per dashboard, 25 custom dashboards per user per
  organization, and names of 1–60 characters.

### Data model

Migration `packages/database/drizzle/0018_dashboards.sql` adds two control-plane
tables:

- `Dashboard`: `organizationId`, `ownerId`, `kind` (`home` or `custom`), `name`,
  and `config` (JSON with `version`, `blocks`, and `layouts` for the `lg` and
  `md` breakpoints). A partial unique index allows one Home per user per
  organization. Home has no row until its first save; until then the loader
  returns `defaultHomeConfig()`.
- `DashboardShare`: primary key `dashboardId` + `userId`, with `access` (`view`
  or `edit`) and `sharedById`. Shares are deleted with their dashboard.

Stored configs are untrusted input. `parseStoredDashboardConfig()` falls back to
the default Home or an empty dashboard when a stored config is invalid.

### Where the code lives

All paths are relative to `apps/app/app/`.

- `utils/dashboards/config.ts`: Client-safe block registry
  (`BLOCK_DEFINITIONS`), grid constants, limits, Zod schemas,
  `normalizeDashboardConfig()` / `parseDashboardConfig()`,
  `defaultHomeConfig()`, `canEdit()` / `isOwner()`.
- `utils/dashboards/layout.ts`: Pure layout helpers: append and remove blocks,
  RTL mirroring, the stacked mobile layout, hidden-block handling, and block
  ids.
- `utils/dashboards/visibility.ts`: Which blocks are hidden for the viewer (for
  example, a completed or dismissed onboarding checklist).
- `utils/dashboards/access.server.ts`: `requireDashboardAccess()` /
  `requireCustomDashboardAccess()`: resolve `owner`, `edit`, or `view` access,
  or throw a 404.
- `utils/dashboards/queries.server.ts`: Drizzle queries: Home get/save/reset,
  create/rename/delete with the 25-dashboard cap, switcher lists, and shares.
- `utils/dashboards/actions.server.ts`: Form intents: `handleHomeAction()`
  (`save-config`, `reset`, `create`), `handleCustomDashboardAction()`
  (`save-config`, `rename`, `delete`, `share`, `unshare`), and
  `handleCreateDashboardAction()`.
- `utils/dashboards/block-data.server.ts`: Loader data: `loadBuiltInBlockData()`
  (loads only what the blocks on the dashboard need), `loadReportBlockData()`,
  and `loadBlockPicker()` for the Add block dialog.
- `utils/dashboards/reports.ts`: Resolves report blocks to saved reports or
  templates, and maps run errors to the "No access" state.
- `components/dashboard/dashboard-editor.tsx`: Header actions, edit mode, and
  the grid. `use-dashboard-editor.ts` holds the draft config, the debounced save
  through `useFetcher`, rollback on a 400, and a `keepalive` flush on
  `pagehide`.
- `components/dashboard/dashboard-grid.tsx`: The `react-grid-layout` grid, block
  frames, drag and resize handles, breakpoints, and RTL.
- `components/dashboard/dashboard-block-content.tsx`: Maps a block type to its
  component in `components/dashboard/blocks/`.
- `components/dashboard/*`: Also: `add-block-dialog.tsx`,
  `report-block-options.tsx`, `dashboard-switcher.tsx`,
  `dashboard-name-dialog.tsx`, `dashboard-options-menu.tsx` (rename and delete),
  and `share-dashboard-dialog.tsx`.
- `routes/_app+/$orgSlug_+/index.tsx`: Home loader and action.
- `routes/_app+/$orgSlug_+/dashboards+/index.ts`: `POST` creates a custom
  dashboard and redirects to it. `GET` redirects to Home.
- `routes/_app+/$orgSlug_+/dashboards+/$dashboardId.tsx`: Custom dashboard
  loader, action, and 404 page.

### Adding a block type

1. In `utils/dashboards/config.ts`, add the type to `BUILT_IN_BLOCK_TYPES` and
   add a `BLOCK_DEFINITIONS` entry with a Lingui `title` and `description`,
   `defaultSize` and `minSize` for `lg` and `md`, and `maxInstances`. The
   normalizer, size limits, and Add block dialog read from this registry. Add
   the block to `defaultHomeConfig()` only if it belongs on every new Home.
2. If the block needs server data, extend `BuiltInBlockData` and
   `loadBuiltInBlockData()` in `utils/dashboards/block-data.server.ts`. Load the
   data only when the block is on the dashboard.
3. Add the component under `components/dashboard/blocks/` and a `case` in
   `DashboardBlockContent`. While the data is `null` (a block that was just
   added), render the loading skeleton.
4. If some viewers should not see the block, add a rule to `hiddenBlockIds()` in
   `utils/dashboards/visibility.ts`.
5. Run `npm run lingui:extract`, and extend `config.test.ts` and
   `block-data.server.test.ts`.

### Permissions and status codes

- A missing dashboard, a dashboard in another organization, a dashboard that has
  not been shared with the user, a viewer who is no longer an active member of
  the organization, someone else's Home, or a Home id requested under
  `/dashboards/` returns **404**. The page and the action both answer the same
  way, so a 404 does not reveal whether a dashboard exists.
- A user who can open the dashboard but lacks the right returns **403**
  (`forbidden`): a View recipient saving, a recipient renaming, deleting,
  sharing, or unsharing, or any rename, delete, or share intent on Home.
- Invalid input returns **400** with `{ ok: false, error: { code, message } }`.
  Codes include `invalid-request`, `invalid-shape`, `unknown-block-type`,
  `duplicate-built-in`, `too-many-blocks`, `unknown-template`, `unknown-report`,
  `name-required`, `name-too-long`, `limit-reached`, `invalid-share-target`, and
  `invalid-access`. New report blocks must reference an organization template or
  a saved report of the same organization. References a dashboard already has
  remain valid, so a deleted report does not block later layout saves.

### Report blocks and data residency

Report blocks run in the browser with the viewer's own permissions, as on the
reports page (`useReportRunner` from `@repo/reports/ui`). Control-plane subjects
use `/$orgSlug/reports/run`. Tenant (customer) subjects request a short-lived
token from `/$orgSlug/reports/token`, and then the browser calls the
organization's regional tenant-api directly. The App server never fetches or
proxies customer data for a dashboard. Sharing a dashboard shares its layout,
not data: a recipient without access to a report sees a "No access" block. See
[tenant data residency](../../docs/tenant-data-residency.md).

### Tests

Unit and integration tests (Vitest, with a real migrated SQLite database) sit
next to the code:

- `app/utils/dashboards/*.test.ts`
- `app/components/dashboard/*.test.tsx` and
  `app/components/dashboard/blocks/report-block.test.tsx`
- `app/routes/_app+/$orgSlug_+/index.test.ts` and
  `app/routes/_app+/$orgSlug_+/dashboards+/*.test.ts`
- `app/hooks/use-mobile-viewport.test.ts`
- Fixtures: `tests/dashboard-utils.ts`

```sh
cd apps/app
npx vitest --run app/utils/dashboards app/components/dashboard \
  "app/routes/_app+/\$orgSlug_+/index.test.ts" \
  "app/routes/_app+/\$orgSlug_+/dashboards+"
```

End-to-end specs (Playwright) are `tests/e2e/dashboard.test.ts` (Home, edit
mode, report blocks, and the mobile layout), `tests/e2e/dashboard-multi.test.ts`
(custom dashboards and the switcher), and `tests/e2e/dashboard-sharing.test.ts`
(sharing and access). To run them without the interactive UI:

```sh
cd apps/app
npm run build
CI=true npx playwright test tests/e2e/dashboard*.test.ts --workers=1
```

## Support

- 🆘 Join the
  [discussion on GitHub](https://github.com/mohammedzamakhan/epic-startup/discussions).
- 💡 Create an
  [idea discussion](https://github.com/mohammedzamakhan/epic-startup/discussions/new?category=ideas)
  for suggestions.
- 🐛 Open a
  [GitHub issue](https://github.com/mohammedzamakhan/epic-startup/issues) to
  report a bug.

## Thanks

You rock 🪨
