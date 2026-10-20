/**
 * Build-time switch from `vite.config.ts` (`false` in the Cloudflare production
 * build). Always read it as
 * `typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' && __PAYMENTS_MOCK_BUNDLED__`
 * so a build that does not define it keeps the mock off.
 */
declare const __PAYMENTS_MOCK_BUNDLED__: boolean | undefined
