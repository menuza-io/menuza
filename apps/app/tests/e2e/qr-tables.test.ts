import { type Page, type Route } from '@playwright/test'
import { PRINT_SHOP_FLAG_KEYS } from '@repo/common/print-shop'
import {
	QR_ORDERING_FLAG_KEYS,
	QR_PER_TABLE_LIMIT_MAX,
} from '@repo/common/qr-ordering'
import { ConfigFlag, db, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
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

type StubRequest = {
	method: string
	path: string
	search: string
	body: Record<string, unknown> | null
	authorization: string | null
}

type Role = 'admin' | 'member' | 'viewer' | 'guest'

async function setFlags(organizationId: string, keys: string[]) {
	if (keys.length === 0) return
	await db.insert(ConfigFlag).values(
		keys.map((key) => ({
			key,
			value: true,
			level: 'organization' as const,
			organizationId,
		})),
	)
}

const QR_ON = [QR_ORDERING_FLAG_KEYS.enabled, QR_ORDERING_FLAG_KEYS.dineIn]

async function createLocation(organizationId: string, name = 'Main Dining') {
	const id = `loc_${Math.random().toString(36).slice(2, 10)}`
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			id,
			organizationId,
			name,
			slug: `loc-${id}`,
			timezone: 'America/New_York',
			isActive: true,
		})
		.returning()
	return location!
}

function table(
	locationId: string,
	id: string,
	label: string,
	extra: Partial<QrTableRow> = {},
): QrTableRow {
	return {
		id,
		locationId,
		label,
		tokenVersion: 1,
		token: `code-${id}`,
		importedRsvTableId: null,
		archivedAt: null,
		openTabId: null,
		...extra,
	}
}

function json(route: Route, data: unknown, status = 200) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json' },
		body: JSON.stringify(data),
	})
}

type StubOptions = {
	tables?: QrTableRow[]
	/** Answers instead of the default handler; `undefined` falls through. */
	override?: (request: StubRequest) => { status: number; body: unknown } | void
}

/**
 * Stands in for the regional `/operator/qr/*` routes. The browser calls
 * tenant-api directly, so the stub sees exactly what App sends there.
 */
async function stubQrApi(page: Page, options: StubOptions = {}) {
	const requests: StubRequest[] = []
	let tables = [...(options.tables ?? [])]
	let settings = {
		requireGuestName: true,
		requireGuestPhone: false,
		allowOnlineTabPay: false,
		perTableLimitPerHour: 30,
	}
	await page.route('**/operator/qr/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const entry: StubRequest = {
			method: request.method(),
			path: url.pathname.replace(/^.*\/operator\/qr/, ''),
			search: url.search,
			body: request.postDataJSON() as Record<string, unknown> | null,
			authorization: request.headers()['authorization'] ?? null,
		}
		requests.push(entry)
		const answer = options.override?.(entry)
		if (answer) return json(route, answer.body, answer.status)

		const { method, path, body } = entry
		if (method === 'GET' && path === '/tables') {
			const locationId = url.searchParams.get('locationId')
			return json(route, {
				tables: tables.filter((row) => row.locationId === locationId),
			})
		}
		if (method === 'POST' && path === '/tables/bulk') {
			const labels = (body?.labels ?? []) as string[]
			tables = [
				...tables,
				...labels.map((label, index) =>
					table(
						String(body?.locationId),
						`qt_${tables.length + index + 1}`,
						label,
					),
				),
			]
			return json(route, { tables })
		}
		if (method === 'POST' && path === '/tables/import-floor-plan') {
			tables = [
				...tables,
				table(String(body?.locationId), 'qt_fp', 'Booth 4', {
					importedRsvTableId: 'rsv_t4',
				}),
			]
			return json(route, { created: 1, updated: 0 })
		}
		const patch = path.match(/^\/tables\/([^/]+)$/)
		if (method === 'PATCH' && patch) {
			const id = patch[1]
			tables = tables.flatMap((row) => {
				if (row.id !== id) return [row]
				if (body?.archived) return []
				if (body?.regenerateToken) {
					return [{ ...row, tokenVersion: row.tokenVersion + 1 }]
				}
				return [{ ...row, label: String(body?.label ?? row.label) }]
			})
			return json(route, { table: tables.find((row) => row.id === id) ?? null })
		}
		if (path === '/settings') {
			if (method === 'PATCH') settings = { ...settings, ...body }
			return json(route, { settings })
		}
		return json(route, { error: 'not_found' }, 404)
	})
	return requests
}

