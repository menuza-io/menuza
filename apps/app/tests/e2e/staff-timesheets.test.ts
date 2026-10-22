import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq } from '@repo/database'
import { DEFAULT_SCOPE_ID, STAFFING_FLAG_KEYS } from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Timesheets (flag `staffing.timeclock`): period view, the needs-review queue,
 * the card sheet and bulk approval. The regional tenant-api is not part of this
 * test environment, so `/operator/timeclock` and `/operator/staff` are stubbed in
 * the browser with the response shapes the screens parse; the App's own routes
 * (flags, token mint, loaders, UI) are real. Run against the `CI=true` mocked
 * build, like the other manager specs.
 */

const SCREENSHOTS = 'test-results/staff-timesheets'
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}
const HOUR = 3_600_000

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

function minutes(paid: number, overtime = 0) {
	return {
		regularMinutes: paid - overtime,
		overtimeMinutes: overtime,
		doubleTimeMinutes: 0,
		holidayMinutes: 0,
		paidMinutes: paid,
		unpaidBreakMinutes: 0,
	}
}

function totalsOf(cards: Array<Record<string, any>>) {
	return {
		...minutes(
			cards.reduce((sum, c) => sum + c.minutes.paidMinutes, 0),
			cards.reduce((sum, c) => sum + c.minutes.overtimeMinutes, 0),
		),
		cards: cards.length,
		open: cards.filter((c) => c.status === 'open').length,
		needsReview: cards.filter((c) => c.status === 'needs_review').length,
		approved: cards.filter((c) => c.status === 'approved').length,
		locked: cards.filter((c) => c.status === 'locked').length,
	}
}

async function stubTimesheetApi(page: Page, scopeId: string) {
	const requests: StubRequest[] = []
	// Cards sit on "yesterday" and "the day before", so a period view that
	// follows today always contains them.
	const day = (offset: number) => {
		const d = new Date(Date.now() - offset * 24 * HOUR)
		return d.toISOString().slice(0, 10)
	}
	const at = (offset: number, hour: number) => {
		const d = new Date(Date.now() - offset * 24 * HOUR)
		d.setUTCHours(hour, 0, 0, 0)
		return d.getTime()
	}
	const base = {
		scopeId,
		positionId: null,
		positionNameAr: null,
		timeZone: 'UTC',
		clockOutKind: 'manual',
		breaks: [] as unknown[],
		figuresChanged: false,
		managerNote: null,
		approvedAt: null,
		lockedAt: null,
		reviewed: false,
		edited: false,
	}
	const cards: Array<Record<string, any>> = [
		{
			...base,
			id: 'c1',
			staffId: 's1',
			positionName: 'Server',
			localDate: day(1),
			clockInAt: at(1, 9),
			clockOutAt: at(1, 17),
			status: 'closed',
			issues: [],
			minutes: minutes(480),
			version: 1,
		},
		{
			...base,
			id: 'c2',
			staffId: 's1',
			positionName: 'Server',
			localDate: day(2),
			clockInAt: at(2, 8),
			clockOutAt: at(2, 18),
			status: 'closed',
			issues: [],
			minutes: minutes(600, 120),
			version: 1,
		},
		{
			...base,
			id: 'c3',
			staffId: 's2',
			positionName: 'Cook',
			localDate: day(1),
			clockInAt: at(1, 10),
			clockOutAt: null,
			status: 'open',
			issues: ['missing_clock_out'],
			minutes: minutes(0),
			version: 4,
		},
		{
			...base,
			id: 'c4',
			staffId: 's2',
			positionName: 'Cook',
			localDate: day(2),
			clockInAt: at(2, 10),
			clockOutAt: at(2, 18),
			status: 'needs_review',
			issues: ['missed_break'],
			minutes: minutes(480),
			version: 2,
		},
	]
	const people = [
		{
			staffId: 's1',
			firstName: 'Noor',
			lastName: 'Alharbi',
			firstNameAr: null,
			lastNameAr: null,
			employeeNumber: 'E-1',
			terminated: false,
		},
		{
			staffId: 's2',
			firstName: 'Luis',
			lastName: 'Herrera',
			firstNameAr: null,
			lastNameAr: null,
			employeeNumber: null,
			terminated: false,
		},
	]
	const view = (subset: typeof cards) => ({
		serverNow: Date.now(),
		people: people
			.map((p) => {
				const own = subset.filter((c) => c.staffId === p.staffId)
				return { ...p, cards: own, totals: totalsOf(own) }
			})
			.filter((p) => p.cards.length > 0),
		totals: totalsOf(subset),
		filters: {
			scopeId: null,
			positionId: null,
			staffId: null,
			status: null,
		},
		truncated: false,
	})
	const start = day(13)
	const period = {
		type: 'biweekly',
		start,
		end: day(0),
		days: 14,
		previousStart: day(27),
		nextStart: day(-1),
	}

	await page.route('**/operator/timeclock/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace(/^.*\/operator\/timeclock/, '') || '/'
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path, body })

		if (method === 'GET' && path === '/timesheets/period') {
			return json(route, { ...view(cards), period })
		}
		if (method === 'GET' && path === '/timesheets/review') {
			const queue = cards.filter(
				(c) => c.status === 'needs_review' || c.status === 'open',
			)
			return json(route, {
				...view(queue),
				byIssue: { missing_clock_out: 1, missed_break: 1 },
			})
		}
		if (method === 'GET' && path === '/policies') {
			return json(route, {
				default: { timesheetApprovalMode: 'approve' },
				scopes: [],
			})
		}
		const detail = path.match(/^\/timesheets\/entries\/([^/]+)$/)
		if (method === 'GET' && detail) {
			const card = cards.find((c) => c.id === detail[1])
			if (!card) return json(route, { error: 'not_found' }, 404)
			return json(route, {
				serverNow: Date.now(),
				person: people.find((p) => p.staffId === card.staffId),
				card,
				edits: [],
				punches: [],
			})
		}
		if (method === 'PATCH' && detail) {
			const card = cards.find((c) => c.id === detail[1])!
			card.clockOutAt = body.clockOutAt ?? card.clockOutAt
			card.status = 'closed'
			card.issues = []
			card.minutes = minutes(420)
			card.version += 1
			return json(route, {
				card,
				edit: {
					id: 'e1',
					entryId: card.id,
					editorId: 'u1',
					via: 'manager',
					action: 'update',
					reason: body.reason,
					before: null,
					after: null,
					hoursDeltaMinutes: 420,
					createdAt: Date.now(),
				},
				reducedHours: false,
			})
		}
		if (method === 'POST' && path === '/timesheets/approve') {
			const results = body.entries.map((entry: any) => {
				const card = cards.find((c) => c.id === entry.id)!
				card.status = 'approved'
				card.version += 1
				return {
					id: card.id,
					ok: true,
					status: 'approved',
					version: card.version,
				}
			})
			return json(route, { results, changed: results.length, skipped: 0 })
		}
		return json(route, { error: 'Not found' }, 404)
	})
	await page.route('**/operator/staff/**', (route) => {
		if (route.request().method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		return json(route, { positions: [] })
	})
	return { requests, cards }
}

