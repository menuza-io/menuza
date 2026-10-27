# Features

Here are a few things you get today:

- [Remix](https://remix.run/) is the Web Framework of choice
- [Cloudflare Workers deployment](https://workers.cloudflare.com/)
- Multi-region, distributed, production-ready
  [SQLite Database](https://sqlite.org/) with
  [Cloudflare D1](https://developers.cloudflare.com/d1/)
- Healthcheck endpoint for
- [Cloudflare Analytics](https://developers.cloudflare.com/analytics) of the
  running app Metrics
- [GitHub Actions](https://github.com/features/actions) with testing and deploy
  on merge for both production and staging environments
- Email/Password Authentication with
  [cookie-based sessions](https://remix.run/utils/sessions#md-createcookiesessionstorage)
- Tenant Sites phone OTP auth: browser calls a **regional** tenant-api; customer
  PII stays in per-org SQLite on OCI (Ashburn / Riyadh), not in the US control
  plane. Changing data region wipes customers (see
  [tenant data residency](./tenant-data-residency.md))
- Tenant Sites locale-prefixed internationalization (e.g. `/ar/about`) for
  published organization websites, independent of the App/Admin Lingui locales
  (see `apps/sites/src/middleware.ts` and `packages/common/src/site-locales.ts`)
- Two-Factor Authentication (2fa) with support for authenticator apps
- Transactional email with [Resend](https://resend.com/) and forgot
  password/password reset support
- Progressively Enhanced and fully type safe forms with
  [Conform](https://conform.guide/)
- SQLite database access with [Drizzle](https://orm.drizzle.team/)
- Role-based User Permissions
- Image storage and serving with [Tigris](https://www.tigrisdata.com/)
- Per-organization BYO S3 storage (see
  [organization S3 storage](./organization-s3-storage.md))
- On-demand video posters and hover clips via Cloudflare Media Transformations
  (see
  [scheduled jobs](./scheduled-jobs.md#video-note-media-no-background-jobs))
- Print shop: branded posters, flyers and window stickers as free print-ready
  PDFs, or printed and shipped, with a vertical contract for business types (see
  [Print shop](./print-shop.md))
- Scheduled control-plane maintenance via Cloudflare Cron Worker
  (`apps/jobs-cron`) — audit archival, MCP token cleanup, GDPR erasure (see
  [scheduled jobs](./scheduled-jobs.md))
- Caching via [cachified](https://npm.im/@epic-web/cachified): Both in-memory
  and SQLite-based (with
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3))
- Styling with [Tailwind](https://tailwindcss.com/)
- An excellent, customizable component library with
  [Base UI](https://base-ui.com/)
- End-to-end testing with [Playwright](https://playwright.dev/)
- Local third party request mocking with [MSW](https://mswjs.io/)
- Unit testing with [Vitest](https://vitest.dev/) and
  [Testing Library](https://testing-library.com/) with pre-configured Test
  Database
- Code formatting with [Prettier](https://prettier.io/)
- Linting with [ESLint](https://eslint.org/)
- Static Types with [TypeScript](https://typescriptlang.org/)
- Runtime schema validation with [zod](https://zod.dev/)
- Product analytics, error tracking, and logs with
  [PostHog](https://posthog.com/)
- Light/Dark/System mode (without a flash of incorrect theme)

Here are some things that will likely find their way into the Epic Stack (or the
docs examples) in the future:

- Logging
- Ecommerce support with [Stripe](https://stripe.com/)
- Ethical site analytics with [fathom](https://usefathom.com/)
- Image optimization route and component
- Feature flags
- Documentation on production data seeding process

Not a fan of bits of the stack? Fork it, change it, and use
`npx create-remix --template your/repo`! Make it your own.