async function setup(
	login: (options?: any) => Promise<{ id: string }>,
	options: { role?: Role; flags?: string[]; locations?: string[] } = {},
) {
	const user = await login()
	const org = await createTestOrganization(user.id, options.role ?? 'admin')
	await setFlags(org.id, options.flags ?? QR_ON)
	const locations = []
	for (const name of options.locations ?? ['Main Dining']) {
		locations.push(await createLocation(org.id, name))
	}
	return { user, org, locations }
}

const addField = (page: Page) => page.getByLabel('Add tables')
const addButton = (page: Page) =>
	page.getByRole('button', { name: 'Add', exact: true })

test.describe('QR tables: access', () => {
	test('every QR page and the token stay hidden while QR ordering is off', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: [] })
		for (const path of ['qr', 'qr/tables', 'qr/settings', 'qr-token']) {
			const response = await page.request.get(`/${org.slug}/${path}`)
			expect(response.status(), path).toBe(404)
		}
		await page.goto(`/${org.slug}`)
		await expect(page.locator(`a[href^="/${org.slug}/qr/"]`)).toHaveCount(0)
	})

	test('the dine-in flag alone does not turn QR ordering on', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, {
			flags: [QR_ORDERING_FLAG_KEYS.dineIn],
		})
		const response = await page.goto(`/${org.slug}/qr/tables`)
		expect(response?.status()).toBe(404)
	})

	test('the QR index sends operators to the tables page', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr`)
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/qr/tables$`))
		await expect(
			page.locator(`a[href="/${org.slug}/qr/tables"]`).first(),
		).toBeAttached()
	})

	test('tables can be set up before ordering at the table is on', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, {
			flags: [QR_ORDERING_FLAG_KEYS.enabled],
		})
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(
			page.getByText(
				'Set up your tables now. Ordering at the table turns on when it is enabled for your organization.',
			),
		).toBeVisible()
		await expect(addField(page)).toBeVisible()
	})

	test('an organization without a location is asked to add one first', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { locations: [] })
		const requests = await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(
			page.getByText('Add a location before you add tables.'),
		).toBeVisible()
		await expect(addField(page)).toHaveCount(0)
		expect(requests).toHaveLength(0)
	})

	test('a guest without menu access is refused', async ({ page, login }) => {
		const { org } = await setup(login, { role: 'guest' })
		for (const path of ['qr/tables', 'qr/settings', 'qr-token']) {
			const response = await page.request.get(`/${org.slug}/${path}`)
			expect(response.status(), path).toBe(403)
		}
	})

	test('a member sees the tables but cannot change them', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login, { role: 'member' })
		const requests = await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'T1')],
		})

		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('T1', { exact: true })).toBeVisible()
		await expect(addField(page)).toHaveCount(0)
		for (const name of ['Rename, table T1', 'New QR code, table T1']) {
			await expect(page.getByRole('button', { name })).toHaveCount(0)
		}
		await expect(page.getByRole('button', { name: /^Archive/ })).toHaveCount(0)
		// Members cannot design prints either.
		await expect(page.getByText('Print table cards')).toHaveCount(0)

		const write = await page.request.get(`/${org.slug}/qr-token?write=1`)
		expect(write.status()).toBe(403)
		const read = await page.request.get(`/${org.slug}/qr-token`)
		expect(read.status()).toBe(200)
		expect(read.headers()['cache-control']).toContain('no-store')
		expect(requests.every((r) => r.method === 'GET')).toBe(true)
	})
})

