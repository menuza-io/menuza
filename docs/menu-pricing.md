# Menu prices, dietary tags, translations and spreadsheet updates

This covers five menu features (#410, #335, #412, #388, #411). Menu data,
prices, rules and tags are business data and live in the control plane. The
region only receives resolved values in the order context, as before.

## One price resolver (#412, #388)

`resolveMenuItemPrice` and `resolveMenuOptionPrice` in
`@repo/common/menu-pricing` turn a dish or option into the price a guest pays.
Every channel uses them:

| Caller                        | Where                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| Region quote, placement, QR   | `priceRestaurantOrder` (`@repo/common/restaurant-orders`)                |
| Till review                   | `reviewAgainstMenu` (`apps/tenant-api/src/services/pos-service.ts`)      |
| Station                       | `buildCategories` (`apps/station/src/lib/catalog.ts`)                    |
| Sites menu, cart and checkout | `price-book.ts` (`apps/sites/src/lib/ordering/`)                         |
| Customer app                  | `presentMenu` (`apps/customer/lib/ordering/catalog.ts`)                  |
| Phone agent                   | `priceAgentMenus` (`@repo/phone-agent-restaurant`), called by App config |

Order of resolution for a dish:

1. A fixed per-location price override above zero wins: no order-type price and
   no rule.
2. Otherwise the price for the order type, else the base price. A chosen
   variation has its own price and ignores the dish's order-type prices.
3. Then the first pricing rule that covers the dish at this location, unless the
   price from step 2 is in the rule's excluded range.

Options take steps 1 and 2 only. Rules cover dishes, because one option is
shared by many dishes. Drops keep their own published prices (no order-type
price, no rule).

Order types: `dine_in`, `pickup`, `delivery` (`menuOrderTypeFor`). QR table
rounds and tabs are dine-in. Station takeaway and drive-through (#404) price as
pickup.

### Order-type prices (#412)

- Stored as `orderTypePrices` (JSON) on `OrganizationMenuItem` and
  `OrganizationMenuOption` (migration `0059_menu_rules`). Null or a missing key
  means the base price. Set on the dish and option pages; hidden for dishes with
  variations and for pizza toppings (their whole and half prices win).
- A modifier group's own price for an option (`priceOverride`) is fixed: the
  option's order-type prices do not apply in that group.
- The public menu payload carries `orderTypePrices` only when one is set.
- Sites: the menu page renders for one location, so the server builds a price
  book (`buildPriceBook`) of what differs per order type and the page applies it
  in place when the guest switches pickup, delivery or the table. The cart is
  repriced on every switch (`repriceCartForMode`), on the menu and at checkout.
  The region's figures still decide what is charged.
- Station keeps the menu priced as dine-in and as pickup and reprices the bill
  when the cashier switches the order type (`repriceLinesFor`).
- POS contract: unchanged (still 11). The till already sends its order type and
  the price it charged; the server reprices with `priceAs` only to flag
  differences. An older terminal that ignores order-type prices keeps selling
  and its sale is flagged `price_mismatch`, as for any stale menu.

### Pricing rules (#388)

- Table `OrganizationMenuPricingRule` (migration `0059_menu_rules`): name,
  `percentBp` (-9000 to 50000), menus, categories, locations (empty: all),
  rounding (`none`, `decimals` 0 or 1, `amount` in minor units, always up), an
  optional excluded price range, `startsAt` and `endedAt`.
- The App publishes live rules in the menu payload as `pricingRules`, with menus
  expanded to category ids and every category to its subcategories, so a dish
  added to a covered category later is covered. Order: category rules, then menu
  rules, then "every dish" rules, newest first. The first covering rule applies;
  rules never stack.
- Menu > Pricing rules: create with a preview (`previewPricingRule`), end a rule
  (prices return to base). Both are in the activity log and purge the site
  cache. A rule that starts or ends later shortens the menu cache.
- Hook for #204: a per-delivery-app markup plugs into the same resolver.

## Dietary tags (#335)

- `DIETARY_TAGS` in `@repo/common/menu-types`: halal, vegan, vegetarian, gluten
  free, dairy free, nut free, spicy. Stored as `dietaryTags` (JSON) on dishes
  and options; migration `0059` fills it from the old flags.
- `isVegetarian` and `isGlutenFree` are kept equal to the tags on every write
  (`dietaryColumns`), so readers that know only the flags keep working.
  `dietaryTagsOf` reads both and drops unknown values. Alcohol stays a flag.
- Bulk edit sets any tag or alcohol.
- Guests: badges and a filter on the Sites menu and in the customer app, with a
  disclaimer that tags are the restaurant's own description. Several choices
  combine as "has all"; a vegan dish counts as vegetarian. Station shows the
  badges. The phone agent's `search_menu` answers dietary questions ("what is
  halal?", Arabic too) from the tags.

## Translation status (#410)

`@repo/common/translation-status` lists, per website language, the dishes,
options, option groups and categories missing a name or a description (counted
separately; a description is missing only when the record has one in another
language). Menu > Translations shows it with filters and edit links. Saving the
website languages refuses removing a language that holds the only name of a
record (`namesLeftBlank`). Nothing is translated automatically.

## Spreadsheet updates (#411)

Menu > Spreadsheet (part of bulk edit: `menu.bulk_edit` flag and the
`MENU_BULK_EDIT_ENABLED` kill switch). The CSV template lists every dish:
`id, dish, category, price, dine_in_price, pickup_price, delivery_price, availability`.
Rules (`menu-spreadsheet.ts`):

- Blank cells change nothing. A dash in an order-type price removes it.
- Prices are read like typed amounts (`parseMoneyToMinor`): Arabic digits and
  marks work; an ambiguous comma is refused.
- Every row is checked first; any problem (unknown id, duplicate, bad price, bad
  availability, a price on a dish with variations) is listed with its row and
  nothing is applied. A file with other columns is refused as not the template.
- Apply re-checks the file, refuses if a dish changed since the preview, takes a
  menu snapshot (History can undo it), writes in one transaction, and logs the
  change. Exports go through the formula-safe `toCsv`.

## Deploy order

App, then tenant-api, then Station, Sites and the phone agent. Every new field
is optional, so older clients ignore it.
