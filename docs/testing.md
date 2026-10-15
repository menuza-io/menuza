# Testing

## Playwright

We use Playwright for our End-to-End tests in this project. You'll find those in
the `tests` directory. As you make changes, add to an existing file or create a
new file in the `tests` directory to test your changes.

To run these tests in development, run `npm run test:e2e:dev` which will start
the dev server for the app and run Playwright on it.

### Running against the production build (what CI does)

The test process writes to the SQLite control plane (`@repo/database`), so the
server under test must read the same file. `npm run dev` does not: the Workers
dev server uses a local D1 copy, and Playwright would reuse it on port 3001 and
fail to find the users it just created. Run the mocked production build on its
own port instead:

```bash
npm run build -w app
cd apps/app && PORT=3101 CI=true npx playwright test tests/e2e/staff- --workers=1
```

`CI=true` starts `npm run start:mocks` on `PORT` (never reusing a dev server);
`PORT` keeps it off the port a running `npm run dev` holds. The Staff specs
(`tests/e2e/staff-*.test.ts`) stub the regional tenant-api in the browser, so no
tenant-api node is needed.

We have a fixture for testing authenticated features without having to go
through the login flow:

```ts
test('my test', async ({ page, login }) => {
	const user = await login()
	// you are now logged in
})
```

We also auto-delete the user at the end of your test. That way, we can keep your
local db clean and keep your tests isolated from one another.

## Vitest

For lower level tests of utilities and individual components, we use `vitest`.
We have DOM-specific assertion helpers via
[`@testing-library/jest-dom`](https://testing-library.com/jest-dom).

## Type Checking

This project uses TypeScript. It's recommended to get TypeScript set up for your
editor to get a really great in-editor experience with type checking and
auto-complete. To run type checking across the whole project, run
`npm run typecheck`.

## Linting

This project uses ESLint for linting. Each workspace has its own flat config
(`eslint.config.js`, for example `apps/app/eslint.config.js`) built on
`packages/config/eslint-preset.js`. Run it inside a workspace, for example
`npm run lint -w app`; the root `eslint.config.js` ignores every file.

## Formatting

We use [Prettier](https://prettier.io/) for auto-formatting in this project.
It's recommended to install an editor plugin (like the
[VSCode Prettier plugin](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode))
to get auto-formatting on save. There's also a `npm run format` script you can
run to format all files in the project.
