# Reservations i18n: decision document

Status: investigation only (read-only). Revised after the product-owner
correction: owners DO type each language themselves. What is wrong in
Reservations is that the languages are hard-coded (fixed `en`/`ar`, fixed
six-language lists, "Arabic name" inputs, the operator's UI language used as the
starting language) instead of being driven by the organization's Website
settings languages, as the Menu and Drops pages do.

---

## 1. The app's pattern (canonical, from Menu and Drops first)

### 1.1 Where the language list lives

- Stored on the control-plane `Organization` row: `siteLocales` (JSON array
  string) and `siteDefaultLocale` (`'en'` default).
  `packages/database/src/schema.ts` ~L2422.
- Edited at Website settings by
  `apps/app/app/components/settings/cards/organization/site-locales-card.tsx`
  (`SiteLocalesSchema`, intent `update-site-locales`): multi-select of languages
  plus a default language that must be one of them.
- The list of languages that may be chosen is ONE shared constant:
  `SITE_CONTENT_LOCALES = ['en','ar','es','fr','de','zh']` in
  `packages/common/src/site-locales.ts`, with `SITE_CONTENT_LOCALE_LABELS`,
  `RTL_SITE_LOCALES`, `isSiteContentLocale`, `getSiteLocaleLabel`,
  `getSiteLocaleDirection`. It mirrors the Sites Lingui catalogs
  `apps/sites/src/locales/{en,ar,es,fr,de,zh}.po` (loaded in
  `apps/sites/src/lib/i18n.ts`, `createSiteI18n`). The iOS/Android `SiteLocale`
  and mobile i18n provider also follow it.
- Loaders turn the two columns into a config with
  `parseSiteLocalesConfig(siteLocales, siteDefaultLocale)` ->
  `{ locales, defaultLocale }` (default is always forced into `locales`). Every
  Menu/Drops/Website route loader does this (for example
  `menu+/categories.$categoryId.tsx` L76-81, `menu+/drops.$dropId.tsx` L46-48)
  and passes `defaultLocale` and `supportedLocales` to the form component.

### 1.2 Storage per entity

Menu items, categories, menus, modifier groups, options and drops store each
guest-facing text field as ONE text column holding a locale map serialized as a
JSON string: `displayName`, `description`, etc.
(`packages/database/src/schema.ts` L2793, 2828, 2906, 3062). Example
`{"en":"Starters","ar":"مقبلات"}`. A legacy plain string is read as the default
language. Helpers in `packages/common/src/site-locales.ts`:

- `parseLocalizedString`, `serializeLocalizedString` (drops empty values),
  `LocalizedString` type.
- `pickLocalized(map, locale, defaultLocale)`: exact locale, then language base
  (`ar-SA` -> `ar`), then the DEFAULT locale, then the first non-empty value.
- `getLocalizedEditableValue` (no trim, for typing).
- Menu-specific `getLocalizedMenuValue(val, locale, defaultLocale)` in
  `packages/common/src/menu-types.ts` (exact, then default, then first).

Other places use the same idea with different containers: website blocks keep
JSON maps inside the block `config` at paths listed in `LOCALIZED_FIELDS`
(`apps/app/app/utils/website/block-types.ts`); announcements keep `content` and
link labels as JSON maps (`announcement-sheet.tsx`, `parseLocalizedString`);
hiring jobs use a `translations` JSON column
`{ [locale]: { title, descriptionHtml, prompts } }` (`schema.ts` L3775) with the
editor in `components/hiring/job-editor.tsx` and `localized-fields.tsx`;
Locations store a localized name (`displayLocationName`,
`components/locations/location-form.tsx`). Forms use
`utils/website/form-translation.ts`.

There is NO per-language column anywhere (`name_ar` style columns exist only on
staff-module tables, which are staff-facing, see section 2).

### 1.3 Editor UX (Menu and Drops is the canonical one)

`apps/app/app/components/website/locale-fields.tsx`:

- `LocaleContext` `{ activeLocale, defaultLocale, locales, setActiveLocale }`.
- `LocaleSwitcher`: radio group of language codes (EN, AR, ...), tooltip with
  the language label, arrow-key navigation. It renders nothing when
  `locales.length < 2`, so a one-language organization sees a single ordinary
  input and nothing else.
- `LocalizedInput` / `LocalizedTextarea`: ONE input that shows and writes the
  value of `activeLocale` (reads with `getLocalizedEditableValue`, writes with
  `updateLocalizedValue`). The form keeps a hidden input holding the JSON
  string.
- When `activeLocale !== defaultLocale` the field shows an inline
  `TranslateButton` (`components/website/translate-provider.tsx`).

