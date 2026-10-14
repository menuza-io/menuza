import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq } from '@repo/database'
import { DEFAULT_SCOPE_ID, STAFFING_FLAG_KEYS } from '@repo/staffing'
import { DEMO_POSITIONS, DEMO_STAFF } from '@repo/staffing/demo-roster'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Roster flow with the Staff module on. The regional tenant-api is not part of
 * this test environment, so its `/operator/staff` endpoints are stubbed in the
 * browser; the App's own routes (flag check, token mint, loaders, UI) are real.
 * The stub is deliberately small: it mirrors the response shapes the UI parses.
 */

const SCREENSHOTS = 'test-results/staff'
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

type StubRequest = { method: string; path: string; body: unknown }

async function stubStaffApi(page: Page, scopeId: string) {
	const requests: StubRequest[] = []
	const positions = DEMO_POSITIONS.map((position, index) => ({
		id: `pos-${index}`,
		name: position.name,
		nameAr: position.nameAr ?? null,
		area: position.area ?? null,
		colorKey: position.colorKey,
		tipEligible: position.tipEligible,
		archivedAt: null,
		defaultRateMinor: position.defaultRateMinor,
		currency: 'USD',
	}))
	const byName = new Map(positions.map((position) => [position.name, position]))

	function assignment(staffId: string, index: number) {
		return {
			id: `asg-${index}`,
			staffId,
			scopeId,
			isPrimary: true,
			showInSchedule: true,
			eligibleOpenShifts: true,
			includeInClockErrors: true,
			canWaiveBreaks: false,
			active: true,
			hasPin: false,
			pinSetAt: null,
		}
	}
	function person(input: {
		id: string
		firstName: string
		lastName: string
		email?: string | null
		phone?: string | null
	}) {
		return {
			id: input.id,
			status: 'active',
			workerType: 'employee',
			firstName: input.firstName,
			lastName: input.lastName,
			firstNameAr: null,
			lastNameAr: null,
			email: input.email ?? null,
			phone: input.phone ?? null,
			userId: null,
			employeeNumber: null,
			locale: 'en',
			hiredDate: null,
			terminatedAt: null,
			terminationReason: null,
			eligibleForRehire: null,
			primaryScopeId: scopeId,
			createdAt: 1,
			updatedAt: 1,
		}
	}

	const roster = DEMO_STAFF.map((demo, index) => {
		const id = `staff-${index}`
		const main = byName.get(demo.positions[0]!)!
		return {
			...person({ id, ...demo }),
			assignments: [assignment(id, index)],
			positionIds: demo.positions.map((name) => byName.get(name)!.id),
			currentRate: {
				payType: 'hourly',
				rateMinor: demo.rateMinor ?? main.defaultRateMinor,
				annualSalaryMinor: null,
				currency: 'USD',
			},
		}
	})

	await page.route('**/operator/staff**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace(/^.*\/operator\/staff/, '') || '/'
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path, body })
		const json = (data: unknown, status = 200) =>
			route.fulfill({
				status,
				headers: { ...CORS, 'content-type': 'application/json' },
				body: JSON.stringify(data),
			})

		if (method === 'GET' && path === '/') {
			const q = (url.searchParams.get('q') ?? '').toLowerCase()
			const rows = roster.filter((row) =>
				`${row.firstName} ${row.lastName} ${row.email ?? ''}`
					.toLowerCase()
					.includes(q),
			)
			return json({ staff: rows, total: rows.length, limit: 50, offset: 0 })
		}
		if (method === 'GET' && path === '/positions') return json({ positions })
		if (method === 'POST' && path === '/') {
			const input = body as {
				firstName: string
				lastName: string
				phone?: string
				email?: string
			}
			const id = `staff-new-${roster.length}`
			const created = person({ id, ...input })
			roster.push({
				...created,
				assignments: [assignment(id, 99)],
				positionIds: [],
				currentRate: null as never,
			})
			return json(
				{ created: true, staff: created, assignments: [assignment(id, 99)] },
				201,
			)
		}
		const detail = path.match(/^\/([^/]+)$/)
		if (method === 'GET' && detail) {
			const row = roster.find((item) => item.id === detail[1])
			if (!row) return json({ error: 'Staff member not found' }, 404)
			const { assignments, positionIds, currentRate, ...staff } = row
			void positionIds
			void currentRate
			return json({
				staff,
				assignments,
				jobs: [],
				restricted: { pay: false, private: false },
			})
		}
		if (method === 'GET' && /\/notes$/.test(path)) return json({ notes: [] })
		const pin = path.match(/^\/([^/]+)\/assignments\/([^/]+)\/pin$/)
		if (method === 'POST' && pin) {
			return json(
				{ pin: '4821', assignmentId: pin[2], pinSetAt: Date.now() },
				201,
			)
		}
		return json({ error: 'Not found' }, 404)
	})
	return { requests }
}

async function enableStaffing(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	return row!.id
}

