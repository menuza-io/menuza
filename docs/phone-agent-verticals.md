# Phone agent verticals

The AI phone agent is split into a generic core and one package per business
type ("vertical"):

| Package                        | What it holds                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@repo/phone-agent`            | The engine: settings, phone menu (IVR) flow, phrases, prompt builder, training rules, FAQ, transfers, call reports, speech terms, availability, and the `PhoneAgentVertical` contract. |
| `@repo/phone-agent-restaurant` | The restaurant vertical: menus, the order cart, order-link handoff, store hours and delivery details, restaurant wording, and the restaurant call labels.                              |

The core has no business-type vocabulary. A test
(`packages/phone-agent/src/vocabulary.test.ts`) fails if words such as
"restaurant", "order", "store", or "location" appear in core sources. The keypad
"phone menu" is the one exception.

## Concepts

**Business profile.** `config.business` (`BusinessProfile`) has the name, phone,
timezone, address, weekly hours, and special hours. The core prompt,
availability, and `describeBusiness` use it. A business without a vertical fills
it from `settings.business` with `businessProfileFromSettings`.

**Scope.** `config.scopeId` is an opaque id for the part of the business the
call is for: a restaurant location, a clinic office, a branch. FAQ answers and
training rules can be limited to one scope (`scopeId` on each entry). The core
never interprets the id; the vertical names it (`vertical.scope.label`, for
example "Location").

**Vertical data.** `config.vertical` is `{ id, data }`. `data` is whatever the
vertical needs at call time (the restaurant puts the location, its menus, and
whether online ordering is open there). App builds it; the voice worker hands it
back to the vertical through `createVerticalContext`, which runs
`vertical.data.parse`.

**Vertical settings.** `settings.vertical` is a free-form record the vertical
validates with `vertical.settings.schema` (`verticalSettingsOf`). Values that
don't parse fall back to the vertical's defaults, so switching verticals never
breaks saved settings.

**Definitions.** Call purposes, request types, training rule categories, and FAQ
categories are string slugs (`DEFINITION_ID_PATTERN`, lower snake case, up to 40
characters). The core has a small base list for each; a vertical adds its own.
`callPurposesFor(vertical)` and the other `*For` helpers merge them: the
vertical's entries come first in the order it lists them, then any base entries
it didn't list. Labels come from the same lists, so the UI should use these
helpers instead of hard-coded label maps.

| Kind                   | Base ids                        | Restaurant adds                                                                |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Call purpose           | `business_information`, `other` | `reservation`, `ordering`, `menu_information`                                  |
| Request type           | `callback`, `complaint`         | `reservation`, `catering`                                                      |
| Training rule category | `escalation`, `error_handling`  | `menu_sizing`, `upsells_addons`, `order_flow`, `delivery`, `special_occasions` |
| FAQ category           | `general`, `policies`, `custom` | `location`, `menu`, `ordering`, `reservations`                                 |

**Link handoff.** The core can text the caller a link that carries data from the
call. A vertical tool calls `services.sendLink({ path, payload, phone })`; the
worker stores the payload with a token, texts the site URL for `path` with the
token in the fragment (restaurant links have used `#order=<token>`), or shows it
on screen on test calls, and returns `SendLinkResult`. The link expires after
`LINK_HANDOFF_TTL_HOURS`. The site page at `path` reads the payload back with
the token. The restaurant sends its cart to `/menu?location=<id>`;
`vertical.links.handoffPayload` validates the payload before it is stored.
Without a vertical tool the core can still text the plain website link
(`websitePathFor`, `linkMessageFor(vertical, 'website', ...)`), which the
`text_link` flow node uses.

**Placeholders.** Messages use `{business}`; `messageVariablesFor` adds the
vertical's own (the restaurant adds `{location}`, and `{restaurant}` for
messages saved before verticals existed). Unknown placeholders are left as is.

## The `PhoneAgentVertical` contract