A form wires it like `menu+/categories` -> `components/menu/category-form.tsx`:
`const [activeLocale, setActiveLocale] = useState(defaultLocale)`; wrap the form
in
`<LocaleContext.Provider value={{activeLocale, defaultLocale, locales: supportedLocales, setActiveLocale}}>`
and `<TranslateProvider activeLocale defaultLocale>`; hidden
`<input name="displayName" value={displayName}>`; `<MenuFormHeader>`
(`menu-form-header.tsx` L70) hosts the `<LocaleSwitcher>`; the guest-facing
fields use `LocalizedInput`/`LocalizedTextarea`, internal fields (for example
"Internal Reference") use a plain `Input`. Labels say "(Guest-Facing)". The same
wiring exists in `item-form.tsx`, `menu-form.tsx`, `modifier-form.tsx`,
`option-form.tsx`, `drop-wizard/drop-form.tsx`, and in the announcement sheet,
`pages.$pageId.tsx`, `form-builder-sidebar.tsx`, `hiring/job-editor.tsx`
(`LocalizedTextField`, `TranslatingNotice`: "Writing the X version. Anything you
leave blank is shown in Y.").

Default language is required (the default-locale field is the source of truth);
other languages are optional. The default-language value of a field is shown as
placeholder/fallback while another language is active.

### 1.4 The existing Translate helper (exists, optional, not the mechanism)

Menu/Drops/pages already have it, so Reservations may reuse it for free but it
is NOT how languages are populated:

- Client: `TranslateButton`, `TranslateItemsButton`, `TranslateAllButton`,
  `TranslateProvider` (dialog "Untranslated only" / "Translate all" when some
  fields already differ from the default: `TranslateItem.hasCustomTranslation`
  in `utils/website/translation.ts`).
- Server: `apps/app/app/routes/api+/translate.ts` -> Google Translate v2
  (`ENV.GOOGLE_API_KEY`). Requires a signed-in user,
  `requireUserOrganization(orgSlug)` and `ORG_PERMISSIONS.UPDATE_WEBSITE_ANY`;
  Zod: `sourceLang`/`targetLang` must pass `isSiteContentLocale`, text max 2000
  chars, max 50 strings; DB-backed rate limit scope `api-translate` 30 req/min
  per IP (1000 in dev); output passes `sanitizeWebsiteContent`; 503 if the key
  is missing. It needs `useParams().orgSlug`, which the reservations routes
  have.

Staleness: none is tracked anywhere. Changing the default text leaves other
languages as written; the owner re-translates by hand or with the helper (the
helper only counts a field as "custom" if it differs from the default). Do not
invent a staleness mechanism for Reservations.

### 1.5 How Sites resolves the visitor language

- `apps/sites/src/middleware.ts` + `resolveSiteLocaleRequest`
  (`packages/common/src/site-locales.ts`): the path prefix `/ar/...` is
  canonical, the default language is unprefixed, `?lng=` 301s to the prefix
  form, a language that is not in the org's enabled list is 404. Result goes to
  `Astro.locals.requestedLocale` and `defaultLocale`.
- Content: `getLocalizedMenuValue(val, requestedLocale, defaultLocale)`
  (menu.astro L113) or `pickLocalized`. Fallback order: requested, default, any.
- Fixed UI chrome is NOT operator data. It is Lingui: `msg` descriptors in the
  Sites source, catalogs `apps/sites/src/locales/*.po` for all six languages,
  `createSiteI18n(locale)` per request, extracted and checked by
  `scripts/check-lingui.mjs`. Reservation chrome is
  `apps/sites/src/lib/reservations/labels.ts` (`buildReservationLabels(i18n)`,
  every client string resolved on the server and handed to the client modules)
  with `test-labels.ts` / `reservations-labels.test.ts` as the guard.
- Operator content that reaches the browser client-side (like reservations) is
  resolved by the API: Sites passes the page locale (`api.config(locale)`,
  `api.experiences(locale)`, booking payload `guest.locale` in
  `lib/reservations/api.ts` / `flow.ts`).
- The App App/Admin operator UI language (`i18n.locale`, en/ar) is a separate
  thing and must never choose which content language is shown or edited.

---

## 2. Reservations inventory (current state, from the working tree)

Common context: the data lives in the regional tenant DB
(`packages/tenant-db/src/schema.ts`). Every guest-facing text is already a
`*_i18n` JSON map `Record<string,string>` (same shape as Menu's map, just a JSON
column instead of a JSON string), with the canonical `name` column as the
default text. So the STORAGE shape is right; the problems are the hard-coded
language sets and the pick logic.

Where the hard-coding lives:

- Fixed six-language lists: `EXPERIENCE_I18N_LOCALES`
  (`packages/reservations/src/schemas/experience-setup.ts` L19, strictObject per
  locale), `EXPERIENCE_LOCALES`
  (`apps/app/app/utils/reservations/experiences-api.ts` L25), `POLICY_LOCALES`
  (`policies-api.ts` L30), `RSV_MESSAGE_LOCALE_VALUES` (schema enum, used by
  `rsv-policy-service.ts` `termsSchema` and `rsv_message_texts.locale`), locale
  label maps in `experiences-view.ts` / `policies-view.ts` /
  `message-labels.ts`.
- Only en/ar: `MESSAGE_LOCALES = ['en','ar']`
  (`apps/app/app/utils/reservations/messages-api.ts` L7 and
  `apps/tenant-api/src/services/rsv-message-settings-service.ts` L35),
  `ReservationEmailLocale = 'en' | 'ar'` and `normalizeReservationLocale`
  (anything not `ar*` becomes `en`) in
  `apps/tenant-api/src/lib/reservations-email.ts` L21/L56, `reservations-sms.ts`
  (EN/AR dictionaries), `rsv-message-service.ts` L122 (`locale as 'en' | 'ar'`),
  `book-api.ts` L2264 `preferredLocale?: 'en'|'ar'`.
- Hard-coded "Arabic" inputs: `reservations+/settings.services.tsx` (`nameAr`,
  "Arabic name"), `settings.tables.tsx` (`areaNameAr`, "Name in Arabic"),
  `settings.special-days.tsx` (`sdNoteEn`/`sdNoteAr`, "Public guest note
  (Arabic)"), `settings._index.tsx` L682-736 ("Confirmation message (Arabic)",
  "Booking & cancellation policy (Arabic)"), `messages/message-settings.tsx`
  L560-620 (notes in "English and Arabic"), `policy-sheet.tsx` L109 and
  `experience-editor.tsx` L149 / `experience-create-sheet.tsx` L88 (start
  language = operator's UI language `i18n.locale === 'ar' ? 'ar' : 'en'`, picker
  lists all six regardless of site settings).
- Hard-coded `en` key as the default: `nameI18n: { en: name, ...}` in
  services/areas/special-days (`settings.services.tsx` L446,
  `settings.tables.tsx` L313/329, `settings.special-days.tsx` L356),
  `floor-plan-canvas.tsx` L303 (`{ en: 'Main Dining' }`), tenant-api
  `rsv-setup-crud.ts` (`input.nameI18n ?? { en: ... }` L228, 1542, 1949), and
  the shared `pickI18n` (`apps/tenant-api/src/services/rsv-special-days.ts` L17)
  which falls back to `map.en`, not the organization default.
- Guest locale defaults to `'en'` everywhere: `guest.locale || 'en'` in
  `rsv-public-booking-service.ts`, `rsv-waitlist-service.ts` L543,
  `rsv-message-queue.ts`, schema defaults `locale text default 'en'` on
  `rsv_guests`, `rsv_reservations.guest_locale`, waitlist and notify tables;
  `readLocale` in `routes/reservations-public.ts` L117 reduces
  `Accept-Language`/`?locale` to a base code without checking it against the
  org's enabled languages.
- Site languages are not passed to the Reservations UI at all. The reservations
  `_layout.tsx` and `settings.tsx` loaders only fetch `defaultLocale` to name
  locations. The organization context endpoint already supplies
  `organization.defaultLocale` and `organization.locales` to tenant-api
  (`apps/app/app/routes/resources+/reservations.context.ts` L185-221, read in
  `apps/tenant-api/src/lib/reservations-context.ts` and used in
  `rsv-message-service.ts` `siteBase`).

Inventory. "Guest-facing" = a guest can see it in the booking page, manage page,
confirmation, SMS or email.

| Item                                                                           | Storage                                                                                                               | Locales today                                                            | Guest-facing?                                                                                             | Verdict                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Experience name                                                                | `rsv_experiences.name_i18n` (notNull map)                                                                             | fixed six, strictObject; editor starts in operator UI language           | Yes (booking page, experiences pages)                                                                     | Translate: site languages, required default-language value                                                                                                                                                                                             |
| Experience description                                                         | `rsv_experiences.description_i18n`                                                                                    | fixed six                                                                | Yes                                                                                                       | Translate: site languages, optional                                                                                                                                                                                                                    |
| Experience slug                                                                | `rsv_experiences.slug`                                                                                                | ASCII                                                                    | URL only                                                                                                  | Keep single (not translated; do not derive from a non-default language)                                                                                                                                                                                |
| Service name (Dinner, Brunch)                                                  | `rsv_services.name` + `name_i18n`                                                                                     | en + "Arabic name" input                                                 | Yes (service chooser in public config, `rsv-public-service.ts` L119)                                      | Translate: site languages                                                                                                                                                                                                                              |
| Area name (Patio, Bar)                                                         | `rsv_areas.name` + `name_i18n`                                                                                        | en + "Name in Arabic"                                                    | Yes (seating preference, public config L158; slot `area` in engine L397)                                  | Translate: site languages                                                                                                                                                                                                                              |
| Replacement service created by a special day                                   | `rsv_services.name_i18n` created from `settings.special-days.tsx`                                                     | `{en}` only                                                              | Yes                                                                                                       | Translate: same inputs as a service                                                                                                                                                                                                                    |
| Special day public note                                                        | `rsv_special_days.public_note_i18n`                                                                                   | en + "(Arabic)"                                                          | Yes (closed/limited message, `rsv-special-days.ts`)                                                       | Translate: site languages                                                                                                                                                                                                                              |
| Special day name                                                               | `rsv_special_days.name`                                                                                               | one string                                                               | No (staff label; the guest sees the public note)                                                          | Keep single-language                                                                                                                                                                                                                                   |
| Location (restaurant) name and address                                         | control-plane `Location` (localized name via `displayLocationName`, `location-form.tsx`), phone                       | site languages (already correct)                                         | Yes                                                                                                       | Keep as is; make tenant-api pick by guest locale with org default fallback; verify the closed/hours note follows the same rule (see `special-days-vs-location-hours.md`)                                                                               |
| Location public note                                                           | `rsv_location_settings.public_note_i18n`                                                                              | en + ar ("Confirmation message (Arabic)" input in `settings._index.tsx`) | Yes (public config `publicNote`)                                                                          | Translate: site languages                                                                                                                                                                                                                              |
| Large-party note                                                               | `rsv_location_settings.large_party_note_i18n`                                                                         | en + ar ("Booking & cancellation policy (Arabic)" input)                 | Yes (public `largeParty.note`)                                                                            | Translate: site languages. Note: `settings._index.tsx` L157-160 maps the "confirmation" draft onto `publicNoteI18n` and the "policy" draft onto `largePartyNoteI18n`; the labels and the storage disagree, fix the label/field mapping while rewriting |
| Policy name                                                                    | `rsv_policies.name`                                                                                                   | one string                                                               | No (not in the public payload; staff label)                                                               | Keep single-language                                                                                                                                                                                                                                   |
| Policy cancellation terms / consent text                                       | `rsv_policies.terms_i18n`                                                                                             | fixed six enum                                                           | Yes (manage page, booking consent, `rsv-public-booking-service.ts` L254, `rsv-experience-public.ts` L105) | Translate: site languages. Changing terms bumps `terms_version` (already exists); consent is recorded against the guest's language version                                                                                                             |
| Message custom notes (confirmation, reminder, waitlist ready, ...)             | `rsv_message_texts` one row per (location, kind, locale), `custom_note`                                               | enum six in DB, but App and service limited to en/ar                     | Yes (appended to guest SMS/email)                                                                         | Translate: site languages, rows per locale (shape already right)                                                                                                                                                                                       |
| Shipped message templates (subjects, bodies, SMS)                              | hard-coded EN and AR dictionaries in `reservations-email.ts`, `reservations-sms.ts`                                   | en, ar; every other language gets English                                | Yes                                                                                                       | Translate: ship templates for all six site languages (catalogs, section 3.6)                                                                                                                                                                           |
| Tag names: guest-selectable occasion and dietary                               | `rsv_tags.name` + `name_i18n` (`guest_selectable`)                                                                    | `name_i18n` exists, no per-language editor found                         | Yes (booking form chips; booking summary `pickI18n(occasion.nameI18n...)`)                                | Translate: site languages for `guest_selectable` tags and shipped system/default tags                                                                                                                                                                  |
| Tags: VIP, seating, regular, custom, system, `sensitive`                       | `rsv_tags`                                                                                                            | n/a                                                                      | No (staff-only; sensitive must never reach the guest)                                                     | Keep single-language                                                                                                                                                                                                                                   |
| Table label                                                                    | `rsv_tables.label`                                                                                                    | one string                                                               | No (staff floor plan; not in the public payload)                                                          | Keep single-language                                                                                                                                                                                                                                   |
| Section layout / section names, section assignments                            | `rsv_section_layouts`, `rsv_sections.name`                                                                            | one string                                                               | No                                                                                                        | Keep single-language                                                                                                                                                                                                                                   |
| Floor elements, combos                                                         | `rsv_floor_elements`, `rsv_table_combos`                                                                              | none                                                                     | No                                                                                                        | Keep                                                                                                                                                                                                                                                   |
| Blocks reason and note                                                         | `rsv_blocks.reason/note`                                                                                              | one string                                                               | No (blocks only remove availability)                                                                      | Keep single-language                                                                                                                                                                                                                                   |
| Service notes (pre-shift notes)                                                | `rsv_service_notes.body`                                                                                              | one string                                                               | No (staff)                                                                                                | Keep                                                                                                                                                                                                                                                   |
| Guest notes, allergy notes, reservation notes, request text                    | `rsv_guest_notes`, `rsv_guests.allergy_notes`, reservation notes                                                      | free text typed by staff or the guest                                    | Guest-written text is echoed back as typed                                                                | Never translate (user data)                                                                                                                                                                                                                            |
| Waitlist copy shown to guests                                                  | waitlist messages are message kinds (`waitlist_joined`, `waitlist_ready`, `notify_available`) + chrome in `labels.ts` | with messages                                                            | Yes                                                                                                       | Covered by message rows + Lingui chrome                                                                                                                                                                                                                |
| Public error messages                                                          | error codes in tenant-api; `apps/sites/src/lib/reservations/errors.ts`                                                | Lingui (six catalogs)                                                    | Yes                                                                                                       | Already correct; keep as chrome                                                                                                                                                                                                                        |
| Staff names (`first_name_ar`, `last_name_ar`, `staff_positions.name_ar`)       | staff tables                                                                                                          | Arabic columns                                                           | No (staffing module, not Reservations)                                                                    | Out of scope; do not touch                                                                                                                                                                                                                             |
| `rsv_guests.locale`, `rsv_reservations.guest_locale`, waitlist/notify `locale` | text default `'en'`                                                                                                   | any string                                                               | Controls message language                                                                                 | Fix defaults (3.5)                                                                                                                                                                                                                                     |

---

## 3. Recommended design

Principle: Reservations uses the SAME language list, the SAME editor components,
the SAME fallback rule as Menu and Drops. No per-language fields, no "Arabic"
anywhere, no language decided by the operator's UI language.

### 3.1 Language source

- One list: `parseSiteLocalesConfig(org.siteLocales, org.siteDefaultLocale)`
  from `@repo/common/site-locales`. Valid keys are `SITE_CONTENT_LOCALES`.
- App side: add the config to the reservations `_layout.tsx` loader (it already
  fetches the default locale) and expose `useReservationLocales()` (a tiny hook
  over `useRouteLoaderData`) returning `{ locales, defaultLocale }`. The
  settings routes and the sheets read it from there instead of hard-coding.
- tenant-api side: it already receives `organization.defaultLocale` and
  `organization.locales` in the reservations context. Use them to validate input
  and to resolve output.

### 3.2 Storage shape

- Keep the existing `*_i18n` JSON map columns (`Record<localeCode,string>`, same
  content as Menu's map; Menu only differs by serializing it into a text
  column). No new columns, no per-language columns, no separate rows (except
  `rsv_message_texts`, which is already one row per locale).
- The canonical `name` column keeps meaning "default-language text" and is
  written from the default-locale input when saving. The default-language entry
  in the map is required for guest-facing names; other languages are optional.
- Replace every hard-coded `{ en: ... }` default with
  `{ [defaultLocale]: ... }`.
- Validation: replace the fixed `strictObject` / enums with one shared Zod
  helper in `packages/reservations` (`localizedTextSchema(maxLen)`) =
  `z.record(z.string().refine(isSiteContentLocale), z.string().trim().max(maxLen))`,
  with each key checked against the organization's enabled `locales` in
  tenant-api (a language removed from Website settings later is dropped on next
  save but not destroyed on read; the value is simply not shown, as in Menu).
- Migration: allowed (no live customers), but the shape does not change. Only
  needed: (a) `rsv_message_texts.locale` enum column can stay (it already lists
  all six); no migration. (b) change defaults `'en'` on guest locale columns is
  not required if the application always sets the value (preferred; avoids a
  table rebuild). If desired, a generated migration may drop the `default 'en'`.
  Seed and fixture data that use `{ en: ... }` must be updated to the default
  locale of the seeded org.

### 3.3 Editor UX

- A reservations `LocalizedMapProvider` (small wrapper in
  `apps/app/app/components/reservations/localized-fields.tsx`): provides
  `LocaleContext` from `useReservationLocales()` with `activeLocale` state
  starting at the DEFAULT locale, and `TranslateProvider`. It is mounted in each
  editor sheet or screen that has a guest-facing field.
- `LocaleSwitcher` (exact component from `components/website/locale-fields.tsx`)
  goes in the sheet/screen header. It hides itself when the org has one
  language, so single-language owners see exactly one input per field and no
  extra inputs.
- Per field: `LocalizedMapInput` / `LocalizedMapTextarea`, thin adapters over
  `LocalizedInput` / `LocalizedTextarea` that take and return
  `Record<string,string>` (they `JSON.stringify` into the existing component and
  `JSON.parse` the result; no new behavior). The built-in inline Translate
  button therefore comes for free and stays optional.
- Label guest-facing fields "(Guest-Facing)" and keep internal fields (table
  label, policy name, special-day name, block reason) as plain `Input`, as the
  Menu does with "Internal Reference".
- Missing translation: nothing blocks saving; the default-language value is the
  fallback. Optional (cheap, Menu does not have one): the switcher tooltip is
  enough; do not add a new indicator system.
- Remove: `nameAr`, `areaNameAr`, `sdNoteEn/sdNoteAr`, the "(Arabic)" pair in
  `settings._index.tsx`, the `MESSAGE_LOCALES.map` two-column grid in
  `message-settings.tsx`, `textLocale`/`termsLocale` selects and
  `*_LOCALE_LABELS` maps (use `getSiteLocaleLabel`, `getSiteLocaleDirection` for
  `dir`).

### 3.4 Public API and Sites resolution

- Sites already passes the page locale. Keep it. Add an explicit contract:
  `locale` query/`guest.locale` is one of the org's enabled languages, otherwise
  the org default.
- tenant-api: replace the local `pickI18n` with a thin wrapper over
  `pickLocalized(map, locale, orgDefaultLocale)` from
  `@repo/common/site-locales` (tenant-api already depends on `@repo/common`).
  Order: exact, language base, ORG DEFAULT, canonical `name` column, first
  non-empty. Remove the hard-coded `map.en` step and the "borrow another
  language" flag in favor of the canonical column fallback for names. Every call
  site (`rsv-public-service.ts`, `rsv-public-engine.ts`,
  `rsv-experience-public.ts`, `rsv-public-booking-service.ts`,
  `rsv-special-days.ts`) must receive `ctx.organization.defaultLocale`.
- `readLocale` in `routes/reservations-public.ts`: validate against
  `ctx.organization.locales`; unsupported or missing becomes the org default
  (not `null`/`'en'`).
- Sites chrome stays Lingui (`labels.ts`); no change except new strings follow
  the existing extract/check workflow.

### 3.5 Guest message language

- Resolution order for every SMS/email: the reservation's `guest_locale` (taken
  from the booking page language) if it is an enabled org language, else the org
  default language. Replace `normalizeReservationLocale` (`ar` or `en`) with
  `resolveGuestLocale(value, org.locales, org.defaultLocale)`; replace each
  `|| 'en'` with the org default. Keep storing the guest's chosen page language
  in `rsv_guests.locale` / `guest_locale` / waitlist / notify rows.
