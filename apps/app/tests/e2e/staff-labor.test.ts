import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq } from '@repo/database'
import { DEFAULT_SCOPE_ID, STAFFING_FLAG_KEYS } from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Labor (flag `staffing.labor`): the labor summary with its sales source, the
 * sales a manager enters, and the settings behind them. The regional tenant-api
 * is not part of this test environment, so `/operator/labor` is stubbed in the
 * browser with the response shapes the screens parse; the App's own routes
 * (flags, token mint, loaders, UI) are real. Run against the `CI=true` mocked
 * build, like the other manager specs.
 */

const SCREENSHOTS = 'test-results/staff-labor'
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

type StubRequest = { method: string; path: string; body: any }

async function enableLabor(organizationId: string) {
	const ids: string[] = []
	for (const feature of ['enabled', 'labor'] as const) {
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

async function stubLaborApi(page: Page, scopeId: string) {
	const requests: StubRequest[] = []
	let source: 'online_orders' | 'manual' = 'online_orders'
	const today = new Date().toISOString().slice(0, 10)
	const summary = () => {
		const complete = source === 'manual'
		const money = {
			currency: 'USD',
			costMinor: 16_000,
			salesMinor: 64_000,
			laborBp: 2500,
			salesPerLaborHourMinor: 8000,
			...(complete ? { targetStatus: 'over' } : {}),
		}
		return {
			estimate: true,
			scopeId,
			timeZone: 'UTC',
			from: today,
			to: today,
			salesSource: source,
			salesComplete: complete,
			targetBp: 2000,
			targetColoring: complete,
			days: [
				{
					date: today,
					paidMinutes: 480,
					overtimeMinutes: 0,
					cards: 1,
					people: 1,
					hasSales: true,
					money: [money],
				},
			],
			totals: {
				paidMinutes: 480,
				overtimeMinutes: 0,
				cards: 1,
				salesDays: 1,
				daysWithoutSales: 0,
				money: [money],
			},
			currencyMismatch: null,
			unpricedMinutes: 0,
			openCards: 0,
			truncated: false,
		}
	}
	await page.route('**/operator/labor/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace(/^.*\/operator\/labor/, '') || '/'
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path, body })
		if (method === 'GET' && path === '/summary') return json(route, summary())
		if (method === 'GET' && path === '/settings') {
			return json(route, {
				scopeId,
				salesSource: source,
				ordersPerLaborHour: {},
				configured: true,
				updatedAt: 1,
			})
		}
		if (method === 'PUT' && path === '/settings') {
			source = body.salesSource ?? source
			return json(route, {
				scopeId,
				salesSource: source,
				ordersPerLaborHour: body.ordersPerLaborHour ?? {},
				configured: true,
				updatedAt: 2,
			})
		}
		if (method === 'GET' && path === '/positions') {
			return json(route, {
				positions: [{ id: 'p1', name: 'Cook', nameAr: null }],
			})
		}
		return json(route, { error: 'Not found' }, 404)
	})
	return { requests }
}

async function createOrgWithScope(userId: string) {
	const org = await createTestOrganization(userId, 'admin')
	return { org, scopeId: DEFAULT_SCOPE_ID }
}

test.describe('Labor (manager)', () => {
	test('is not found while the labor flag is off', async ({
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/labor', { slug: org.slug })
		expect(response?.status()).toBe(404)
	})

	test('names the sales source and judges nothing until the sales are complete', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableLabor(org.id)
		const { requests } = await stubLaborApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/labor', { slug: org.slug })
			await expect(page.getByText(/Sales: Online orders only\./)).toBeVisible()
			await expect(page.getByText(/not applied/)).toBeVisible()
			await expect(page.getByText(/over target/)).toHaveCount(0)
			await page.screenshot({ path: `${SCREENSHOTS}/overview-desktop.png` })

			// Switch to entered sales in the settings: now the share is judged.
			await page.getByRole('button', { name: 'Change' }).click()
			await page.getByRole('radio', { name: /Sales I enter/ }).click()
			await page.getByRole('button', { name: 'Save' }).click()
			await expect
				.poll(() => requests.some((r) => r.method === 'PUT'))
				.toBe(true)
			expect(requests.find((r) => r.method === 'PUT')!.body).toMatchObject({
				scopeId,
				salesSource: 'manual',
			})
			await page.getByRole('button', { name: 'Overview' }).click()
			await expect(page.getByText(/Sales: Entered sales\./)).toBeVisible()
			await expect(page.getByText(/over target/).first()).toBeAttached()
		} finally {
			await dropFlags(flags)
		}
	})

	test('stays usable on a phone', async ({ page, login, navigate }) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithScope(user.id)
		const flags = await enableLabor(org.id)
		await stubLaborApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 360, height: 740 })
			await navigate('/:slug/staff/labor', { slug: org.slug })
			await expect(page.getByText(/Sales: Online orders only\./)).toBeVisible()
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth >
					document.documentElement.clientWidth,
			)
			expect(overflow).toBe(false)
			await page.screenshot({ path: `${SCREENSHOTS}/overview-phone.png` })
		} finally {
			await dropFlags(flags)
		}
	})
})
