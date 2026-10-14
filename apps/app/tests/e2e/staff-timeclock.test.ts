import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq } from '@repo/database'
import {
	BUILTIN_LABOR_POLICY,
	DEFAULT_SCOPE_ID,
	STAFFING_FLAG_KEYS,
} from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * The Time clock: manager screens (Today, Tablets, Labor rules) and the public
 * shared-tablet kiosk. The regional tenant-api is not part of this test
 * environment, so its `/operator/timeclock` and `/kiosk` endpoints are stubbed
 * in the browser; the App's own routes (flags, token mint, loaders, UI, the
 * kiosk shell, the offline queue) are real. The stubs are small and mirror the
 * response shapes the screens parse.
 */

const SCREENSHOTS = 'test-results/staff-timeclock'
// The origin the app's Content-Security-Policy allows for the US regional node.
const TENANT = 'http://localhost:3007'
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

type StubRequest = { method: string; path: string; body: any }

async function enableTimeclock(organizationId: string) {
	const ids: string[] = []
	for (const feature of ['enabled', 'timeclock'] as const) {
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS[feature],
				value: true,
				level: 'organization',
				organizationId,
			})
			.returning({ id: ConfigFlag.id })
		ids.push(row!.id)
	}
	return ids
}

async function dropFlags(ids: string[]) {
	for (const id of ids) await db.delete(ConfigFlag).where(eq(ConfigFlag.id, id))
}

function json(route: any, data: unknown, status = 200) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json' },
		body: JSON.stringify(data),
	})
}

/** Redirects the App's own token mint to a stub pointing at the fake regional node. */
async function stubTimeclockApi(page: Page, scopeId: string) {
	const requests: StubRequest[] = []
	const now = Date.now()
	const HOUR = 3_600_000
	const today = {
		serverNow: now,
		present: [
			{
				entryId: 'e1',
				staffId: 's1',
				firstName: 'Noor',
				lastName: 'Alharbi',
				scopeId,
				timeZone: 'America/Chicago',
				positionId: null,
				positionName: 'Server',
				positionNameAr: 'نادل',
				state: 'in',
				clockInAt: now - 2 * HOUR,
				breakStartAt: null,
				issues: [],
				late: false,
				missingClockOut: false,
			},
			{
				entryId: 'e2',
				staffId: 's2',
				firstName: 'Luis',
				lastName: 'Herrera',
				scopeId,
				timeZone: 'America/Chicago',
				positionId: null,
				positionName: 'Line cook',
				positionNameAr: null,
				state: 'on_break',
				clockInAt: now - 3 * HOUR,
				breakStartAt: now - 10 * 60_000,
				issues: [],
				late: false,
				missingClockOut: false,
			},
			{
				entryId: 'e3',
				staffId: 's3',
				firstName: 'Priya',
				lastName: 'Nair',
				scopeId,
				timeZone: 'America/Chicago',
				positionId: null,
				positionName: 'Barista',
				positionNameAr: null,
				state: 'in',
				clockInAt: now - 19 * HOUR,
				breakStartAt: null,
				issues: ['missing_clock_out'],
				late: false,
				missingClockOut: true,
			},
		],
		recent: [],
	}
	let devices: Array<Record<string, unknown>> = [
		{
			id: 'd1',
			scopeId,
			name: 'Front counter',
			identifyMode: 'pin',
			showNextShifts: false,
			pairedAt: now - 86_400_000,
			lastSeenAt: now - 120_000,
			revokedAt: null,
			status: 'active',
			backoffSeconds: 0,
			failuresLastHour: 0,
		},
	]
	let policy: Record<string, unknown> = {
		...BUILTIN_LABOR_POLICY,
		id: null,
		scopeId,
		source: 'builtin',
		version: 1,
		updatedAt: null,
		aggregateDecisionRequired: false,
	}
	const code = `kpc1.${'o'.repeat(12)}.${'a'.repeat(43)}`

	// The App mints the token itself; only the regional origin is fake. The App's
	// token response names `TENANT_API_URL`, so intercept whatever origin that is.
	await page.route('**/operator/timeclock**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace(/^.*\/operator\/timeclock/, '') || '/'
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path, body })

		if (method === 'GET' && path === '/today') return json(route, today)
		if (method === 'GET' && path === '/kiosk/devices') {
			return json(route, { devices })
		}
		if (method === 'GET' && path === '/kiosk/pairing-codes') {
			return json(route, { codes: [] })
		}
		if (method === 'POST' && path === '/kiosk/pairing-codes') {
			return json(
				route,
				{
					id: 'c1',
					code,
					expiresAt: Date.now() + 600_000,
					scopeId: body.scopeId,
					deviceName: body.deviceName,
					fragment: `#r=us&c=${encodeURIComponent(code)}`,
				},
				201,
			)
		}
		const revoke = path.match(/^\/kiosk\/devices\/([^/]+)\/revoke$/)
		if (method === 'POST' && revoke) {
			devices = devices.map((device) =>
				device.id === revoke[1]
					? { ...device, status: 'revoked', revokedAt: Date.now() }
					: device,
			)
			return json(route, { revoked: true })
		}
		if (method === 'GET' && path.startsWith('/policies/')) {
			return json(route, policy)
		}
		if (method === 'PUT' && path.startsWith('/policies/')) {
			policy = {
				...policy,
				...body,
				expectedVersion: undefined,
				source: 'scope',
				version: Number(policy.version) + 1,
			}
			return json(route, policy)
		}
		return json(route, { error: 'Not found' }, 404)
	})
	return { requests, code }
}