- `rsv_message_texts` custom notes: editor shows ONE textarea per kind with the
  shared `LocaleSwitcher` (per-locale rows are saved on change, same endpoint,
  widen `MESSAGE_LOCALES` to `SITE_CONTENT_LOCALES`, validated against enabled
  locales). Message to a guest: note for their language, else note for the org
  default language, else none. The guest note is never machine-translated at
  send time.
- Shipped default templates (subject, body, SMS, labels such as "minutes",
  greeting fallback "there"): needed for all six site languages, because any
  enabled language can be a guest language. Put them in a typed per-locale
  dictionary (one file per locale next to `reservations-email.ts`:
  `Record<SiteContentLocale, MessageCopy>` so adding a locale to
  `SITE_CONTENT_LOCALES` breaks the typecheck until its copy exists); Intl
  formatting uses the locale (`intlLocale` generalised, keep `-u-nu-latn` for
  Arabic); `dir`/`align` from `getSiteLocaleDirection`. Operators do not author
  these; this is fixed chrome, the same category as Sites Lingui catalogs. (A
  tenant-api Worker should not load `.po` files at runtime; if the team prefers
  Lingui here too, the same `msg` + catalog + `check-lingui` flow applies, but
  that is a larger change and is not required.)
- Preview endpoint (`rsv-message-settings-service.ts` L299-370, sample name
  `سارة`/`Sam`) must take any enabled locale and use a per-locale sample name.

