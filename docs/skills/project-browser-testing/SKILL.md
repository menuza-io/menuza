---
name: project-browser-testing
description:
  Guide manual browser testing of App, Admin and Sites in a headless sandbox
  with agent-browser or Playwright-style tools, covering login, covered clicks,
  React inputs, eval, drag and drop, session loss, evidence and Sites hosts in
  this project.
---

# Project browser testing

## When to use this skill

Use this skill when you drive App, Admin or Sites in a real browser to check a
change by hand: a browser automation CLI such as agent-browser, or an ad hoc
Playwright script. For committed E2E specs, use the `project-testing` skill and
`apps/app/tests/playwright-utils.ts`. Start services with "Local services
(headless)" in the root `AGENTS.md`; on a developer machine, use the running
root `npm run dev` instead.

## Login

- Open `/login` directly (`http://localhost:3001/login` in a sandbox). Accept
  the cookie banner once per browser context.
- Login has two steps. Fill "Email or Username" and press Enter, take a fresh
  snapshot, then fill `input[type=password]` and submit. Element refs expire
  between calls, so snapshot again after every navigation or re-render.
- Wait for specific text or a URL change, never for network idle. The
  notifications stream (`/api/notifications/stream`) never goes idle.
- If a page shows no interactive elements, or "Invalid hook call", it loaded
  while Vite was still optimizing dependencies. Reload it.
- When you submit a form from script, pick the right one and call
  `form.requestSubmit()`. On `/signup` the first form is the OAuth provider
  form, not the signup form.
- Switch users in a new browser context, not by logging out (see the `/_.data`
  entry in root "Known issues").
- Usernames allow only letters, digits and `_`.

## "Element is covered by ..."

Fixed or overlapping layers intercept clicks: the App sidebar
(`[data-slot=sidebar]`), a top progress bar during navigation, and
`astro-dev-toolbar` on Sites. Scroll the target into view and click it from
script:

```js
;(async () => {
	const el = document.querySelector('<selector>')
	el.scrollIntoView({ block: 'center' })
	el.click()
	return 'clicked'
})()
```

## React-controlled inputs

Setting `el.value` directly is overwritten on the next render. Use the native
setter and fire both events, also for date and time inputs:

```js
;(async () => {
	const el = document.querySelector('<selector>')
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		'value',
	).set
	setter.call(el, '<value>')
	el.dispatchEvent(new Event('input', { bubbles: true }))
	el.dispatchEvent(new Event('change', { bubbles: true }))
	return el.value
})()
```

Use `HTMLTextAreaElement.prototype` for a textarea. To clear a field by
keyboard: focus it, press Ctrl+A, then Backspace. For a native `<select>`, use
the tool's select command rather than clicks.

## eval traps

- Every eval runs in the same page context, so a second top-level `const x`
  throws a redeclaration error. Wrap code in an async IIFE as above.
- Pass multi-line code through stdin or a quoted heredoc, not a shell string.
- Results come back JSON-encoded (a string arrives quoted). Parse them before
  you compare or reuse them.

## HTML5 drag and drop

CDP mouse moves do not fire `drop` on HTML5 drag targets. Dispatch the events
yourself with one shared `DataTransfer`:

```js
;(async () => {
	const source = document.querySelector('<source>')
	const target = document.querySelector('<target>')
	const dataTransfer = new DataTransfer()
	for (const [el, type] of [
		[source, 'dragstart'],
		[target, 'dragover'],
		[target, 'drop'],
		[source, 'dragend'],
	]) {
		el.dispatchEvent(
			new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
		)
	}
	return 'dropped'
})()
```

## Session loss

The browser can relaunch during a long run and lose its cookies. Make each step
self-contained (open the URL, wait for text, act, check the result) and be ready
to log in again when you land on `/login`.

## Evidence

- Use absolute screenshot paths, such as `/tmp/shots/<name>.png`. A relative
  path writes into the repo root.
- Scroll an element into view before an element screenshot.
- In a HAR, redirect hops show status 0. For response bodies, repeat the request
  with curl and the session cookie.
- Headless Chrome throttles timers in background tabs. Switch to the tab under
  test before you wait on it.
- Never `set -x` around tokens or cookies. Print `${#TOKEN}` to show a value is
  set.

## Sites

- Sites resolves the org from the Host header, so `localhost` shows no org. Use
  `<slug>.menuza.test:3008` (the `ROOT_APP` suffix from
  `apps/sites/.env.schema`; `apps/sites/src/lib/resolve-host.ts` lists the
  others). From curl:
  `curl -H 'Host: <slug>.menuza.test:3008' http://localhost:3008/`.
- In Chromium, launch with `--host-resolver-rules="MAP *.menuza.test [::1]"`.
  Observed: the dev server listens on IPv6 `[::1]`, so mapping to `127.0.0.1`
  fails. Launch arguments apply only at launch, so close the browser session
  before you change them.
- `?lng=ar` sets a sticky locale cookie. Undo it with `?lng=en`.
- Turnstile is off locally (empty `PUBLIC_TURNSTILE_SITE_KEY`), but form
  honeypots still run. Leave hidden honeypot fields empty.
- Public tenant-api calls from the page resolve the org from `Origin`, and local
  rate limits treat every browser as one client (see root "Local auth, OTP and
  email in dev").

## Parallel testers

- Give each tester its own data (users, org, records).
- Re-read the current version of a record right before you write it.
- Capture a baseline before you change shared settings and restore it after.

## Resource limits

An App tab uses about 500 MB. On an 8 GB machine, keep to two or three browsers
and do not test while App typecheck, a build or the whole test suite runs.

## References

- [App agent guide: login and browser testing](../../../apps/app/AGENTS.md)
- [Root agent guide: local services](../../../AGENTS.md)
- [Playwright fixtures](../../../apps/app/tests/playwright-utils.ts)
- [Sites host resolution](../../../apps/sites/src/lib/resolve-host.ts)
- [Project testing skill](../project-testing/SKILL.md)