async function createOrgWithScope(userId: string) {
	const org = await createTestOrganization(userId, 'admin')
	return { org, scopeId: DEFAULT_SCOPE_ID }
}

test.describe('Time clock (manager)', () => {
	test('is not found while the time clock flag is off', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/timeclock', {
			slug: org.slug,
		})
		expect(response?.status()).toBe(404)
		await expect(page.getByRole('link', { name: 'Tablets' })).toHaveCount(0)
	})

	test('Today shows who is on the clock, who is on a break and who forgot to clock out', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		await stubTimeclockApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/timeclock', { slug: org.slug })
			await expect(
				page.getByRole('heading', { name: 'Time clock', exact: true }),
			).toBeVisible()
			await expect(page.getByText('Noor Alharbi')).toBeVisible()
			// Needs-attention first.
			// eslint-disable-next-line playwright/no-raw-locators
			const names = await page
				.getByRole('listitem')
				.locator('span.truncate')
				.allTextContents()
			expect(names.indexOf('Priya Nair')).toBeLessThan(
				names.indexOf('Noor Alharbi'),
			)
			await expect(page.getByText('Missing clock-out')).toBeVisible()
			await expect(page.getByText('3 people on the clock')).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/today-desktop.png` })

			await page.getByRole('button', { name: 'Needs attention' }).click()
			await expect(page.getByText('Noor Alharbi')).toHaveCount(0)
			await expect(page.getByText('Priya Nair')).toBeVisible()

			// Phone width: stacked rows, no sideways scrolling.
			await page.setViewportSize({ width: 360, height: 740 })
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
			await page.screenshot({ path: `${SCREENSHOTS}/today-mobile.png` })
		} finally {
			await dropFlags(flags)
		}
	})

	test('Tablets: pair with a one-time link, then remove after a confirmation', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		const api = await stubTimeclockApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/timeclock/tablets', { slug: org.slug })
			await expect(page.getByText('Front counter')).toBeVisible()
			await expect(page.getByText(/Seen 2 minutes ago/)).toBeVisible()

			await page.getByRole('button', { name: 'Pair a tablet' }).click()
			const dialog = page.getByRole('dialog')
			await dialog.getByLabel('Tablet name').fill('Front desk')
			await dialog.getByRole('button', { name: 'Create pairing code' }).click()
			await expect(dialog.getByAltText(/QR code/)).toBeVisible()
			const link = await dialog.getByLabel('Pairing link').inputValue()
			const url = new URL(link)
			expect(url.pathname).toBe('/kiosk/pair')
			expect(url.search).toBe('')
			expect(url.hash).toContain(`c=${encodeURIComponent(api.code)}`)
			await page.screenshot({ path: `${SCREENSHOTS}/pair-dialog.png` })
			await dialog
				.getByRole('button', { name: /Close, I.ll finish later/ })
				.click()

			// Removing needs a second, explicit step and says what happens.
			await page.getByRole('button', { name: 'Remove' }).click()
			const confirm = page.getByRole('alertdialog')
			await expect(confirm.getByText(/stops working right away/)).toBeVisible()
			expect(api.requests.some((r) => r.path.endsWith('/revoke'))).toBe(false)
			await page.screenshot({ path: `${SCREENSHOTS}/remove-confirm.png` })
			await confirm.getByRole('button', { name: 'Remove' }).click()
			await expect(page.getByText('Removed tablets (1)')).toBeVisible()
			expect(
				api.requests.find((r) => r.path === '/kiosk/devices/d1/revoke')?.method,
			).toBe('POST')
		} finally {
			await dropFlags(flags)
		}
	})

	test('Labor rules: grouped in plain language, saves only what changed', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		const api = await stubTimeclockApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 900 })
			await navigate('/:slug/staff/timeclock/rules', { slug: org.slug })
			await expect(
				page.getByRole('heading', { name: 'How strict do you want to be?' }),
			).toBeVisible()
			// The rest sits in collapsed groups under Advanced settings.
			await page.getByRole('button', { name: /Advanced settings/ }).click()
			for (const group of [
				'Schedule enforcement',
				'Breaks',
				'Overtime and pay week',
				'Rounding',
			]) {
				await expect(
					page.getByRole('button', { name: new RegExp(`^${group}`) }),
				).toBeVisible()
			}
			await expect(page.getByText(/not legal advice/)).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/rules-desktop.png` })

			await page.getByRole('radio', { name: /Standard starter/ }).click()
			await expect(page.getByText('You have unsaved changes.')).toBeVisible()
			expect(api.requests.some((r) => r.method === 'PUT')).toBe(false)
			await page.getByRole('switch', { name: 'Weekly overtime' }).click()
			await page.getByRole('button', { name: 'Save changes' }).click()
			await expect(page.getByText('All changes saved.')).toBeVisible()
			const put = api.requests.find((r) => r.method === 'PUT')!
			expect(put.body.weeklyOvertime).toEqual({
				thresholdMinutes: 2400,
				multiplierBp: 15000,
			})
			// Nothing the screen does not edit is ever sent.
			expect(put.body).not.toHaveProperty('geofence')
			expect(put.body).not.toHaveProperty('rulePack')

			await page.setViewportSize({ width: 360, height: 740 })
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
			await page.screenshot({ path: `${SCREENSHOTS}/rules-mobile.png` })
		} finally {
			await dropFlags(flags)
		}
	})
})