### 3.6 Translate API considerations (only if reservations use the existing helper)

- Reservation editors get the helper automatically through `TranslateProvider`;
  no new endpoint. It already enforces the website permission
  (`UPDATE_WEBSITE_ANY`; check that reservation managers who edit these fields
  hold it, otherwise the button shows an error toast, not a data leak), a 30
  req/min/IP limit, 2000 chars/string, 50 strings/batch, and sanitizes output.
  Cost is per character via Google Translate; policy terms and large-party notes
  are the long fields. Terms text is legal text: machine output goes into the
  field for the owner to review; changing it bumps `terms_version`.
- Staleness: same as the rest of the app (not tracked). Nothing new.

### 3.7 What stays single-language

See the "do not translate" list in section 4.4.

---

## 4. Change list

### 4.1 Order of work

1. `packages/reservations`: shared localized-text Zod helper + remove fixed
   lists.
2. tenant-api: validation against org locales, resolution/pick, guest locale,
   message system for all languages.
3. App: provider/hook, editors one by one, remove Arabic fields.
4. Sites: verify locale pass-through and add tests (little code).
5. Docs, then full checks.

### 4.2 By file

Packages

- `packages/reservations/src/schemas/experience-setup.ts`: delete
  `EXPERIENCE_I18N_LOCALES` and `i18nShape` strictObject; use shared
  `localizedTextSchema` (keys must be `isSiteContentLocale`; require non-empty
  default-locale entry at the service layer where the org default is known).
