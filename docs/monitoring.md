# Product analytics and monitoring

PostHog is the analytics and error-monitoring backend for the main application
(`apps/app`) and marketing website (`apps/web`). It is intentionally not loaded
by Admin, Sites, tenant-api, CMS, mobile, or the shared packages.

The integration is optional. If the project token is empty, no PostHog browser
or exception client is created. Worker log export is controlled independently by
the Cloudflare destination setting described below.

## What is collected

| Surface   | Browser analytics                                                                            | Error tracking                                        | Logs                                                                                           |
| --------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| App       | Page views, page leaves, authenticated user and organization context after analytics consent | Browser exceptions and React Router server exceptions | Browser SDK structured logs; Worker logs through Cloudflare's native OpenTelemetry destination |
| Marketing | Cookieless page views, page leaves, and Web Vitals                                           | Browser exceptions                                    | Browser SDK structured logs; Worker logs through Cloudflare's native OpenTelemetry destination |

The App SDK starts opted out. `PostHogAnalytics` only opts in after the existing
analytics consent cookie is explicitly accepted, then identifies the signed-in
operator and assigns the organization group. It resets identity after logout. Do
not attach email, name, phone number, request bodies, query-string secrets, or
tenant customer PII to events and logs.

Marketing uses PostHog's cookieless mode and
`person_profiles: 'identified_only'`. Its loader runs in a Partytown web worker
so analytics does not compete with the critical rendering path. App analytics
remains on the main thread because its React provider, consent lifecycle,
automatic exception capture, and tracing headers need direct access to the
application runtime.

## PostHog project setup

Use separate PostHog projects for production and staging when possible. Copy
each project's public project token and ingestion host from PostHog project
settings. The public token is designed to be shipped to browsers; a personal API
key is not.

Runtime/build variables:

```text
POSTHOG_PROJECT_TOKEN=phc_...        # App runtime and Web Worker runtime
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_PERSONAL_API_KEY=phx_...     # build secret; source-map upload only
POSTHOG_PROJECT_ID=12345             # build variable; source-map upload only
COMMIT_SHA=<deployed git sha>
```

For App/Admin and log destination patching in staging, the patcher first checks
`POSTHOG_PROJECT_TOKEN_STAGING`, `POSTHOG_HOST_STAGING`, and
`POSTHOG_LOGS_DESTINATION_STAGING`.

Set the marketing runtime values in each Web Worker's **Settings → Variables and
Secrets**: `PUBLIC_POSTHOG_PROJECT_TOKEN`, `PUBLIC_POSTHOG_HOST`, and optionally
`PUBLIC_POSTHOG_RELEASE`. The shared names `POSTHOG_PROJECT_TOKEN`,
`POSTHOG_HOST`, and `COMMIT_SHA` also work. Cloudflare Build variables only
affect the build and do not supply Worker runtime bindings.

Add the public token as a Cloudflare Worker secret for App:

```bash
cd apps/app
npx wrangler secret put POSTHOG_PROJECT_TOKEN
npx wrangler secret put POSTHOG_PROJECT_TOKEN --env staging
```

Configure the corresponding `POSTHOG_*` variables/secrets in Cloudflare Workers
Builds for `apps/web` and in the CI environment that runs either app build. The
deploy patcher writes Web's public runtime bindings into the generated Wrangler
configuration.

## Cloudflare Worker logs

Cloudflare can export Worker invocation logs to PostHog directly over OTLP, so
the application does not need a second server logging SDK. In the Cloudflare
dashboard, create a Workers Observability destination for PostHog and note its
destination name. Set:

```text
POSTHOG_LOGS_DESTINATION=posthog-logs
POSTHOG_LOGS_DESTINATION_STAGING=posthog-logs-staging
```

The deploy patcher only adds `observability.logs.destinations` when one of these
variables (or the equivalent `launch.config.json` field) exists. Deployments
therefore remain valid before a destination is created. Keep the existing Pino
redaction rules: Cloudflare exports the resulting Worker logs as-is.

See Cloudflare's
[PostHog OpenTelemetry destination guide](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/posthog/)
and PostHog's
[JavaScript logs guide](https://posthog.com/docs/logs/installation/javascript).

## Error tracking and source maps

Both browser integrations enable `capture_exceptions`. The App also captures
unhandled React Router server errors with `posthog-node`; request URLs are
sanitized before being attached. The marketing site records Web Vitals through
the browser SDK.

Production source maps are uploaded only when both `POSTHOG_PERSONAL_API_KEY`
and `POSTHOG_PROJECT_ID` are available. The Rollup plugin deletes the uploaded
client maps afterward. Missing credentials disable the upload rather than
breaking local or preview builds.

The personal key needs the source-map upload permissions described in
[PostHog's Vite/Rollup source-map guide](https://posthog.com/docs/error-tracking/upload-source-maps/vite).

## Verification

After deploying:

1. Visit the marketing site and confirm `$pageview` plus Web Vitals in PostHog.
2. Reject App analytics consent and confirm no browser analytics events are
   emitted; accept it and confirm page views and the `organization` group
   appear.
3. Throw a controlled browser and route error in staging and verify readable,
   source-mapped stack traces.
4. Trigger a staging Worker request and verify its structured request log in
   PostHog Logs.

PostHog references:
[React Router](https://posthog.com/docs/libraries/react-router/react-router-v7-framework-mode),
[Astro](https://posthog.com/docs/libraries/astro), and
[error tracking](https://posthog.com/docs/error-tracking/installation).
