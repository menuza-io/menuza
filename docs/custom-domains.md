# Custom domains

Apex and www, provider-aware setup, nameserver connect, buying a domain, email
forwarding, and sending guest email from the restaurant's own name and domain.
One change for #139, #313, #283, #183, #276 and #103. Everything here is
control-plane business data (the restaurant's own domains, DNS records and
sender identity). No guest data is stored, and guest PII never moves: guest mail
still leaves from the regional node, and forwarded mail is never stored or read.

Read `docs/website-publishing.md` and `docs/website-seo.md` first: this change
reuses their publish, redirect and cache-purge code and adds no second sitemap,
redirect, notification or audit system.

## Step zero: what already existed

| Issue | What the product already had                                                                                                                                                                                                                                                                          | What was missing                                                                                | Decision                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #139  | `Organization.customDomain/Status/cloudflareHostnameId`; `cloudflare-custom-hostnames.server.ts`; the domain block in `site-card.tsx` with three intents in `website+/_index.tsx`; about a dozen exact-match public lookups; Sites `resolve-host.ts` and middleware; `logWebsiteActivity`; `kv-cache` | A host model, apex and www, secondary 301, a checklist, a pre-connect lookup, the sweep, expiry | ONE `SiteDomain` table; `Organization.customDomain` stays the denormalized primary; one `siteHostCondition` replaces every exact match; the domain UI moves to ONE new tab |
| #313  | Nothing                                                                                                                                                                                                                                                                                               | Provider detection, provider steps, automatic setup, "send these steps"                         | A provider table in `@repo/common`, steps as data, a Domain Connect adapter with an emulator, one email template                                                           |
| #283  | Nothing                                                                                                                                                                                                                                                                                               | A zone, a scan, the email guard, nameserver steps, a records list, export, a change log         | ONE `ManagedDomain` zone model (+ `DomainRecord`); the change log is the existing `AuditLog` (Website, Activity)                                                           |
| #183  | The Stripe platform account (print shop), `Notification`, the encryption helper                                                                                                                                                                                                                       | A registrar, search, price, buy, job, refund, renewals, reminders, transfers                    | The same `ManagedDomain` (registration columns) + `DomainJob` + `DomainCharge`; flag `domains.registrar`                                                                   |
| #276  | Nothing                                                                                                                                                                                                                                                                                               | Routing rules, destination confirmation, the MX guard, SPF merging                              | `DomainEmailForward` rows on the same zone; a routing adapter with an emulator                                                                                             |
| #103  | `sendTenantEmail` (tenant-api) with the platform sender only; `/resources/tenant-organization` metadata                                                                                                                                                                                               | Per-organization name, reply-to and domain, verification, records, fallback                     | `OrganizationEmailSender` (control plane); the region reads it through the metadata it already fetches; the node registers domains at its own provider                     |

## One domain screen

Website, Domain (`website+/domain.tsx`) is the only place. Cards: Your domains
(each host with its checklist), Connect (look up, then records yourself,
automatic, or let Menuza manage), Get a domain, one card per managed domain
(nameservers, DNS records, registration, email forwarding). The old domain block
in Website, General settings is a link to it. Settings, Email sending is the one
place for #103.

## Hosts (#139)

- `SiteDomain`: one row per host, unique across organizations. `isPrimary` (one
  per organization, a partial unique index), `method` (`cname`, `nameservers`,
  `registered`), `status` (`pending`, `active`, `moved`, `blocked`, `error`,
  `expired`), Cloudflare's certificate and ownership status shown separately,
  the verification records and the last per-record DNS result.
- Connecting `example.com` sets up both `example.com` and `www.example.com`; the
  chosen form is primary and the other redirects. Another subdomain is one host.
  Extra domains (an old domain) each redirect to the primary.
- Names are normalized (lower case, no scheme, port, path or trailing dot,
  punycode); the platform's own hosts are refused (`hostname_reserved`); a host
  another organization has is refused before anything is created
  (`hostname_taken`), and `Inspect` reports it earlier still.
- Lookups: `siteHostCondition` (`utils/sites/site-host.server.ts`) matches the
  primary (`Organization.customDomain`, kept for one release) **or** any active
  or pending `SiteDomain`. A secondary host answers with the organization and
  Sites (`apps/sites/src/lib/secondary-host.ts`, middleware) 301s it to the
  primary, keeping path and query, once the primary is active.