- `packages/reservations/src/schemas/setup.ts` (`nameI18n`, `publicNoteI18n`,
  `largePartyNoteI18n` records) and `schemas/public-contract.ts`: use the same
  helper; no behavior change in shape.
- New `packages/reservations/src/i18n.ts`: `localizedTextSchema`,
  `resolveGuestLocale(value, locales, defaultLocale)`, re-export of
  `pickLocalized` usage (single place to import from).
- `packages/tenant-db/src/schema.ts`: no shape change. Optionally remove
  `default('en')` from `rsv_*` locale columns and generate a migration with
  `drizzle-kit generate --name rsv_locale_no_default_en` only if needed; rename
  comment on `RSV_MESSAGE_LOCALE_VALUES` to point to `SITE_CONTENT_LOCALES` (or
  derive from it).

tenant-api (`apps/tenant-api/src`)

- `services/rsv-special-days.ts`: rewrite `pickI18n` over `pickLocalized` with
  the org default; remove the `map.en` fallback.
- `services/rsv-public-service.ts`, `rsv-public-engine.ts`,
  `rsv-experience-public.ts`, `rsv-public-booking-service.ts`: pass
  `ctx.organization.defaultLocale`; services/areas/occasions/terms/notes fall
  back to the default-language entry, then the canonical `name`.
