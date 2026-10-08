# AI phone calling: plan

Status: US implementation in progress (`apps/voice-agent`, `@repo/phone-agent`,
App `/{orgSlug}/phone-agent/*`). KSA is planned for 2027. Research current as of
October 2026; re-check vendor and region availability before committing. Local
setup: see [Local development](#local-development).

## Goal

When a customer calls a business, an AI agent answers. It can:

- Answer common questions (hours, address, contact details, and the business's
  own FAQ).
- Capture callback requests, complaints, and voicemails for staff follow-up.
- Text the caller a link to the business's website.
- Hand the call to a person when the request is too complex, if the business
  allows it.
- Record the call if the business allows it, and log the call's purpose.

Businesses control the agent through settings, training rules, and (for advanced
users) a visual call-flow editor.

The core is business-neutral. Business types plug in their own vocabulary,
tools, call purposes, and data as a "vertical"; see
`docs/phone-agent-verticals.md`. A vertical can, for example, add tools that
answer questions from its own records or build something with the caller and
text them a link that carries it.

## Recommendation in one paragraph

Build on **LiveKit** (open-source server, SIP gateway, and Agents framework),
self-hosted on an OCI VM in each data region, next to tenant-api. Connect phone
numbers through a plain **SIP trunk**: Twilio Elastic SIP Trunking in the US
(reuses the Twilio account already used for SMS; Telnyx is a drop-in swap if
per-minute cost matters later) and a licensed in-kingdom carrier in KSA. Keep
speech-to-text, the language model, and text-to-speech as swappable plugins
chosen per region. Build the flow editor and training rules ourselves in App, on
the shared `@repo/flow-editor` canvas also used by `@repo/marketing-workflow`.
Ship the US first. KSA follows once in-kingdom speech and language model hosting
is confirmed.

## Why this choice

### The deciding constraint: KSA residency

`docs/tenant-data-residency.md` says KSA customer PII must not be **stored or
transited** outside Saudi Arabia. A phone call is full of PII: the caller's
number, their voice, their name, and often their address. That means the audio,
the transcript, every language model prompt, and the recording all have to stay
in the kingdom for KSA businesses.

That rules out every hosted voice platform for KSA:

| Option                                | Type                              | Can it keep KSA calls in KSA?                                                                               | Notes                                                                                                                                              |
| ------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vapi, Retell, Bland, Synthflow        | Hosted platform                   | No. Media, transcripts, and recordings run on their US (or EU) infrastructure.                              | Fastest to a demo. Their own flow builders would duplicate ours. Per-minute platform fee.                                                          |
| ElevenLabs Agents                     | Hosted platform                   | No. Residency options are US, EU, and India.                                                                | Best Arabic voices. Fine as a TTS plugin in the US.                                                                                                |
| LiveKit Cloud                         | Hosted infrastructure             | No. Agent hosting runs only in the US, EU, and India; the `me` media region spans Saudi Arabia and the UAE. | Used for the US worker (see `docs/voice-agent-deployment.md`). Same code and image as a self-hosted deployment.                                    |
| **LiveKit (self-hosted, Apache 2.0)** | Open-source server + SIP + Agents | **Yes.** Runs on our own OCI Riyadh VM.                                                                     | SIP, rooms, recording (Egress), call transfer, and agent workers in one stack.                                                                     |
| Pipecat                               | Open-source agent framework       | Yes, self-hosted.                                                                                           | Comparable. Needs a separate transport/SIP layer; LiveKit bundles it.                                                                              |
| Dograh                                | Open-source platform (on Pipecat) | Yes, self-hosted.                                                                                           | Has its own builder, auth, Postgres, Redis, MinIO. Embedding it means a second product UI and data store per region. Useful as a design reference. |

Self-hosting LiveKit also fits the product principles in `PRODUCT.md`: one
deployment shape in every region, every vendor swappable, and local development
without third-party signups (`livekit-server --dev` runs locally, and calls can
be tested from a browser instead of a phone).

### The hard part in KSA: speech and model inference

Hosting in Riyadh solves storage. It does not solve inference. As of late
September 2026
([INVISOM, 29 Sep 2026](https://www.invisom.com/insights/data-residency-sovereign-cloud-ai-saudi-uae/)):

- No hyperscaler offers a frontier language model processed inside Saudi Arabia.
  Vertex AI in Dammam offers embeddings only.
- Azure Saudi Arabia East (announced for November 2026) and the AWS Saudi region
  (announced for December 2026) have not confirmed which AI services they will
  launch with.
- Anthropic, Deepgram, Cartesia, and similar APIs process outside the kingdom.

So KSA has three realistic paths, and choosing one is a product and legal
decision, not an engineering one:

1. **Strict (matches the current residency doc):** self-host speech-to-text, an
   open-weight model (for example ALLaM, Falcon-H1-Arabic, or a Qwen-class
   model), and text-to-speech on GPUs in Riyadh, or use a Saudi voice vendor
   that contractually processes in the kingdom (candidates to evaluate: Nabrah,
   Voho, HUMAIN). Highest cost and effort; quality must be measured on Saudi
   dialect calls.
2. **Wait:** design for KSA now, launch KSA when an in-kingdom hosted model is
   available (re-check Azure and AWS Saudi regions in early 2027).
3. **Relaxed:** document a PDPL transfer basis (SDAIA standard contractual
   clauses plus a transfer risk assessment) and use global APIs. This
   contradicts the current residency doc and would need legal sign-off and a doc
   change.

Recommended: launch US first, build everything so the KSA node only needs a
different plugin config, and pursue path 1 or 2 for KSA.

### Telephony

| Region | Recommendation                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US     | Twilio Elastic SIP Trunking into LiveKit SIP. Reuses the existing Twilio account. Because it is plain SIP, swapping to Telnyx (cheaper per minute and per number) is a configuration change.                                                                           |
| KSA    | A CST-licensed in-kingdom carrier or CPaaS SIP trunk (STC/center3, Mobily, Zain Business, Unifonic, or similar). Must confirm that media terminates in the kingdom. International DID resellers (DIDWW and similar) usually route media abroad, so avoid them for KSA. |

Businesses rarely want a new public number. Support two modes per number:

- **Forwarding (default):** the business keeps its number and sets
  forward-on-busy or forward-on-no-answer (or always) to the AI number.
- **Dedicated number:** we provision a number and the business publishes it.

A vertical can define scopes (for example offices or branches); each number can
then answer for one scope.

### Speech and model defaults (US)

All behind LiveKit plugins, chosen per region by configuration:

- Speech-to-text: Deepgram Nova-3 (streaming, multilingual).
- Language model: a fast tool-calling model. Gemini Flash is the natural default
  because `@repo/ai` already uses `@ai-sdk/google`. Pick by time to first token,
  not by benchmark scores.
- Text-to-speech: Cartesia (low latency) or ElevenLabs (better Arabic and
  multilingual quality).
- Turn detection: LiveKit's turn detector plus Silero voice activity detection
  (both provisioned automatically by `@livekit/agents` 1.x).

Rough cost: about $0.05 to $0.12 per minute for speech, model, and telephony.
Business calls are typically 2 to 4 minutes, so roughly $0.10 to $0.50 per call
before infrastructure.

## Architecture

```
Caller ──PSTN──► SIP trunk (regional) ──► LiveKit SIP + server (regional OCI VM)
                                                │ dispatches one job per call
                                                ▼
                                      apps/voice-agent worker (same region)
                    ┌───────────────────────────┼──────────────────────────────┐
                    ▼                           ▼                              ▼
     App (US) internal endpoints     tenant-api (same region)        STT / LLM / TTS plugins
     - agent config, flow, rules     - write call logs, requests      (per-region config)
     - business profile, vertical    - send link SMS
       data (no PII)                 - recordings to regional storage
```

### New app: `apps/voice-agent`

- TypeScript, using the LiveKit Agents Node SDK, to match the monorepo and share
  Zod schemas. Fall back to the Python SDK only if a required plugin is missing
  in Node.
- Deployed per region with the same `DATA_REGION` model as tenant-api. On
  startup it refuses to run without a matching region config, like tenant-api.
  The US worker runs on LiveKit Cloud agent hosting; KSA will be self-hosted in
  Riyadh. See `docs/voice-agent-deployment.md`.
- It does **not** open tenant SQLite directly: each region has a single writer.
  All PII writes go through internal tenant-api routes, authenticated with a
  dedicated `VOICE_AGENT_TOKEN`. The worker never holds
  `INTERNAL_COMMAND_TOKEN`, which can provision and wipe tenant databases.
- It reads non-PII config from App, the same way tenant-api reads org flags from
  `APP_URL`.
- `apps/voice-agent/src/vertical.ts` picks the vertical the worker runs; the
  template ships `generalVertical` from `@repo/phone-agent`.

### Per-call lifecycle

1. The call arrives. A LiveKit SIP dispatch rule creates a room and starts an
   agent job with the dialed number.
2. The agent resolves dialed number → organization and scope (control plane
   mapping), checks `dataRegion === DATA_REGION`, and loads the published flow,
   training rules, settings, business profile, and the vertical's data. The
   config is cached per number for 5 minutes, and a stale copy is used for up to
   24 hours when App is unreachable. If the agent is turned off, App returns a
   passthrough answer and the call is transferred to the business's line.
3. Every call starts with a non-interruptible preamble: the automated-assistant
   disclosure, plus the recording notice when recording is on. Then it runs the
   published phone menu (see below). Menu steps are spoken with TTS and need no
   model.
4. If the caller picks the AI assistant, one general AI agent takes over for the
   rest of the call, using tools for business information, requests, the
   vertical's own tasks, and escalation. It ends the call or transfers by
   itself.
5. At hang-up, a post-call step (in region) writes the transcript, summary,
   purpose, and outcome to the regional tenant database, and the recording to
   regional storage if enabled.
6. Nothing about calls syncs to the US. The phone call metrics in Reports are
   computed by the regional tenant-api and fetched by the browser with an
   operator token, like the call log. **Not built yet:** a US-side sync of
   aggregate, non-PII counts (following the engagement-sync pattern). Add it
   only if a US dashboard needs call counts without calling tenant-api.

### Agent tools

Core tools, available to every vertical:

| Tool                            | Purpose                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get_business_info(topic)`      | Hours, special hours, address, and contact details from the business profile (or the vertical's details).          |
| `record_request(type, details)` | Callback, complaint, or a vertical's own request types, for staff follow-up.                                       |
| `set_call_purpose(primary)`     | Records purpose during the call; the post-call step confirms it.                                                   |
| `transfer_to_staff(reason)`     | Warm or cold transfer via SIP. Falls back to taking a message.                                                     |
| `transfer_to_contact(caseId)`   | Transfer to a named contact when one of the org's transfer cases applies (respects each case's hours and retries). |
| `switch_language(language)`     | Moves speech and the voice to another configured language.                                                         |
| `tag_call(tagId)`               | Applies one of the org's call tags, for follow-up and alerts.                                                      |
| `end_call(outcome)`             | Closes with a structured outcome.                                                                                  |

A vertical adds its own tools (`vertical.tools`); they are framework-free and
the worker adapts them to LiveKit. Write tools read back before acting. The
agent never takes card numbers by voice, which keeps the call out of PCI scope.

### Texting a link

The `text_link` phone menu step and vertical tools can text the caller a link.
The core sends the business's website link; a vertical can send a link that
carries data from the call through a **handoff**: the payload is stored in the
regional tenant database with a token, and the token goes in the URL fragment so
it never reaches Sites or Pages server logs. The Sites page reads the payload
back from the regional tenant-api in the browser, which keeps to the "browser
calls tenant-api directly" rule. Texts only go to the caller's own number or
another US number, at most two per call, with a daily cap per organization;
every attempt is recorded. On test calls the link is shown in the page instead.
Details: "Link handoff" in `docs/phone-agent-verticals.md`.

KSA SMS: Twilio is blocked for KSA in production, so KSA links need the
in-kingdom SMS provider that is already an open item, or WhatsApp through an
in-kingdom provider.

## What businesses configure

### Settings (App → `/{orgSlug}/phone-agent`)

- Enable or disable; numbers and forwarding mode.
- Languages (for example English and Arabic) and voice.
- Greeting and closing lines.
- Business hours, special hours, address, and phone, unless the vertical
  provides them from its own records.
- **Record calls** on or off, plus retention (for example 30, 90, or 365 days).
  When on, the agent plays a recording notice. Transcripts follow the same
  retention.
- **Auto-escalate complex requests** on or off, the escalation phone number, and
  the behavior when nobody answers (take a message). Built-in triggers: the
  caller asks for a person, repeated misunderstandings, and complaints.
  Escalation training rules add business-specific triggers.
- Maximum call length.

Avoid transfer loops: when the business forwards its own line to the AI number,
the escalation number must be a different line (enforced in validation). The
voice worker also refuses to dial any of the org's own agent numbers, and the
"pause the assistant" passthrough never dials the number a call was forwarded
from. If no safe business line is left, the call hears the "calling disabled"
phrase and ends instead of looping.

Phone numbers: only US and Canada numbers can be connected, transferred to, or
texted. Verifying a forwarded business line is limited to 10 codes per
organization per day (App and tenant-api both enforce it). A removed number
stops routing at once: runtime config only resolves numbers that are still
assigned to the org and not retired.

Recycled numbers are held for 30 days. Businesses forward their public line to
the agent number at their own carrier, and nothing tells the platform when they
undo it, so a number given to another business too soon would send the first
business's callers to the wrong agent. When an admin unassigns or retires a
number, `PlatformPhoneNumber` records `releasedAt`,
`releasedFromOrganizationId`, and whether a verified forwarded line was
connected (`releasedWithVerifiedForwarding`). For 30 days, **Admin → Phone
numbers** refuses to assign it to a different organization unless the admin
ticks **Reassign anyway** after a warning, which is stronger when the previous
business had verified forwarding. Giving it back to the same organization is
allowed at once. A number whose organization was deleted while holding it has no
release date, so it stays held until an admin confirms. A forced reassignment is
audit-logged as `admin_phone_number_force_reassigned` with the previous
organization id and the last four digits of the number.

### Training rules (App → `/{orgSlug}/phone-agent/training`)

Each rule has a **category**, **title**, **description**, **priority**, an
active toggle, and an optional scope.

Categories: Escalation, Error handling, and General, plus any the vertical adds
(`trainingRuleCategoriesFor`).

Priority: High, Medium, Low. When rules conflict, higher priority wins; within
the same priority, the more specific rule (scope-limited) wins.

How rules reach the model: at call start, active rules are compiled into ordered
prompt sections grouped by category, and the AI assistant receives all of them.
A token budget caps the total, and the UI warns when rules exceed it.

Example rules:

- Escalation (High): "Transfer billing disputes over $500 to the office
  manager."
- Error handling (High): "Never give medical, legal, or financial advice; offer
  to transfer to staff."
- General (Medium): "Mention that parking is free behind the building when
  someone asks for directions."

### Phone menu editor (App → `/{orgSlug}/phone-agent/flow`)

Every org starts from a working default menu (`defaultFlowFor(vertical)`), so
most businesses only change the wording or the options. The canvas is built on
the shared `@repo/flow-editor` package (also used by marketing workflows); the
graph model, validation, and runtime helpers live in `@repo/phone-agent`.

The flow is a **phone menu (IVR)**, for example "press 1 to talk to our AI
assistant, 2 to get a text with a link to our website, 3 to speak with our
team". The AI assistant is one of the options, not the whole call. Callers can
press a key or say the option (its label or one of its keywords).

Step types:

| Step             | What it does                                                                                  | Outputs                       |
| ---------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| Call comes in    | Entry point.                                                                                  | One                           |
| Keypad menu      | Reads a prompt, waits for a key or a spoken choice, repeats up to 3 times.                    | One per key, plus "No choice" |
| Play message     | Reads a message, then continues.                                                              | One                           |
| Open or closed   | Branches on the business's hours.                                                             | Open, Closed                  |
| AI assistant     | Hands the call to the general AI agent (Setup + Training rules). Ends or transfers by itself. | None                          |
| Text link        | Texts the website link to the caller (`POST /api/voice/website-links` on tenant-api).         | One                           |
| Transfer         | Transfers to the step's number or the Setup escalation number.                                | "No answer"                   |
| Take a voicemail | Records a message and saves it as a callback request.                                         | One                           |
| Hang up          | Optional goodbye, then ends the call.                                                         | None                          |

Messages can use `{business}`, plus any placeholders the vertical adds.
Validation blocks publishing for missing or duplicate connections, missing
prompts, duplicate keys, invalid phone numbers, loops with no caller input, and
unreachable steps.

Publishing creates an immutable version. Calls record the flow version they ran.
The **Test call** page calls the draft from the browser (WebRTC into a LiveKit
room) with an on-screen dial pad that sends DTMF. On test calls, transfers
behave as if nobody answered, and links are shown in the page instead of texted.

### Choosing a voice

On Setup, **Choose voice** opens Cartesia's voice library with search and
language and voice-type filters. Play reads the agent name and greeting in that
voice, so owners hear what callers will hear. The App proxies the audio
(`/{orgSlug}/phone-agent/voice-preview`) because its content security policy
only allows same-origin media. Greeting previews are billed speech requests:
each editor gets 60 an hour, then previews fall back to Cartesia's free sample
clip. Only people who can edit the phone agent can play previews. The saved
voice id is what the voice worker uses; **Use default** clears it so the worker
falls back to `CARTESIA_DEFAULT_VOICE_ID`.

### More settings pages

Each page saves only the fields it owns. The server merges the patch onto the
stored settings, validates the whole object again, and checks cross-field rules
(unique ids, transfer cases point to an existing contact, no contact number that
loops back to the agent). Every save, training rule change, and phone menu
publish is written to the audit log with key names only, never values, and shown
under **Advanced → Change history**.

| Page (App → `/{orgSlug}/phone-agent/…`) | What it holds                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge`                             | Common questions and answers by category (optionally per scope), with an AI "Draft answers" button (10 per hour) that fills answers from the business facts. Pronunciations and key terms for speech recognition.                                                                     |
| `transfers`                             | Transfer hours, press 0 for staff, offer a text when nobody answers, ring timeout, named contacts, and transfer cases ("when the caller asks about billing, transfer to Sam").                                                                                                        |
| `follow-up`                             | Staff alerts by SMS (US only) and email for chosen events, a call link in alerts, auto-resolve after N days, keep transferred calls open, and call tags (auto-applied or manual, important or not).                                                                                   |
| `phrases`                               | Per-language overrides for the fixed lines the phone system speaks (hold, nobody answered, rating question, goodbye, and so on). Empty fields use the default. The AI disclosure and recording notice are legal notices: they are shown read-only and any stored override is ignored. |
| `advanced`                              | Safety switches (pause the assistant and pass calls straight to the business; turn off transfers), the end-of-call rating question, the vertical's own settings section, a prompt preview, and change history.                                                                        |

## Call records and purposes

Stored in the **regional** tenant database (they contain caller numbers, voices,
names):

- Caller number, linked customer if the number matches a known customer.
- Scope, start and end time, duration, language, flow version.
- **Purpose:** `business_information`, `other`, or one the vertical adds
  (`callPurposesFor`).
- Outcome: `resolved`, `link_sent`, `escalated`, `message_taken`, `abandoned`,
  `failed`.
- Escalated flag and reason.
- Summary, transcript (with tool events), recording object key (if recording was
  on).
- Follow-up status (`open` or `resolved`), auto-resolve time, tags, the caller's
  1 to 5 rating, sentiment, transfer result (`none`, `answered`, `no_answer`, or
  `referred` when the call was handed to the business line by SIP REFER and its
  result is unknown) and contact, voicemail flag, whether the business was open
  (computed at call start from current hours), and whether a link was sent.

Calls that need attention (voicemail, a request, a missed transfer, a low
rating, negative sentiment, an important tag, or a failed call) open as
follow-ups. Staff mark them complete from the call sheet in App, or they resolve
themselves after the org's auto-resolve period unless an important tag is on the
call. Org settings that decide this travel with the finish request, because
tenant-api has no copy of the control-plane settings.

Open follow-ups also appear in the **Calls** tab of the Mailbox, beside form
submissions, with a **Call back** button. The tab lists only calls that still
need follow-up and uses the same `/operator/calls/*` endpoints and call token as
**Phone agent → Calls**, so completing a call in either place updates both. Its
badge counts open follow-ups for the whole team, not per person.

Phone call metrics (volume, outcomes, purposes, transfers, calls while open,
links sent, repeat callers, follow-up status) are in **Reports** under the
"Phone calls" subject.

Operators view call logs in App, but the App server must not proxy PII. Use the
same pattern as forms and mailbox: the App page's browser calls tenant-api
`/operator/calls/*` with an operator token signed by `TENANT_OPERATOR_TOKEN`.

**Not built yet:** recording playback. Recordings are written to regional
storage and the call sheet shows a "Recorded" badge with "Playback coming soon",
but tenant-api has no route that streams a recording or issues a signed URL for
one. The intended design is to stream from regional storage through tenant-api
with short-lived signed URLs, so the audio never passes through the US App.

Call data has its own permissions: read, update, and delete phone calls. Read
opens the Calls page and the "Phone calls" report subject (tenant-api rejects a
`phone_calls` report without it). Update lets someone complete, reopen, and tag
calls and requests; the token carries `canUpdate`. Delete lets someone delete a
call or erase every record of one caller; the token carries `canDelete`. Users
with only call access land on the Calls page instead of settings.

## Data model sketch

Control plane (`packages/database`, no PII):

- `PhoneAgent`: `organizationId` (unique), `settings` (JSON
  `PhoneAgentSettings`, including the vertical's own settings under `vertical`),
  `publishedFlowVersionId`.
- `PlatformPhoneNumber`: platform-owned inventory (`e164`, `label`,
  `assignedOrganizationId`, `assignedAt`, `retiredAt`) plus the release hold
  (`releasedAt`, `releasedFromOrganizationId`,
  `releasedWithVerifiedForwarding`).
- `PhoneAgentNumber`: `organizationId`, `scopeId?`, `platformNumberId`, `e164`,
  `mode` (`forwarding` | `dedicated`), `forwardedFrom`, and the line
  verification fields. `scopeId` is opaque to the core and has no foreign key.
- `PhoneAgentFlowVersion`: `organizationId`, `version`, `graph`, `status`
  (`draft` | `published` | `archived`), `publishedAt`, `createdById`.
- `PhoneAgentTrainingRule`: `organizationId`, `scopeId?`, `category`, `title`,
  `description`, `priority`, `isActive`, `sortOrder`.
- Permissions `read/update:phone_agent:any` and
  `read/update/delete:phone_call:any` (see `docs/permissions.md`).

Regional (`packages/tenant-db`, PII):

- `voice_calls`: fields listed above.
- `voice_order_handoffs`: link handoffs (`tokenHash`, `callId`, `scopeId`, the
  vertical's payload, `sentToPhone`, `smsSentAt`, `expiresAt`, `openedAt`). The
  table name predates verticals.
- `voice_call_requests`: `callId`, `type` (`callback`, `complaint`, or a
  vertical's own type), `details`, `status`.

Config lives in the control plane because it contains no customer data and App
can edit it directly. (Marketing journeys live in tenant-db because their runs
reference customers; call config does not.)

## Compliance checklist

- AI disclosure at the start of every call.
- Recording notice when recording is on. Several US states require all-party
  consent, so the notice is mandatory, not optional.
- Verbal consent before texting a link; the SMS is transactional.
- Retention: `/resources/jobs/voice-retention` (daily, see
  `docs/scheduled-jobs.md`) sends each org with a phone agent and a provisioned
  tenant database to its regional node, 10 orgs at a time. The node deletes
  expired recordings and transcripts, anonymizes old requests, and retries
  failed recording deletions from the `voice_recording_deletions` queue.
- Data subject deletion: an operator with delete permission opens a call and
  chooses **Erase caller's data**. The browser calls tenant-api
  `POST /operator/calls/erase` with the caller's phone, which deletes that
  caller's calls, requests, handoffs, text logs, and recordings in their region.
  App's GDPR flow can use the internal `POST /api/voice/erase`.
- Audit of deletions: tenant-api does the deleting, and App can't see it, so
  after a call is permanently deleted or a caller is erased the browser reports
  it to App at `POST /{orgSlug}/phone-agent/calls-audit`, which requires the
  delete phone call permission. App logs `phone_agent_call_deleted` with the
  call id, or `phone_agent_caller_erased` with only the last four digits of the
  phone and the counts tenant-api returned (calls, requests, text logs,
  recordings queued for deletion). The full phone never reaches App. The report
  is best effort: the data is already gone, so a failed write is logged in the
  browser and doesn't block the UI, and because the browser sends it, a client
  that skips it leaves no App entry.
- Recording keys are fixed to `voice-recordings/{orgId}/{callId}.ogg`;
  tenant-api ignores any other key the worker reports.
- No card numbers by voice.
- Region switch: calls and recordings are wiped with the old tenant database,
  same as other customer data.

## Phases

| Phase                       | Scope                                                                                                                                                                                  | Exit criteria                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 0. Spike (1 to 2 weeks)     | `apps/voice-agent` with local LiveKit, browser-call testing, business info tools on one seeded org, US plugins. Measure latency and answer accuracy.                                   | p50 response under about 1 second; correct answers on a 50-question FAQ script. |
| 1. Answering agent (US)     | Data model, settings page, training rules CRUD, default flow (no editor), number provisioning and forwarding, call logs and purposes, operator call log UI via tenant-api, disclosure. | A pilot business takes real calls.                                              |
| 2. Links and verticals      | Website link texts, link handoffs, and the `PhoneAgentVertical` contract so business types can add their own tools and data.                                                           | A vertical's tool texts the caller a link that opens with the call's data.      |
| 3. Escalation and recording | SIP transfer with fallback to messages, recordings, retention jobs, erasure (audited in App). Recording playback is not built yet.                                                     | Transfers and recordings work end to end; retention job verified.               |
| 4. Phone menu editor        | React Flow IVR editor, step inspector, versioned publish, browser test call with dial pad, evaluation scripts.                                                                         | An operator changes the flow, tests it, and publishes without engineering help. |
| 5. KSA                      | Riyadh LiveKit and agent deployment, in-kingdom SIP trunk, in-kingdom STT, LLM, and TTS, in-kingdom SMS or WhatsApp, Saudi dialect evaluation.                                         | KSA calls verified to never leave the kingdom.                                  |
| Later                       | Outbound calls (appointment reminders, callbacks), integrations with business systems, usage-based billing.                                                                            |                                                                                 |

Build a regression suite from the start: scripted conversations replayed against
the agent on every change to prompts, rules compilation, or plugins.

## Open decisions

1. **KSA inference path:** strict self-hosted or in-kingdom vendor, wait for
   Saudi hyperscaler regions, or a documented transfer basis (requires changing
   the residency doc).
2. **KSA carrier:** which licensed SIP trunk, with media terminating in the
   kingdom.
3. **Billing:** included in a plan, or metered per minute through
   `@repo/payments`.
4. **US voice carrier:** Twilio (one vendor, proposed) or Telnyx (lower cost).

## Local development

The voice worker is not part of `npm run dev`. Start it separately.

1. Run a LiveKit server: `brew install livekit`, then `livekit-server --dev`
   (`ws://localhost:7880`, key `devkey`, secret `secret`). LiveKit Cloud also
   works for US development.
2. App (`apps/app/.env`): set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
   `LIVEKIT_API_SECRET`. The App signs browser test-call tokens and dispatches
   the `phone-agent` worker. Set `CARTESIA_API_KEY` too if you want the voice
   picker on the Setup page; without it, Setup shows a plain voice ID field.
3. Voice agent (`apps/voice-agent/.env`): set the same LiveKit values, plus
   `DEEPGRAM_API_KEY`, `GOOGLE_API_KEY`, and `CARTESIA_API_KEY`
   (`CARTESIA_DEFAULT_VOICE_ID` optional). `APP_URL` and `TENANT_API_URL`
   default to the local App and US tenant-api.
4. `VOICE_AGENT_TOKEN` (at least 32 characters) must match across App, the US
   tenant-api, and the voice agent. The worker uses it for
   `/resources/phone-agent-config` and tenant-api `/api/voice/*`. With
   `NODE_ENV=production`, App rejects the committed development default.
5. Once: `npm run download-files -w voice-agent` (turn-detector and VAD
   weights). Then `npm run dev` and `npm run dev:voice-agent`.
6. Open `/{orgSlug}/phone-agent/test` in the App to talk to the agent in the
   browser. Links appear in the page instead of being sent by SMS.

Real phone numbers (US):

1. Twilio: buy a number and create an Elastic SIP trunk whose origination URI is
   the LiveKit SIP endpoint (`sip:<livekit-sip-host>`).
2. LiveKit: create an inbound trunk for that number and a dispatch rule that
   puts each caller in its own room with agent `phone-agent`.
3. A platform admin adds the number in Admin and assigns it to the organization.
   The operator picks its mode (and scope, when the vertical has scopes) on the
   Setup page; a forwarded business line must be verified with a code first.
   Link SMS uses the tenant-api `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
   `TWILIO_FROM_NUMBER`.
4. Recording (optional): set `RECORDING_S3_*` on the voice agent. LiveKit Egress
   must be running and able to reach the bucket (LiveKit Cloud runs it for you).

Production deployment, secrets, CI, and the KSA path:
`docs/voice-agent-deployment.md`.