test.describe('QR tables: adding tables', () => {
	test('the label field explains, previews and refuses what it cannot add', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		const requests = await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('No tables yet')).toBeVisible()

		const field = addField(page)
		await expect(
			page.getByText(
				'Type one label, a range like T1-T12, or a list separated by commas.',
			),
		).toBeVisible()
		await expect(addButton(page)).toBeDisabled()

		await field.fill('Patio 1')
		await expect(page.getByText(/^Adds table .?Patio 1.?\.$/)).toBeVisible()

		await field.fill('A, B, C')
		await expect(
			page.getByText(/^Adds 3 tables: .?A.?, .?B.?, and .?C.?\.$/),
		).toBeVisible()

		await field.fill('A, B, C, D, E, F')
		await expect(page.getByText('Adds 6 tables.')).toBeVisible()

		await field.fill('T12-T1')
		await expect(
			page.getByText('A range counts up, like T1-T12.'),
		).toBeVisible()
		await expect(field).toHaveAttribute('aria-invalid', 'true')
		await expect(field).toHaveAttribute(
			'aria-describedby',
			'qr-new-tables-error',
		)

		await field.fill('T1-T201')
		await expect(
			page.getByText('A range can add at most 200 tables at once.'),
		).toBeVisible()

		// Two ranges under the field's 600-character cap.
		await field.fill('A1-A150, B1-B60')
		await expect(
			page.getByText('Add at most 200 tables at once.'),
		).toBeVisible()

		await field.fill('   ')
		await expect(addButton(page)).toBeDisabled()
		expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0)
	})

	test('a range is added in order and the field clears', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		const requests = await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		// Typing before hydration would be lost: wait for the list first.
		await expect(page.getByText('No tables yet')).toBeVisible()
		await addField(page).fill('T1-T3')
		// Labels are wrapped in direction isolates (FSI/PDI) for RTL safety.
		await expect(
			page.getByText(/Adds 3 tables: .?T1.? to .?T3.?\./),
		).toBeVisible()
		await addField(page).press('Enter')
		await expect(page.getByText('Added 3 tables')).toBeVisible()
		await expect(addField(page)).toHaveValue('')
		const bulk = requests.find(
			(r) => r.method === 'POST' && r.path === '/tables/bulk',
		)
		expect(bulk?.body).toEqual({
			locationId: locations[0]!.id,
			labels: ['T1', 'T2', 'T3'],
		})
		// Writes use the write token, minted separately from the read one.
		expect(bulk?.authorization).toMatch(/^Bearer \S+/)
		for (const label of ['T1', 'T2', 'T3']) {
			await expect(
				page.getByRole('button', { name: `Rename, table ${label}` }),
			).toBeVisible()
		}
	})

	test('a refused add keeps what was typed and shows the reason', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await stubQrApi(page, {
			override: (request) =>
				request.method === 'POST'
					? {
							status: 409,
							body: {
								error: 'duplicate_label',
								message: 'A table already has that label.',
							},
						}
					: undefined,
		})
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('No tables yet')).toBeVisible()
		await addField(page).fill('T1')
		await addButton(page).click()
		await expect(
			page.getByText('A table already has that label.'),
		).toBeVisible()
		await expect(addField(page)).toHaveValue('T1')
	})

	test('a failed load says so instead of showing an empty list', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await stubQrApi(page, {
			override: (request) =>
				request.method === 'GET'
					? { status: 500, body: { error: 'internal' } }
					: undefined,
		})
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByRole('alert')).toContainText(
			'Unable to load tables. Try again.',
		)
		await expect(page.getByText('No tables yet')).toHaveCount(0)
	})

	test('an expired token is replaced once and the request retried', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		let refused = false
		const requests = await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'T1')],
			override: () => {
				if (refused) return
				refused = true
				return { status: 401, body: { error: 'unauthorized' } }
			},
		})
		const minted: string[] = []
		page.on('request', (request) => {
			if (request.url().includes('/qr-token')) minted.push(request.url())
		})
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('T1', { exact: true })).toBeVisible()
		expect(requests.filter((r) => r.path === '/tables')).toHaveLength(2)
		expect(minted.length).toBeGreaterThanOrEqual(2)
	})
})