- `routes/reservations-public.ts` `readLocale`: validate against org locales,
  else default. Booking, waitlist and notify payload `locale`: same resolution
  before it is stored.
- `services/rsv-setup-crud.ts` (L228, 1542, 1949 and related): default to
  `{ [orgDefault]: name }` instead of `{ en: ... }`; keep `name` =
  default-locale text; reject keys not in the org's enabled locales (or silently
  drop disabled languages, same rule as Menu).
- `services/rsv-policy-service.ts` `termsSchema`: replace
  `z.enum(RSV_MESSAGE_LOCALE_VALUES)` key with site-locale keys validated
  against the org.
- `services/rsv-experience-service.ts` and `rsv-setup-service.ts`: same
  validation.
- `services/rsv-message-settings-service.ts`: `MESSAGE_LOCALES` -> enabled org
  locales; validate `locale`; widen preview.
- `services/rsv-message-service.ts` L122, `rsv-message-queue.ts` (all
  `|| 'en'`): use `resolveGuestLocale`; note lookup falls back guest language,
  then org default.
- `lib/reservations-email.ts`, `lib/reservations-sms.ts`: replace the `en`/`ar`
  branches with a per-locale copy dictionary for all six languages (new files
  under `lib/reservations-copy/`), generalise `intlLocale`, RTL from
  `getSiteLocaleDirection`, greeting and units per locale.