- Status: Check now per host, Check certificate again, and
  `POST /resources/jobs/domain-status` every 15 minutes (jobs-cron). A host that
  comes up becomes active and its operator gets an in-app notice and an email,
  once. Pending for 7 days: one reminder email with the missing records. After
  30 days: the Cloudflare hostname is released, the host is `expired`, the name
  is free and the operator can retry.
- Changing the primary swaps the flags in one `db.batch`; the old primary keeps
  redirecting; the cache is purged for every host.
- Migration `0065_custom_domains` copies every connected domain into a primary
  `SiteDomain`; public lookups read both, so nothing breaks before or after.

## Provider setup (#313)

- `inspectDomain` reads public DNS and RDAP only, for a name the operator typed
  (40 lookups an hour per organization): nameservers and registrar, MX, SPF,
  DMARC and common DKIM selectors, an existing website (and which builder), a
  subdomain typo, a host another site has, a leftover `_acme-challenge` record,
  another live domain of the same restaurant. Warnings never block.
- `packages/common/src/domain-providers.ts` is the table (about 20 providers:
  nameserver patterns, registrar names, where the DNS page is, field names, root
  marker, whether ALIAS works at the root). `domain-steps.ts` turns it into
  steps; the App translates the sentences around the provider's own labels.
- Connect automatically: Domain Connect (`domain-connect.server.ts`, templates
  in `docs/domain-connect/`). The plan is rebuilt on the server at approval,
  only routing records, and `changeTouchesMail` refuses a plan that would touch
  mail. Off until `DOMAIN_CONNECT_PROVIDER_ID` is set and the templates are
  published.
- Send these steps to someone else: one email, a validated single address, 5 an
  hour per organization, naming who asked.

## Nameserver connect and the zone (#283)

- `ManagedDomain` is the one zone model: `source` is `nameservers`, `registered`
  or `transferred`; the zone is at the DNS provider (`zoneId`); `DomainRecord`
  holds the records, with `managedBy` for the ones Menuza writes (site, email
  forwarding, email sending, registrar), which are read-only.
- The scan reads website, MX, SPF, DKIM, DMARC and the usual service names. A
  DNS scan cannot list a zone, so only an uploaded zone file that contains every
  mail record the scan found makes the move "Website safe, email safe".
  Otherwise the status is "Email may need attention" and the server refuses to
  go on until the domain is typed back (`email_confirmation_required`). The
  safety verdict is computed again on the server at the move.
- Existing records are copied into the new zone (mail untouched); the website
  records of the hosts being connected become the site's own records. The site
  stays on the old setup until the registrar answers with our nameservers
  (checked every 15 minutes; "changed at the wrong place" is detected).
- Subdomains cannot use this path. Leaving exports the zone file and switches
  the hosts back to the CNAME method.
- Records: one SPF per name, MX needs a priority, no duplicates, no CNAME beside
  other records (the flattened site CNAME at the root is the one exception),
  records Menuza manages cannot be changed. Every change is an `AuditLog` entry.

## Buying (#183)

- Flag `domains.registrar` (default off); needs `update:settings:any` and a card
  on file. `.com` to start (`DOMAIN_SUPPORTED_TLDS`), price = registrar cost +
  `DOMAIN_PRICE_MARKUP_PERCENT` (default 20).
- Search shows availability, yearly price and suggestions from the restaurant's
  name and city. Buy re-checks availability and the price right before charging
  (`domain_unavailable`: no charge; `price_changed`), then charges the card on
  file off session and queues the registration.
- The job (`DomainJob`) creates the zone, registers (contact encrypted with
  `INTEGRATION_ENCRYPTION_KEY`, privacy on, auto-renew on), attaches the site
  (primary when there is none), writes the site records and checks the hosts.
  Every step is safe to run again; a registry refusal refunds (`DomainCharge`);
  a provider outage retries five times, then refunds.
- Auto-renew: reminders 30 and 7 days before; the renewal is charged 3 days
  before expiry; a declined card is retried daily for 7 days, then urgent emails
  daily. Off: no charge, no renewal, the domain expires. Cancelling the Menuza
  subscription changes none of this.
- Transfer out: unlock and show the authorization code (not within 60 days of
  registering). Transfer in: charged like a year, refunded when the registrar
  refuses (locked, wrong code, too new). A transferred domain keeps its DNS host
  until the operator lets Menuza manage it. The registrant email banner shows
  until the registry confirms (or the operator says so, when the registrar
  cannot report it).

## Email forwarding (#276)