test.describe('QR tables: changing tables', () => {
	test('rename saves, cancel restores, and focus comes back', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		const requests = await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'T1')],
		})
		await page.goto(`/${org.slug}/qr/tables`)

		const rename = page.getByRole('button', { name: 'Rename, table T1' })
		await rename.click()
		const input = page.getByLabel('Table label')
		await expect(input).toBeFocused()
		await input.fill('Changed')
		await page.getByRole('button', { name: 'Cancel', exact: true }).click()
		await expect(rename).toBeFocused()
		await expect(page.getByText('T1', { exact: true })).toBeVisible()

		await rename.click()
		await input.fill('  ')
		await expect(
			page.getByRole('button', { name: 'Save', exact: true }),
		).toBeDisabled()
		await input.fill('  Window 1 ')
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await expect(page.getByText('Table renamed')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Rename, table Window 1' }),
		).toBeFocused()
		expect(
			requests.filter((r) => r.method === 'PATCH').map((r) => r.body),
		).toEqual([{ label: 'Window 1' }])
	})

	test('a new QR code is only made after confirming', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		const requests = await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'T1')],
		})
		await page.goto(`/${org.slug}/qr/tables`)

		const trigger = page.getByRole('button', { name: 'New QR code, table T1' })
		await trigger.click()
		const dialog = page.getByRole('alertdialog')
		await expect(
			dialog.getByText(
				'Every printed card for this table stops working right away, including cards you ordered. Print the new card before you replace the old one.',
			),
		).toBeVisible()
		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await expect(dialog).toBeHidden()
		await expect(trigger).toBeFocused()
		expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)

		await trigger.click()
		await page.keyboard.press('Escape')
		await expect(page.getByRole('alertdialog')).toBeHidden()
		expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)

		await trigger.click()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Make a new code' })
			.click()
		await expect(page.getByRole('alertdialog')).toBeHidden()
		await expect(
			page.getByText('New QR code made. Print and replace the old card.'),
		).toBeVisible()
		expect(
			requests.filter((r) => r.method === 'PATCH').map((r) => r.body),
		).toEqual([{ regenerateToken: true }])
	})

	test('archiving removes the row and returns focus to the add field', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		const requests = await stubQrApi(page, {
			tables: [
				table(locations[0]!.id, 'qt_1', 'T1'),
				table(locations[0]!.id, 'qt_2', 'T2'),
			],
		})
		await page.goto(`/${org.slug}/qr/tables`)

		await page.getByRole('button', { name: 'Archive, table T2' }).click()
		const dialog = page.getByRole('alertdialog')
		await expect(dialog.getByText('Archive table T2?')).toBeVisible()
		await expect(
			dialog.getByText(
				'Its QR code stops taking orders. Past tabs keep their history.',
			),
		).toBeVisible()
		await dialog.getByRole('button', { name: 'Archive table' }).click()
		await expect(page.getByText('Table archived')).toBeVisible()
		await expect(page.getByRole('alertdialog')).toBeHidden()
		await expect(
			page.getByRole('button', { name: 'Rename, table T2' }),
		).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: 'Rename, table T1' }),
		).toBeVisible()
		await expect(addField(page)).toBeFocused()
		expect(
			requests.find((r) => r.method === 'PATCH' && r.path === '/tables/qt_2')
				?.body,
		).toEqual({ archived: true })
	})

	test('a failed archive keeps the table and says so', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'T1')],
			override: (request) =>
				request.method === 'PATCH'
					? {
							status: 409,
							body: {
								error: 'tab_open',
								message: 'Close the open tab before archiving.',
							},
						}
					: undefined,
		})
		await page.goto(`/${org.slug}/qr/tables`)
		await page.getByRole('button', { name: 'Archive, table T1' }).click()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Archive table' })
			.click()
		await expect(
			page.getByText('Close the open tab before archiving.'),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Rename, table T1' }),
		).toBeVisible()
	})

	test('a table with an open tab cannot be archived', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'T1', { openTabId: 'tab_1' })],
		})
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('Tab open')).toBeVisible()
		await expect(
			page.getByText('Close the open tab before archiving.'),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Archive, table T1' }),
		).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: 'New QR code, table T1' }),
		).toBeVisible()
	})

	test('labels keep their direction in a right-to-left page', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		await stubQrApi(page, {
			tables: [table(locations[0]!.id, 'qt_1', 'طاولة 1')],
		})
		await page.goto(`/${org.slug}/qr/tables?lng=ar`)
		expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl')
		const label = page.getByText('طاولة 1', { exact: true })
		await expect(label).toBeVisible()
		expect(await label.evaluate((element) => element.tagName)).toBe('BDI')
	})
})