async function createOrgWithScope(userId: string) {
	const org = await createTestOrganization(userId, 'admin')
	return { org, scopeId: DEFAULT_SCOPE_ID }
}

test.describe('Timesheets (manager)', () => {
	test('is not found while the time clock flag is off', async ({
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/timeclock/timesheets', {
			slug: org.slug,
		})
		expect(response?.status()).toBe(404)
	})

	test('period view groups cards by person, marks overtime in words and clears the review queue', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		const { requests } = await stubTimesheetApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/timeclock/timesheets', { slug: org.slug })
			await expect(page.getByRole('tab', { name: 'Timesheets' })).toBeVisible()
			await expect(
				page.getByRole('rowheader', { name: /Noor Alharbi/ }),
			).toBeVisible()
			// The person's row, the day cell and the total all say it: any one is enough.
			await expect(page.getByText('OT 2.00').first()).toBeVisible()
			await expect(page.getByText(/overtime \(estimate\)/)).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/period-desktop.png` })

			// The queue: type the missing clock-out right in the row.
			await page
				.getByRole('button', { name: /Needs review/ })
				.first()
				.click()
			await expect(page.getByText('Missing clock-out.')).toBeVisible()
			await page.getByLabel(/Clocked out at, for Luis Herrera/).fill('17:00')
			await page.getByRole('button', { name: 'Set clock-out' }).click()
			await expect
				.poll(() => requests.some((r) => r.method === 'PATCH'))
				.toBe(true)
			const patch = requests.find((r) => r.method === 'PATCH')!
			expect(patch.body.reason).toBe('Forgot to clock out')
			expect(patch.body.expectedVersion).toBe(4)
			await page.screenshot({ path: `${SCREENSHOTS}/review-desktop.png` })
		} finally {
			await dropFlags(flags)
		}
	})

	test('approves every ready card after a confirmation', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		const { requests } = await stubTimesheetApi(page, scopeId)
		try {
			await navigate('/:slug/staff/timeclock/timesheets', { slug: org.slug })
			await page.getByRole('button', { name: /Approve 2 ready cards/ }).click()
			const dialog = page.getByRole('alertdialog')
			await expect(dialog).toContainText('frozen as shown')
			await dialog.getByRole('button', { name: 'Approve' }).click()
			await expect
				.poll(() => requests.some((r) => r.path === '/timesheets/approve'))
				.toBe(true)
			const post = requests.find((r) => r.path === '/timesheets/approve')!
			expect(post.body.entries.map((e: any) => e.id).sort()).toEqual([
				'c1',
				'c2',
			])
		} finally {
			await dropFlags(flags)
		}
	})

	test('a card opens in a sheet by its own link and needs a reason to save', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		const { requests } = await stubTimesheetApi(page, scopeId)
		try {
			await navigate('/:slug/staff/timeclock/timesheets/:id', {
				slug: org.slug,
				id: 'c1',
			})
			const sheet = page.getByRole('dialog')
			await expect(
				sheet.getByRole('heading', { name: 'Noor Alharbi' }),
			).toBeVisible()
			await sheet.getByLabel('Clock out').fill('17:30')
			await sheet.getByRole('button', { name: 'Save changes' }).click()
			await expect(sheet.getByText(/Say what changed and why/)).toBeVisible()
			expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
			await sheet.getByRole('button', { name: 'Wrong time entered' }).click()
			await sheet.getByRole('button', { name: 'Save changes' }).click()
			await expect
				.poll(() => requests.some((r) => r.method === 'PATCH'))
				.toBe(true)
			await page.screenshot({ path: `${SCREENSHOTS}/card-sheet.png` })
		} finally {
			await dropFlags(flags)
		}
	})

	test('on a phone the table becomes stacked cards without sideways scrolling', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableTimeclock(org.id)
		await stubTimesheetApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 360, height: 740 })
			await navigate('/:slug/staff/timeclock/timesheets', { slug: org.slug })
			await expect(
				page.getByRole('region', { name: /Noor Alharbi/ }),
			).toBeVisible()
			await expect(page.getByRole('table')).toHaveCount(0)
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
			await page.screenshot({ path: `${SCREENSHOTS}/period-mobile.png` })
		} finally {
			await dropFlags(flags)
		}
	})
})