- `services/rsv-waitlist-service.ts` L543 and `rsv-public-booking-service.ts`
  L379/597/647/944: default to org default instead of `'en'`.
- Seeds/fixtures (`routes/reservations-public-fixture.ts`,
  `services/rsv-message-fixture.ts`, any seed data): `{ [defaultLocale]: ... }`.

App (`apps/app/app`)

- `routes/_app+/$orgSlug_+/reservations+/_layout.tsx` (and `settings.tsx`
  loader): load `siteLocales`/`siteDefaultLocale`, return
  `parseSiteLocalesConfig(...)`; new hook
  `utils/reservations/use-reservation-locales.ts`.
- New `components/reservations/localized-fields.tsx`:
  `ReservationLocaleProvider` (LocaleContext + TranslateProvider, active starts
  at default), `LocalizedMapInput`, `LocalizedMapTextarea`, helper
  `mapWithDefault(map, defaultLocale)`.
- `routes/.../reservations+/settings.services.tsx`: remove `nameAr`; the name
  field becomes `LocalizedMapInput`; save `name` = default-locale value and
  `nameI18n` = map; list view shows the default (or, if shown, the currently
  selected) language only.
- `settings.tables.tsx`: area dialog likewise (remove `areaNameAr`, L271-329,
  776-781, 1184); table label stays plain.
- `settings.special-days.tsx`: replace `sdNoteEn/sdNoteAr` with a localized
  note; replacement-service name uses the same localized input (L356 sends
  `{ en }` today).
- `settings._index.tsx` L157-160, 682-736: replace the four "(Arabic)" inputs
  with two localized fields (public note, large-party note) and fix the
  draft-to-column mapping.
- `components/reservations/messages/message-settings.tsx` (L560-620),
  `utils/reservations/messages-api.ts`, `message-labels.ts`: one textarea per
  kind + switcher; remove `MESSAGE_LOCALES = ['en','ar']`; fix the card
  description ("in English and Arabic").
- `components/reservations/policies/policy-sheet.tsx`,
  `utils/reservations/policies-api.ts`, `policies-view.ts`: terms field becomes
  localized with the switcher in the sheet header; delete `POLICY_LOCALES` and
  `POLICY_LOCALE_LABELS`; policy name stays plain.
- `components/reservations/experiences/experience-editor.tsx`,
  `experience-create-sheet.tsx`, `utils/reservations/experiences-api.ts`,
  `experiences-view.ts` (`EXPERIENCE_LOCALES`, `EXPERIENCE_LOCALE_LABELS`,
  `clean(form.names, EXPERIENCE_LOCALES)`, `pickExperienceText` that falls back
  to `en`): name/description localized from site locales; display helpers use
  the org default; slug generation uses the default-language name only.
- `components/reservations/floor-plan-canvas.tsx` L303: default area
  `{ [defaultLocale]: 'Main Dining' }` (default name text itself is an
  operator-editable value, shown in the default language).
