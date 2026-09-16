---
name: project-testing
description:
  Guide Vitest, Testing Library, Playwright, MSW, database fixtures,
  authorization tests, and multi-app validation in this project.
---

# Project testing

## When to use this skill

Use this skill when adding or changing unit tests, component tests, route
loader/action tests, API tests, database fixtures, mocks, or browser workflows.

## Test the user-visible contract

Prefer tests that follow a real workflow and assert specific outcomes: visible
text, accessible roles, redirects, response status/body, persisted state, and
authorization behavior. Avoid testing implementation details such as a private
helper call or a particular DOM class when the behavior can be tested through
the route/component contract.

The repository uses:

- Vitest for utilities, packages, route handlers, database behavior, and
  component tests with Testing Library.
- Playwright for complete App/Admin browser workflows.
- MSW and existing test mocks for external providers and services.
- Sites and tenant-api have their own Vitest suites; tenant-api tests exercise
  both route contracts and regional/security edge cases.
- `apps/mobile` uses Jest; iOS Swift tests and Android JVM tests are opt-in and
  intentionally outside the default Turbo test graph.

## Unit and component tests

Keep tests next to source (`*.test.ts`/`*.test.tsx`) and use the package’s
Vitest config. Prefer shared setup and fixtures from `@repo/test-utils`.

```typescript
import { describe, expect, it } from 'vitest'

describe('normalizeThing', () => {
	it('preserves the public contract', () => {
		expect(normalizeThing(' Example ')).toBe('example')
	})
})
```

Test validation boundaries, error branches, retries, cache misses/hits, and
adversarial inputs. For DB tests, use the configured test database and Drizzle
helpers; do not connect tests to production or share mutable state between
cases.

## App browser tests

Use `apps/app/tests/playwright-utils.ts`:

```typescript
import { expect, test } from '#tests/playwright-utils.ts'

test('operator can update a website setting', async ({
	page,
	navigate,
	login,
}) => {
	await login()
	await navigate('/organizations/demo/website')
	await page.getByRole('button', { name: /save/i }).click()
	await expect(page.getByText(/saved/i)).toBeVisible()
})
```

The fixture provides `login`, `insertNewUser`, `navigate`, and cleanup. Use
accessible locators, avoid arbitrary sleeps, and use the shared `waitFor` helper
for eventual external/test state. Prefer one focused workflow per test.

Add coverage for:

- unauthenticated redirects and authenticated success;
- allowed, denied, inactive-membership, and cross-organization access;
- form validation and server error rendering;
- passkeys/2FA/OAuth with the existing mocks;
- tenant region routing and the no-Sites-BFF boundary when changing tenant auth
  or public forms.

## Commands and scope

```sh
npm run test
npm run test:e2e:run
npm run typecheck
npm run lint:all
npm run validate
```

During iteration, run the nearest package/app test command, then run the
workspace validation for cross-package changes. Keep tests deterministic and
clean up users, sessions, organizations, tenant DBs, files, and mocked external
records through the established fixtures.

Useful targeted commands include `npm run test -w tenant-api`,
`npm run test -w sites`, `npm run test -w @repo/integrations`,
`npm run test -w @repo/security`, `npm run testing -w mobile`,
`npm run ios:test -w ios`, and `npm run android:test -w android`.

When changing a shared package, run its tests plus at least one consuming app;
Turbo’s cache is an optimization, not evidence that a runtime boundary was
tested. For adversarial/security changes, include malformed input, replay,
cross-organization access, token leakage, and partial-failure cases.

## References

- [Testing docs](../../testing.md)
- [Playwright fixtures](../../../apps/app/tests/playwright-utils.ts)
- [Test database utilities](../../../packages/test-utils/src/db-utils.ts)
- [CI workflow](../../../.github/workflows/deploy.yml)