- Only where Menuza hosts the DNS (a zone whose nameservers are ours, or a
  domain we registered), otherwise the screen says why. An existing MX makes
  turning it on need the domain typed back; the old MX records are removed then.
  One SPF record: our sender is merged into the existing one. At most 10
  addresses (and a catch-all) per domain; each destination confirms through the
  mail provider's link first. Status: waiting for confirmation, active, failing,
  and the last time mail was forwarded when the provider reports it. No mailbox,
  no sending, no stored messages.

## Sending as the restaurant (#103)

- Settings, Email sending: sender name (up to 64 characters; no `@ < > " , ;` or
  line breaks, `invalid_sender_name`), a reply-to verified by a code mailed to
  it (15 minutes, 5 tries; the old reply-to stays until the new one is proven),
  and, behind `messaging.custom_sender`, a custom sending domain.
- The domain is registered at the region's email provider by the tenant-api node
  of the organization's data region (`POST /api/email-domains/*`, internal
  token), because OCI credentials live on the node. The App shows SPF, DKIM and
  return-path records (written for the operator when Menuza already manages the
  domain's DNS), Pending, Verified or Failed, and Re-check. One domain per
  organization (`domain_in_use`). A region change registers the domain again in
  the new region and shows Pending.
- The region reads the organization's identity from
  `/resources/tenant-organization` (cached a minute): `sendTenantEmail` sends
  with the organization's name and verified reply-to on the platform address,
  and from `<local part>@<their domain>` only while the domain is verified. A
  lookup that fails never fails a send. If DNS is later removed the 15-minute
  sweep marks it Failed, sending falls back, and the operator is told once.
- Header injection: the name is validated on save and cleaned again at send
  time.

## Adapters, emulators and what a live partner needs

Each partner is behind a small adapter; `DOMAINS_MOCK=true` (or `MOCKS=true`, on
a local `BASE_URL` only) runs every one in memory, and the unit tests inject
them.

| Adapter                   | Live implementation                                  | Env                                                                  |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| DNS zones                 | Cloudflare zones and DNS records (our account)       | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DOMAINS_API_TOKEN`              |
| Email routing             | Cloudflare Email Routing                             | the same two                                                         |
| Registrar                 | Name.com Core API v4 (`adapters.namecom.server.ts`)  | `NAMECOM_USERNAME`, `NAMECOM_API_TOKEN`, `NAMECOM_API_URL` (sandbox) |
| Domain Connect            | Discovery and apply URL (`domain-connect.server.ts`) | `DOMAIN_CONNECT_PROVIDER_ID`                                         |
| Sending domains           | OCI Email Delivery control plane (`email-domain.ts`) | the node's existing `OCI_*` settings                                 |
| Charges and refunds       | Stripe platform account, off session                 | the existing Stripe keys                                             |
| Root of a customer domain | ALIAS, or A/AAAA records                             | `SITES_APEX_IPV4`, `SITES_APEX_IPV6`                                 |

The live implementations were written against the partners' documented APIs and
are covered by the same unit tests through the adapter interface; the request
shapes of the Name.com, Cloudflare Email Routing and OCI control-plane calls
were not exercised against live accounts in this change. Turn each on in staging
with its own credentials before production.

## Deploy order

1. App: migration `0065` (copies existing domains), the screens,
   `POST /resources/jobs/domain-status`, the tenant-organization metadata.
2. Sites (apex/www redirects; reads `customDomainActive`).
3. jobs-cron (the `*/15 * * * *` trigger; it uses the fifth and last cron slot).
4. tenant-api (sender settings and `/api/email-domains/*`; every new field is
   optional, so an older node simply keeps the platform sender).
5. Flags `domains.registrar` and `messaging.custom_sender` stay off until the
   partners above are configured.

## Tests

`packages/common/src/domain*.test.ts`, `email-sender.test.ts`;
`packages/database/src/migration-0065-custom-domains.test.ts`;
`apps/app/app/utils/domains/*.test.ts` (hosts, inspect, auto-connect, zone,
registrar, forwarding), `utils/email-sender/sender.server.test.ts`,
`routes/.../website+/domain.test.ts` (every intent behind
`update:settings:any`), `jobs.domain-status.test.ts`;
`apps/sites/src/lib/secondary-host.test.ts`;
`apps/tenant-api/src/lib/tenant-email-sender.test.ts` and
`routes/email-domains.test.ts`; `apps/jobs-cron/src/index.test.ts`.