- `utils/reservations/setup-api.ts`: type `LocalizedCopy` stays
  `Record<string,string>`; remove the `.en`-keyed reads (L1192-1201).
- `utils/reservations/book-api.ts` L2264: `preferredLocale?: string`.
- Tags: add the same localized input where guest-selectable occasion and dietary
  tags are created or edited (if no editor exists today, only the seeded default
  names need translations in all six; do not build a new tag editor for this
  task).
- Lingui: run `npm run lingui:extract -w app`, fill `ar` msgstr for new/removed
  strings, `node scripts/check-lingui.mjs`.

Sites (`apps/sites/src`)

- No new mechanism. Confirm `reserve/index.astro`, `waitlist.astro`,
  `manage.astro`, `experiences/*` always pass `Astro.locals.requestedLocale` to
  `api.config/experiences/...` and as `guest.locale` (`lib/reservations/flow.ts`
  L469, 689, 817, 907, 967, 1177). Add tests that a non-default language is
  sent, and that the manage page uses the stored guest language.
- Chrome strings already live in `lib/reservations/labels.ts` and the six `.po`
  files; no change unless new strings are added.

Docs

- Replace this document into
  `docs/reservations-mission/library/reservations-i18n.md` (identical copy).
- `docs/reservations-mission/library/sites-patterns.md`, `app-ui-patterns.md`:
  add a short "Languages" section pointing to the shared components.
- New short ADR note under `docs/decisions/` if the team wants one (reservations
  languages follow Website settings).
- `docs/staffing.md` is not affected.

### 4.3 Test plan

- `packages/reservations`: unit tests for `localizedTextSchema` (accepts any of
  the six, rejects `xx`, trims, max length) and `resolveGuestLocale` (enabled,
  disabled, regional `ar-SA`, missing).
- tenant-api: tests that (a) public config returns the requested language, then
  org default, then canonical name; (b) an org whose default is `ar` with `en`
  also enabled and a map with only `ar` returns Arabic for an `en` request
  (proves no hard-coded `en`); (c) a language disabled in site settings is not
  accepted or served; (d) experience, service, area, special-day note,
  large-party note, public note, policy terms, occasion tag for
  `es`/`fr`/`de`/`zh`; (e) messages: guest language `es` gets Spanish template
  plus the `es` note; guest language not enabled gets the org default; (f)
  preview endpoint for each locale; (g) email/SMS dictionaries have the same
  keys for all six languages (compile-time via `Record<SiteContentLocale, ...>`
  plus a test that no template falls back to English text for another locale).
  Keep the existing `staffing-security`-style cross-organization tests green.
- App Vitest: component tests for `LocalizedMapInput` (one-language org shows no
  switcher and one input; two languages show the switcher and edit the active
  language; default stays required); update `experience-editor.test.tsx`,
  `policies-screen.test.tsx`, `message-settings.test.tsx`,
  `experiences-screen.test.tsx`; assert no "Arabic" label remains; loader test
  that the reservations layout returns the site locales.
- Sites Vitest: `reservations-labels.test.ts` (all six catalogs resolve every
  reservation label), `flow`/`manage` tests for locale pass-through.
- Browser pass (agent asks first on a developer machine): org with `en` + `ar` +
  `es`: edit a service and a policy in each language, book from `/ar/reserve`
  and `/es/reserve`, check the confirmation SMS/email language and the manage
  page.
- Checks: `npm run typecheck -w app`, `npm run lint -w app`,
  `npx oxlint <paths>`, `cd apps/app && npx vitest run <paths>`, tenant-api and
  reservations package tests, `node scripts/check-lingui.mjs`.

### 4.4 What we do NOT translate

- Table labels, section and section-layout names, floor elements, combos.
- Policy name, special-day internal name, block reason/note, service notes.
- Tags that are not guest-selectable (VIP, seating, regular, custom, system),
  and anything `sensitive`.
- Guest notes, allergy notes, reservation notes, guest request text (free text
  typed by people; echoed as typed).
- Staff names and positions (`first_name_ar`, `name_ar` in the staff module;
  separate module).
- Experience slug and URLs, ids, enum values and error codes on the wire (Sites
  translates via Lingui).
- Reports and host-board labels (operator UI, App Lingui `en`/`ar` catalogs).
- Message content at send time (no machine translation of notes at send time).

### 4.5 Open points to confirm while implementing

- Whether Reservations managers hold `UPDATE_WEBSITE_ANY` (needed by
  `/api/translate`); otherwise hide the Translate button instead of showing an
  error.
- Whether any tag editor exists in the App today (none found under
  `components/reservations/guests`); if none, only default tag names need
  all-language values.
- Whether the location-closed note shown to guests (`rsv-location-hours.ts`,
  untracked in the working tree) is stored as a localized map; if it is a single
  string it joins the translate list.
- Note: `git status` shows many uncommitted reservations edits in the files
  named above; rebase the change list against the current working tree, not
  against `HEAD`.