test.describe('QR tables: locations, floor plan and printing', () => {
	test('each location has its own tables', async ({ page, login }) => {
		const { org, locations } = await setup(login, {
			locations: ['Airport', 'Downtown'],
		})
		const [airport, downtown] = locations
		const requests = await stubQrApi(page, {
			tables: [
				table(airport!.id, 'qt_a', 'Gate 1'),
				table(downtown!.id, 'qt_d', 'Window 1'),
			],
		})
		await page.goto(`/${org.slug}/qr/tables`)
		const select = page.getByLabel('Location')
		// Sorted by name: Airport first.
		await expect(select).toHaveValue(airport!.id)
		await expect(page.getByText('Gate 1')).toBeVisible()
		await expect(page.getByText('Window 1')).toHaveCount(0)

		await select.selectOption(downtown!.id)
		await expect(page.getByText('Window 1')).toBeVisible()
		await expect(page.getByText('Gate 1')).toHaveCount(0)
		expect(requests.at(-1)?.search).toBe(
			`?locationId=${encodeURIComponent(downtown!.id)}`,
		)

		await addField(page).fill('Window 2')
		await addButton(page).click()
		await expect(page.getByText('Added 1 table')).toBeVisible()
		expect(
			requests.find((r) => r.path === '/tables/bulk')?.body?.locationId,
		).toBe(downtown!.id)
	})

	test('one location shows no location picker', async ({ page, login }) => {
		const { org } = await setup(login)
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('No tables yet')).toBeVisible()
		await expect(page.getByLabel('Location')).toHaveCount(0)
	})

	test('the floor plan import appears only with reservations on', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('No tables yet')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Import floor plan' }),
		).toHaveCount(0)

		await setFlags(org.id, [RESERVATIONS_FLAG_KEYS.enabled])
		const requests = await stubQrApi(page)
		await page.reload()
		await page.getByRole('button', { name: 'Import floor plan' }).click()
		await expect(page.getByText('Floor plan tables are in sync')).toBeVisible()
		await expect(page.getByText('From floor plan')).toBeVisible()
		expect(
			requests.find((r) => r.path === '/tables/import-floor-plan')?.body,
		).toEqual({ locationId: locations[0]!.id })
	})

	test('the print link needs tables and the Print shop', async ({
		page,
		login,
	}) => {
		const { org, locations } = await setup(login)
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/tables`)
		await expect(page.getByText('No tables yet')).toBeVisible()
		await expect(page.getByText('Print table cards')).toHaveCount(0)

		// Print shop off: still no link, even with tables.
		await stubQrApi(page, { tables: [table(locations[0]!.id, 'qt_1', 'T1')] })
		await page.reload()
		await expect(page.getByText('T1', { exact: true })).toBeVisible()
		await expect(page.getByText('Print table cards')).toHaveCount(0)

		await setFlags(org.id, [PRINT_SHOP_FLAG_KEYS.enabled])
		await page.reload()
		const print = page
			.getByRole('link', { name: 'Print table cards' })
			.or(page.getByRole('button', { name: 'Print table cards' }))
		await expect(print).toHaveAttribute(
			'href',
			`/${org.slug}/marketing/print/new`,
		)
	})
})

test.describe('QR ordering settings', () => {
	test('settings load, save and clamp the hourly limit', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		const requests = await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/settings`)
		await expect(
			page.getByRole('heading', { name: 'QR ordering settings', level: 1 }),
		).toBeVisible()

		const name = page.getByRole('switch', { name: /Ask for the guest’s name/ })
		const phone = page.getByRole('switch', {
			name: /Ask for the guest’s phone number/,
		})
		await expect(name).toBeChecked()
		await expect(phone).not.toBeChecked()
		// Online tab pay is behind its own flag.
		await expect(
			page.getByText('Let guests pay the tab from their phone'),
		).toHaveCount(0)

		await phone.click()
		const limit = page.getByLabel('Orders per table per hour')
		await limit.fill('9999')
		await limit.blur()
		await expect(limit).toHaveValue(String(QR_PER_TABLE_LIMIT_MAX))
		await limit.fill('0')
		await limit.blur()
		await expect(limit).toHaveValue('1')
		await limit.fill('12')
		// Saved straight from the field, without leaving it first.
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await expect(page.getByText('Settings saved')).toBeVisible()
		expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
			requireGuestName: true,
			requireGuestPhone: true,
			allowOnlineTabPay: false,
			perTableLimitPerHour: 12,
		})
	})

	test('online tab pay shows when its flag is on', async ({ page, login }) => {
		const { org } = await setup(login, {
			flags: [...QR_ON, QR_ORDERING_FLAG_KEYS.online],
		})
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/settings`)
		await expect(
			page.getByRole('switch', {
				name: /Let guests pay the tab from their phone/,
			}),
		).toBeVisible()
	})

	test('a member sees the settings read-only', async ({ page, login }) => {
		const { org } = await setup(login, { role: 'member' })
		await stubQrApi(page)
		await page.goto(`/${org.slug}/qr/settings`)
		await expect(
			page.getByRole('switch', { name: /Ask for the guest’s name/ }),
		).toBeDisabled()
		await expect(page.getByLabel('Orders per table per hour')).toBeDisabled()
		await expect(
			page.getByRole('button', { name: 'Save', exact: true }),
		).toHaveCount(0)
	})

	test('load and save failures are reported', async ({ page, login }) => {
		const { org } = await setup(login)
		let failLoad = true
		await stubQrApi(page, {
			override: (request) => {
				if (request.method === 'GET' && failLoad) {
					return { status: 500, body: { error: 'internal' } }
				}
				if (request.method === 'PATCH') {
					return {
						status: 400,
						body: { error: 'invalid', message: 'That limit is not allowed.' },
					}
				}
			},
		})
		await page.goto(`/${org.slug}/qr/settings`)
		await expect(page.getByRole('alert')).toContainText(
			'Unable to load settings. Try again.',
		)

		failLoad = false
		await page.reload()
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await expect(page.getByText('That limit is not allowed.')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Save', exact: true }),
		).toBeEnabled()
	})
})