test.describe('Staff roster', () => {
	test('is not found while the module is off', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/team', { slug: org.slug })
		expect(response?.status()).toBe(404)
		await expect(page.getByRole('button', { name: 'Add staff' })).toHaveCount(0)
	})

	test('a manager finds people, adds one, and sees a PIN only once', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const flagId = await enableStaffing(org.id)
		const api = await stubStaffApi(page, DEFAULT_SCOPE_ID)

		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/team', { slug: org.slug })

			// The roster: a table with a pay column (this admin's token carries it).
			await expect(
				page.getByRole('heading', { name: 'Team', exact: true }),
			).toBeVisible()
			await expect(
				page.getByRole('link', { name: 'Maya Okafor' }),
			).toBeVisible()
			await expect(
				page.getByRole('columnheader', { name: 'Pay' }),
			).toBeVisible()
			await expect(page.getByText('$28.00/h').first()).toBeVisible()
			// With everyone on screen and no filter, the count is not repeated.
			await expect(page.getByText('Showing 12 of 12')).toHaveCount(0)
			await page.screenshot({ path: `${SCREENSHOTS}/roster-desktop.png` })

			// Search narrows the list and can be cleared.
			await page.getByRole('searchbox', { name: 'Search team' }).fill('noor')
			await expect(
				page.getByRole('link', { name: 'Noor Alharbi' }),
			).toBeVisible()
			await expect(page.getByRole('link', { name: 'Maya Okafor' })).toHaveCount(
				0,
			)
			await page.getByRole('searchbox', { name: 'Search team' }).fill('')
			await expect(
				page.getByRole('link', { name: 'Maya Okafor' }),
			).toBeVisible()

			// Add staff: inline validation first, then a real save.
			await page.getByRole('button', { name: 'Add staff' }).click()
			const dialog = page.getByRole('dialog')
			await expect(
				dialog.getByText('Name, plus a phone number or an email.'),
			).toBeVisible()
			await dialog.getByRole('button', { name: 'Add staff' }).click()
			await expect(dialog.getByText('Enter a first name.')).toBeVisible()
			await expect(
				dialog.getByText('Add a phone number or an email.'),
			).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/add-staff-errors.png` })
			await dialog.getByLabel('First name').fill('Ines')
			await dialog.getByLabel('Last name').fill('Duarte')
			await dialog.getByLabel('Phone').fill('+14155550199')
			await dialog.getByRole('button', { name: 'Add staff' }).click()

			// Lands on the new profile; the POST carried exactly what was typed.
			// The profile is a page of its own, not a drawer over the roster.
			await expect(
				page.getByRole('heading', { name: 'Ines Duarte', level: 1 }),
			).toBeVisible()
			const created = api.requests.find(
				(request) => request.method === 'POST' && request.path === '/',
			)
			expect(created?.body).toMatchObject({
				firstName: 'Ines',
				lastName: 'Duarte',
				phone: '+14155550199',
				assignments: [{ scopeId: DEFAULT_SCOPE_ID, isPrimary: true }],
			})
			await page.screenshot({ path: `${SCREENSHOTS}/profile-details.png` })

			// A PIN is shown once, with the warning, and is gone after Done.
			await page.getByRole('link', { name: 'Access and PIN' }).click()
			await page.getByRole('button', { name: 'Create PIN' }).click()
			await expect(page.getByRole('status', { name: 'New PIN' })).toHaveText(
				'4821',
			)
			await expect(page.getByText(/cannot be looked up later/)).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/pin-once.png` })
			await page.getByRole('button', { name: 'Done' }).click()
			await expect(page.getByText('4821')).toHaveCount(0)

			// Terminate is two steps and sends nothing until the last button.
			await page.getByRole('button', { name: /More actions for/ }).click()
			await page.getByRole('menuitem', { name: /Terminate/ }).click()
			const terminate = page.getByRole('dialog', {
				name: /Terminate Ines Duarte/,
			})
			await terminate.getByLabel('Reason').fill('Moved away')
			await terminate.getByRole('button', { name: 'Continue' }).click()
			await expect(
				page.getByRole('dialog', { name: 'Terminate Ines Duarte?' }),
			).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/terminate-confirm.png` })
			expect(
				api.requests.some((request) => request.path.endsWith('/terminate')),
			).toBe(false)
		} finally {
			await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flagId))
		}
	})

	test('collapses to a stacked list at phone width without sideways scrolling', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const flagId = await enableStaffing(org.id)
		await stubStaffApi(page, DEFAULT_SCOPE_ID)

		try {
			await page.setViewportSize({ width: 360, height: 740 })
			await navigate('/:slug/staff/team', { slug: org.slug })
			await expect(
				page.getByRole('link', { name: /Maya Okafor/ }),
			).toBeVisible()
			await expect(page.getByRole('table')).toBeHidden()
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
			await page.screenshot({ path: `${SCREENSHOTS}/roster-mobile.png` })
		} finally {
			await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flagId))
		}
	})
	test.describe('in Arabic', () => {
		test.use({ locale: 'ar-SA' })

		test('mirrors the roster and its sheet for right-to-left reading', async ({
			page,
			login,
			navigate,
		}) => {
			const user = await login()
			const org = await createTestOrganization(user.id, 'admin')
			const flagId = await enableStaffing(org.id)
			await stubStaffApi(page, DEFAULT_SCOPE_ID)

			try {
				await page.setViewportSize({ width: 1280, height: 800 })
				await navigate('/:slug/staff/team', { slug: org.slug })
				await expect
					.poll(() => page.evaluate(() => document.documentElement.dir))
					.toBe('rtl')
				await expect(
					page.getByRole('heading', { name: 'الفريق', exact: true }),
				).toBeVisible()
				await expect(
					page.getByRole('link', { name: 'Maya Okafor' }),
				).toBeVisible()
				await page.screenshot({ path: `${SCREENSHOTS}/roster-rtl.png` })

				await page.getByRole('button', { name: 'إضافة موظف' }).click()
				await expect(page.getByRole('dialog')).toBeVisible()
				// In right-to-left reading the sheet docks to the left edge.
				await expect
					.poll(async () => (await page.getByRole('dialog').boundingBox())?.x)
					.toBe(0)
				await page.screenshot({ path: `${SCREENSHOTS}/add-staff-rtl.png` })
			} finally {
				await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flagId))
			}
		})
	})
})
