import { type Page, type Route } from '@playwright/test'
import { QR_ORDERING_FLAG_KEYS } from '@repo/common/qr-ordering'
import { ConfigFlag, db, OrganizationLocation } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
}

type QrTableRow = {
	id: string
	locationId: string
	label: string
	tokenVersion: number
	token: string | null
	importedRsvTableId: string | null
	archivedAt: string | null
	openTabId: string | null
}

async function enableQrOrdering(organizationId: string) {
	await db.insert(ConfigFlag).values([
		{
			key: QR_ORDERING_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		},
		{
			key: QR_ORDERING_FLAG_KEYS.dineIn,
			value: true,
			level: 'organization',
			organizationId,
		},
	])
}

async function createLocation(organizationId: string) {
	const id = `loc_${Math.random().toString(36).slice(2, 10)}`
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			id,
			organizationId,
			name: 'Main Dining',
			slug: `main-${id}`,
			timezone: 'America/New_York',
			isActive: true,
		})
		.returning()
	return location!
}

function json(route: Route, data: unknown, status = 200) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json' },
		body: JSON.stringify(data),
	})
}

/**
 * Stands in for the regional `/operator/qr/tables*` routes. The browser calls
 * tenant-api directly, so the stub sees exactly what App sends there.
 */
async function stubTablesApi(page: Page, locationId: string) {
	const requests: Array<{ method: string; path: string; body: unknown }> = []
	let tables: QrTableRow[] = []
	await page.route('**/operator/qr/tables**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace(/^.*\/operator\/qr/, '')
		const body = request.postDataJSON() as Record<string, unknown> | null
		requests.push({ method: request.method(), path, body })

		if (request.method() === 'GET' && path === '/tables') {
			return json(route, { tables })
		}
		if (request.method() === 'POST' && path === '/tables/bulk') {
			const labels = (body?.labels ?? []) as string[]
			tables = [
				...tables,
				...labels.map((label, index) => ({
					id: `qt_${tables.length + index + 1}`,
					locationId,
					label,
					tokenVersion: 1,
					token: `code-${label}`,
					importedRsvTableId: null,
					archivedAt: null,
					openTabId: null,
				})),
			]
			return json(route, { tables })
		}
		const patch = path.match(/^\/tables\/([^/]+)$/)
		if (request.method() === 'PATCH' && patch) {
			const id = patch[1]
			tables = tables.flatMap((table) => {
				if (table.id !== id) return [table]
				if (body?.archived) return []
				if (body?.regenerateToken) {
					return [{ ...table, tokenVersion: table.tokenVersion + 1 }]
				}
				return [{ ...table, label: String(body?.label ?? table.label) }]
			})
			return json(route, { table: tables.find((t) => t.id === id) ?? null })
		}
		return json(route, { error: 'not_found' }, 404)
	})
	return requests
}

test.describe('QR tables', () => {
	test('stay hidden until QR ordering is on for the organization', async ({
		page,
		login,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		const response = await page.goto(`/${org.slug}/qr/tables`)
		expect(response?.status()).toBe(404)
		const token = await page.request.get(`/${org.slug}/qr-token`)
		expect(token.status()).toBe(404)
	})

	test('operators add a range, make a new code and archive a table', async ({
		page,
		login,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		await enableQrOrdering(org.id)
		const location = await createLocation(org.id)
		const requests = await stubTablesApi(page, location.id)

		await page.goto(`/${org.slug}/qr/tables`)
		await expect(
			page.getByRole('heading', { name: 'QR tables', level: 1 }),
		).toBeVisible()
		await expect(page.getByText('No tables yet')).toBeVisible()

		const add = page.getByLabel('Add tables')
		await add.fill('T3-T1')
		await expect(
			page.getByText('A range counts up, like T1-T12.'),
		).toBeVisible()

		await add.fill('T1-T3')
		// Labels are wrapped in direction isolates (FSI/PDI) for RTL safety.
		await expect(
			page.getByText(/Adds 3 tables: .?T1.? to .?T3.?\./),
		).toBeVisible()
		await page.getByRole('button', { name: 'Add', exact: true }).click()
		await expect(page.getByText('Added 3 tables')).toBeVisible()
		await expect(add).toHaveValue('')
		expect(
			requests.find((r) => r.method === 'POST' && r.path === '/tables/bulk')
				?.body,
		).toEqual({ locationId: location.id, labels: ['T1', 'T2', 'T3'] })
		for (const label of ['T1', 'T2', 'T3']) {
			await expect(
				page.getByRole('button', { name: `Rename, table ${label}` }),
			).toBeVisible()
		}

		await page.getByRole('button', { name: 'New QR code, table T2' }).click()
		const regenerate = page.getByRole('alertdialog')
		await expect(
			regenerate.getByText('Make a new QR code for this table?'),
		).toBeVisible()
		await regenerate.getByRole('button', { name: 'Make a new code' }).click()
		await expect(
			page.getByText('New QR code made. Print and replace the old card.'),
		).toBeVisible()
		expect(
			requests.find((r) => r.method === 'PATCH' && r.path === '/tables/qt_2')
				?.body,
		).toEqual({ regenerateToken: true })

		await page.getByRole('button', { name: 'Archive, table T3' }).click()
		const archive = page.getByRole('alertdialog')
		await expect(archive.getByText('Archive table T3?')).toBeVisible()
		await archive.getByRole('button', { name: 'Archive table' }).click()
		await expect(page.getByText('Table archived')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Rename, table T3' }),
		).toHaveCount(0)
		await expect(page.getByLabel('Add tables')).toBeFocused()
	})
})