Everything is optional except `id` and `label`. The `generalVertical` export is
the minimal vertical: it only adds a `general` training rule category.

| Field                                                                         | Used for                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `label`, `scope`                                                        | Identity, and what the UI calls a scope.                                                                                                                                                           |
| `callPurposes`, `callRequestTypes`, `trainingRuleCategories`, `faqCategories` | Extra definitions (see above).                                                                                                                                                                     |
| `faqQuestions`                                                                | The suggested-questions bank, merged with `BASE_FAQ_BANK` by id.                                                                                                                                   |
| `phraseDefaults`                                                              | Reworded defaults for editable phrases (`phraseDefinitionsFor`, `resolvePhrase`). Required notices can't be changed.                                                                               |
| `notificationHeadlines`, `outcomeSummaries`                                   | Wording for staff alerts and call outcomes.                                                                                                                                                        |
| `settings`, `defaultSettings`                                                 | Schema and defaults for `settings.vertical`; overrides for core defaults such as call tags.                                                                                                        |
| `data`                                                                        | Parser for `config.vertical.data`.                                                                                                                                                                 |
| `defaultFlow`                                                                 | The phone menu new organizations start with (`defaultFlowFor`).                                                                                                                                    |
| `links`                                                                       | Website path per scope, SMS wording, and the handoff payload schema.                                                                                                                               |
| `scopeName`, `businessDetails`, `messageVariables`, `keyterms`                | Prompt and speech inputs computed from the call context.                                                                                                                                           |
| `prompt`                                                                      | `VerticalPromptContributions`: payment note, extra style rules, status line, details heading, tasks, business-question guidance, extra sections, after-hours line, rules title, and a rule filter. |
| `tools`, `createCallState`                                                    | Tools for the AI assistant and the per-call state they share.                                                                                                                                      |
| `currentAvailability`                                                         | Open/closed state at call time, plus refreshed data (`withCurrentAvailability`).                                                                                                                   |
| `classifyPurpose`, `inferPurpose`, `summarizeCall`                            | Labeling the finished call (`classifyCallPurpose`) and summary lines.                                                                                                                              |

Tools are framework-free (`VerticalTool`): a name, a description, a zod
`parameters` object, and `execute(args, context)` returning JSON for the model.
The worker adapts them to LiveKit, records the tool name in the call's used
tools, and honors `rejectDuplicates` and `blockedDuringTransfer`.

## How a call uses the vertical

1. App builds the runtime config. For a restaurant it spreads
   `restaurantConfigParts({ businessName, location, menus })` into the config,
   which sets `scopeId`, `business`, `availability`, and
   `vertical: { id: 'restaurant', data }`.
2. The worker picks the vertical by `config.vertical.id`, recomputes
   availability with `withCurrentAvailability(config, vertical)`, and creates
   the context with `createVerticalContext(vertical, config, { language })`.
3. The prompt comes from
   `buildAgentInstructions(promptContextFor(vertical, context, call))`.
4. The worker's own tools (`get_business_info`, `record_request`,
   `set_call_purpose`, transfers, tags, `end_call`) are added to
   `vertical.tools(context)`. `record_request` and `set_call_purpose` accept the
   ids from `callRequestTypeIds(vertical)` and `callPurposeIds(vertical)`.
5. Speech recognition terms are
   `buildKeyterms({ settings, businessName, extraTerms: verticalKeyterms(vertical, context) })`.
6. When the call ends, `classifyCallPurpose(vertical, signals)` labels it and
   `vertical.summarizeCall` adds summary lines.

## Adding a vertical

1. Create `packages/phone-agent-<name>` depending on `@repo/phone-agent`.
2. Export a `PhoneAgentVertical` with your definitions, wording, and tools. Keep
   ids stable once saved: they are stored on calls, rules, and FAQ entries.
3. In App, build `config.vertical.data` for your vertical and register the
   vertical where the worker and App pick one by id.
4. Keep business-type words in your package; the core vocabulary test rejects
   them.