// ---------------------------------------------------------------------------
// The public kiosk
// ---------------------------------------------------------------------------

const SECRET = `kdv1.org_1.device01.${'a'.repeat(43)}`

async function pairBrowser(page: Page, locale?: 'ar') {
	await page.addInitScript(
		({ secret, tenant, savedLocale }) => {
			localStorage.setItem(
				'kiosk.device.v1',
				JSON.stringify({
					deviceSecret: secret,
					tenantApiUrl: tenant,
					config: {
						device: {
							id: 'd1',
							name: 'Front counter',
							scopeId: 'loc-1',
							identifyMode: 'pin',
							showNextShifts: false,
						},
						scope: { name: 'Downtown', timeZone: 'America/Chicago' },
					},
				}),
			)
			// The init script runs again on every navigation: seed the language only
			// the first time, or a reload would undo the choice made on the page.
			if (savedLocale && localStorage.getItem('kiosk.locale.v1') === null) {
				localStorage.setItem('kiosk.locale.v1', savedLocale)
			}
		},
		{ secret: SECRET, tenant: TENANT, savedLocale: locale ?? null },
	)
}

type Kiosk = { punches: any[]; offline: boolean; revoked: boolean }

async function stubKioskApi(page: Page) {
	const state: Kiosk = { punches: [], offline: false, revoked: false }
	await page.route(`${TENANT}/kiosk/**`, async (route) => {
		const request = route.request()
		// A dropped connection is a failed request, not an HTTP answer.
		if (state.offline) return route.abort('internetdisconnected')
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const path = new URL(request.url()).pathname
		if (state.revoked) return json(route, { error: 'device_revoked' }, 401)
		if (path === '/kiosk/config') {
			return json(route, {
				device: {
					id: 'd1',
					name: 'Front counter',
					scopeId: 'loc-1',
					identifyMode: 'pin',
					showNextShifts: false,
				},
				scope: { name: 'Downtown', timeZone: 'America/Chicago' },
				serverNow: Date.now(),
			})
		}
		const body = request.postDataJSON?.() ?? null
		if (path === '/kiosk/identify') {
			if (body.pin !== '4821') {
				return json(route, { error: 'invalid_pin', retryAfterSeconds: 0 }, 401)
			}
			return json(route, {
				firstName: 'Rana',
				state: 'out',
				allowedEvents: ['clock_in'],
				positions: [],
				nextShifts: [],
				promptTips: false,
				serverNow: Date.now(),
			})
		}
		if (path === '/kiosk/punch') {
			state.punches.push(body)
			return json(route, {
				outcome: 'accepted',
				duplicate: false,
				kind: body.kind,
				state: 'in',
				firstName: 'Rana',
				at: Date.now(),
				serverNow: Date.now(),
			})
		}
		return json(route, { error: 'Not found' }, 404)
	})
	return state
}

