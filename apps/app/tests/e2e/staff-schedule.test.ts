import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq } from '@repo/database'
import { DEFAULT_SCOPE_ID, STAFFING_FLAG_KEYS } from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Schedule (flag `staffing.scheduling`): the week grid, the sticky Publish
 * flow, keyboard moves and the phone's one-day list. The regional tenant-api is
 * not part of this test environment, so `/operator/schedule` is stubbed in the
 * browser with the response shapes the screens parse; the App's own routes
 * (flags, token mint, loaders, UI) are real. Run against the `CI=true` mocked
 * build, like the other manager specs.
 */

const SCREENSHOTS = 'test-results/staff-schedule'
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

type StubRequest = { method: string; path: string; body: any }

async function enableScheduling(organizationId: string) {
	const ids: string[] = []
	for (const feature of ['enabled', 'scheduling'] as const) {
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

/** Monday of this week in UTC, as `YYYY-MM-DD`, plus the seven dates. */
function thisWeek() {
	const now = new Date()
	const monday = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	)
	monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
	return Array.from({ length: 7 }, (_, i) => {
		const d = new Date(monday)
		d.setUTCDate(d.getUTCDate() + i)
		return d.toISOString().slice(0, 10)
	})
}

async function stubScheduleApi(page: Page, scopeId: string) {
	const requests: StubRequest[] = []
	const dates = thisWeek()
	const at = (date: string, hour: number) =>
		Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`)
	const shift = (
		id: string,
		staffId: string | null,
		date: string,
		from: number,
		to: number,
		extra: Record<string, unknown> = {},
	) => ({
		id,
		scopeId,
		staffId,
		positionId: 'p1',
		startsAt: at(date, from),
		endsAt: at(date, to),
		localDate: date,
		timeZone: 'UTC',
		unpaidBreakMinutes: 0,
		paidMinutes: (to - from) * 60,
		notes: null,
		state: 'draft',
		published: null,
		version: 1,
		conflicts: [],
		...extra,
	})
	const state = {
		version: 2,
		shifts: [
			shift('a', 's1', dates[0]!, 9, 17),
			shift('b', 's2', dates[1]!, 10, 18, {
				state: 'published',
				conflicts: [{ code: 'overtime', shiftId: 'b' }],
			}),
			shift('c', null, dates[2]!, 11, 15),
		],
	}
	const person = (id: string, firstName: string, lastName: string) => ({
		id,
		firstName,
		lastName,
		firstNameAr: null,
		lastNameAr: null,
		status: 'active',
		positionIds: ['p1'],
		showInSchedule: true,
		eligibleOpenShifts: true,
		weekMinutes: 480,
		overtimeMinutes: 0,
	})
	const week = () => ({
		estimate: true,
		scopeId,
		timeZone: 'UTC',
		weekStart: dates[0],
		weekEnd: dates[6],
		weekStartsOn: 1,
		dates,
		version: state.version,
		lastPublishedAt: null,
		unpublishedCount: state.shifts.filter((s) => s.state !== 'published')
			.length,
		people: [person('s1', 'Noor', 'Alharbi'), person('s2', 'Luis', 'Herrera')],
		shifts: state.shifts,
		overlays: [],
		footers: dates.map((date) => ({
			date,
			minutes: 0,
			overtimeMinutes: 0,
			headcount: state.shifts.filter((s) => s.localDate === date).length,
			openShifts: 0,
			openMinutes: 0,
		})),
		totals: { minutes: 0, overtimeMinutes: 0, openShifts: 1, openMinutes: 240 },
		pending: { timeOff: 0, availability: 0, shiftRequests: 0 },
		positions: [{ id: 'p1', name: 'Server', nameAr: null, colorKey: 'blue' }],
		currencies: ['USD'],
	})

	await page.route('**/operator/schedule/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace('/operator/schedule', '')
		const method = request.method()
		const body: any = request.postData()
			? JSON.parse(request.postData()!)
			: null
		requests.push({ method, path, body })
		if (method === 'GET' && path === '/week') return json(route, week())
		if (method === 'GET' && path === '/demand') {
			return json(route, {
				kind: 'guide',
				estimate: true,
				source: 'online_orders',
				statistic: 'median',
				weeks: 8,
				windowStart: dates[0],
				windowEnd: dates[6],
				daysWithOrders: 0,
				timeZone: 'UTC',
				days: [],
			})
		}
		const detail = path.match(/^\/shifts\/([^/]+)$/)
		if (method === 'PATCH' && detail) {
			const target = state.shifts.find((s) => s.id === detail[1])!
			if (body.staffId !== undefined) target.staffId = body.staffId
			if (body.date) target.localDate = body.date
			target.version += 1
			return json(route, { shifts: [target] })
		}
		if (method === 'POST' && path === '/publish') {
			for (const s of state.shifts) s.state = 'published'
			state.version += 1
			return json(route, {
				publication: {
					id: 'pub1',
					scopeId,
					weekStart: dates[0],
					version: state.version,
					notifyMode: body.notifyMode,
					summary: {},
					publishedBy: 'u1',
					publishedAt: Date.now(),
					changes: [],
				},
				week: { version: state.version, unpublishedCount: 0 },
			})
		}
		return json(route, { error: 'not_found' }, 404)
	})
	return { requests, state, dates }
}

async function createOrgWithScope(userId: string) {
	const org = await createTestOrganization(userId, 'admin')
	return { org, scopeId: DEFAULT_SCOPE_ID }
}

test.describe('Schedule (manager)', () => {
	test('is not found while the scheduling flag is off', async ({
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/schedule', { slug: org.slug })
		expect(response?.status()).toBe(404)
	})

	test('week grid shows drafts and warnings in words, and publishes with a chosen audience', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableScheduling(org.id)
		const { requests } = await stubScheduleApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/schedule', { slug: org.slug })
			await expect(
				page.getByRole('rowheader', { name: /Noor Alharbi/ }),
			).toBeVisible()
			await expect(
				page.getByRole('button', { name: /^Draft, .*Server/ }).first(),
			).toBeVisible()
			await expect(
				page.getByRole('button', { name: /Published.*warning/ }),
			).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/week-desktop.png` })

			await page.getByRole('button', { name: /Publish \(2\)/ }).click()
			const dialog = page.getByRole('dialog')
			await dialog.getByText('Nobody', { exact: true }).click()
			await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
			await expect
				.poll(() => requests.some((r) => r.path === '/publish'))
				.toBe(true)
			const post = requests.find((r) => r.path === '/publish')!
			expect(post.body.notifyMode).toBe('nobody')
			expect(post.body.expectedVersion).toBe(2)
			await expect(
				page.getByRole('button', { name: /Publish \(/ }),
			).toHaveCount(0)
		} finally {
			await dropFlags(flags)
		}
	})

	test('a shift moves to someone else with the keyboard alone', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableScheduling(org.id)
		const { requests } = await stubScheduleApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/schedule', { slug: org.slug })
			const block = page
				.getByRole('button', { name: /^Draft, .*Server/ })
				.first()
			await block.focus()
			await page.keyboard.press('Space')
			// The live region speaks each step: wait for it before the next key.
			await expect(page.getByText(/^Over Open shifts/)).toBeAttached()
			await page.keyboard.press('ArrowDown')
			await expect(page.getByText(/^Over Luis Herrera/)).toBeAttached()
			await page.keyboard.press('Space')
			await expect
				.poll(() => requests.some((r) => r.method === 'PATCH'))
				.toBe(true)
			const patch = requests.find((r) => r.method === 'PATCH')!
			// The open shift (the first block in reading order) went to the person
			// in the row below it.
			expect(patch.path).toBe('/shifts/c')
			expect(patch.body.expectedVersion).toBe(1)
			expect(patch.body.staffId).toBe('s2')
		} finally {
			await dropFlags(flags)
		}
	})

	test('on a phone the grid becomes a one-day list without sideways scrolling', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableScheduling(org.id)
		await stubScheduleApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 360, height: 740 })
			await navigate('/:slug/staff/schedule', { slug: org.slug })
			await expect(
				page.getByRole('tablist', { name: 'Days of the week' }),
			).toBeVisible()
			await expect(page.getByRole('table')).toHaveCount(0)
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
			await page.screenshot({ path: `${SCREENSHOTS}/week-mobile.png` })
		} finally {
			await dropFlags(flags)
		}
	})
})