async function enterPin(page: Page, pin: string) {
	for (const digit of pin) {
		await page.getByRole('button', { name: digit, exact: true }).click()
	}
	await page.getByRole('button', { name: 'Continue' }).click()
}

test.describe('Kiosk (public shared tablet)', () => {
	test('is reachable without signing in, and shows set-up steps when unpaired', async ({
		page,
	}) => {
		const response = await page.goto('/kiosk')
		expect(response?.status()).toBe(200)
		await expect(
			page.getByRole('heading', { name: 'Set up this tablet' }),
		).toBeVisible()
		// A clock on a counter does not ask for cookies.
		await expect(page.getByText(/cookie/i)).toHaveCount(0)
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-unpaired.png` })
	})

	test('PIN, clock in, first-name confirmation, back to the pad', async ({
		page,
	}) => {
		await pairBrowser(page)
		const kiosk = await stubKioskApi(page)
		await page.setViewportSize({ width: 1180, height: 820 })
		await page.goto('/kiosk')
		await expect(
			page.getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible()
		await expect(page.getByText('Downtown · Front counter')).toBeVisible()
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-pad-tablet.png` })

		// A wrong PIN is plain and leaves a clean pad.
		await enterPin(page, '0000')
		await expect(page.getByRole('alert')).toContainText(
			'That PIN did not match',
		)

		await enterPin(page, '4821')
		await expect(page.getByRole('heading', { name: 'Hi Rana' })).toBeVisible()
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-actions.png` })
		await page.getByRole('button', { name: 'Clock in' }).click()
		await expect(
			page.getByRole('heading', { name: 'Clocked in, Rana' }),
		).toBeVisible()
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-done.png` })
		expect(kiosk.punches).toHaveLength(1)
		expect(kiosk.punches[0]).toMatchObject({
			kind: 'clock_in',
			pin: '4821',
			offline: false,
		})
		// The confirmation closes by itself.
		await expect(
			page.getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible({
			timeout: 10_000,
		})
		// No scrolling on a tablet.
		const scroll = await page.evaluate(() => [
			document.documentElement.scrollHeight - innerHeight,
			document.documentElement.scrollWidth - innerWidth,
		])
		expect(scroll[0]).toBeLessThanOrEqual(0)
		expect(scroll[1]).toBeLessThanOrEqual(0)
	})

	test('works on a phone without scrolling', async ({ page }) => {
		await pairBrowser(page)
		await stubKioskApi(page)
		await page.setViewportSize({ width: 360, height: 640 })
		await page.goto('/kiosk')
		await expect(
			page.getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible()
		const scroll = await page.evaluate(() => [
			document.documentElement.scrollHeight - innerHeight,
			document.documentElement.scrollWidth - innerWidth,
		])
		expect(scroll[0]).toBeLessThanOrEqual(0)
		expect(scroll[1]).toBeLessThanOrEqual(0)
		// Every key meets the 44px touch target.
		const small = await page
			.getByRole('group', { name: 'Number pad' })
			.getByRole('button')
			.evaluateAll(
				(buttons) =>
					buttons.filter((b) => b.getBoundingClientRect().height < 44).length,
			)
		expect(small).toBe(0)
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-phone.png` })
	})

	test('saves a punch while offline and sends it when the connection returns', async ({
		page,
	}) => {
		test.setTimeout(90_000)
		await pairBrowser(page)
		const kiosk = await stubKioskApi(page)
		await page.setViewportSize({ width: 1180, height: 820 })
		await page.goto('/kiosk')
		await expect(
			page.getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible()
		await page.waitForTimeout(500)

		kiosk.offline = true
		await enterPin(page, '4821')
		await expect(
			page.getByRole('heading', { name: 'No connection' }),
		).toBeVisible()
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-offline-actions.png` })
		await page.getByRole('button', { name: 'Clock in' }).click()
		await expect(page.getByText(/Saved on this tablet/)).toBeVisible()
		await expect(page.getByText(/Offline · 1 punch saved/)).toBeVisible()
		await page.screenshot({ path: `${SCREENSHOTS}/kiosk-offline-saved.png` })
		expect(kiosk.punches).toHaveLength(0)

		kiosk.offline = false
		await page.evaluate(() => window.dispatchEvent(new Event('online')))
		await expect.poll(() => kiosk.punches.length, { timeout: 40_000 }).toBe(1)
		expect(kiosk.punches[0]).toMatchObject({ pin: '4821', offline: true })
		await expect(page.getByText('All saved')).toBeVisible()
	})

	test('goes back to set-up when a manager removes the tablet', async ({
		page,
	}) => {
		await pairBrowser(page)
		const kiosk = await stubKioskApi(page)
		kiosk.revoked = true
		await page.goto('/kiosk')
		await expect(
			page.getByRole('heading', { name: 'This tablet was disconnected' }),
		).toBeVisible()
		expect(
			await page.evaluate(() => localStorage.getItem('kiosk.device.v1')),
		).toBeNull()
	})

	test.describe('in Arabic', () => {
		test('mirrors the kiosk, keeps the keypad in Western digits, and remembers the language', async ({
			page,
		}) => {
			await pairBrowser(page, 'ar')
			await stubKioskApi(page)
			await page.setViewportSize({ width: 1180, height: 820 })
			await page.goto('/kiosk')
			await expect(
				page.getByRole('heading', { name: 'أدخل رقمك السري' }),
			).toBeVisible()
			expect(
				await page.evaluate(() => [
					document.documentElement.dir,
					document.documentElement.lang,
				]),
			).toEqual(['rtl', 'ar'])
			// The keypad never rearranges or changes its numerals.
			await expect(
				page.getByRole('button', { name: '5', exact: true }),
			).toBeVisible()
			await expect(
				page.getByRole('group', { name: 'لوحة الأرقام' }),
			).toHaveAttribute('dir', 'ltr')
			await page.screenshot({ path: `${SCREENSHOTS}/kiosk-rtl.png` })

			// One tap to switch back, and it stays.
			await page.getByRole('button', { name: 'English' }).click()
			await expect(
				page.getByRole('heading', { name: 'Enter your PIN' }),
			).toBeVisible()
			await page.reload()
			await expect(
				page.getByRole('heading', { name: 'Enter your PIN' }),
			).toBeVisible()
		})
	})
})
