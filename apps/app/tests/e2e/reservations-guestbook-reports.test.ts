import { type Page } from '@playwright/test'
import { ConfigFlag, db, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers':
		'authorization, content-type, if-none-match, idempotency-key',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
	'access-control-expose-headers': 'ETag, etag',
}

const TODAY = '2026-04-20'

type StubRequest = {
	method: string
	path: string
	search: string
	body: any
	authorization: string | undefined
}

async function enableFlags(organizationId: string) {
	await db.insert(ConfigFlag).values(
		[RESERVATIONS_FLAG_KEYS.enabled].map((key) => ({
			key,
			value: true,
			level: 'organization' as const,
			organizationId,
		})),
	)
}

async function createLocation(organizationId: string) {
	const id = `loc_${Math.random().toString(36).slice(2, 10)}`
	const [loc] = await db
		.insert(OrganizationLocation)
		.values({
			id,
			organizationId,
			name: 'Downtown Bistro',
			slug: `downtown-${id}`,
			timezone: 'America/New_York',
			isActive: true,
		})
		.returning()
	return loc!
}

function json(route: any, data: unknown, status = 200) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json' },
		body: JSON.stringify(data),
	})
}

function personRow(
	key: string,
	name: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		key,
		kind: 'guest',
		name,
		phone: '+15555550101',
		email: `${name.split(' ')[0]!.toLowerCase()}@example.test`,
		status: 'guest_no_sign_in',
		signedIn: false,
		hasDining: true,
		customerLinked: false,
		walkIn: false,
		dining: {
			visits: 3,
			covers: 8,
			noShows: 0,
			lastVisitAt: null,
			nextBookingAt: null,
		},
		orders: null,
		flags: { vip: false, allergy: false, noShowRisk: false },
		tags: [] as unknown[],
		createdAt: 1,
		lastActivityAt: 1,
		...overrides,
	}
}

async function stubApi(page: Page, locationId: string) {
	const requests: StubRequest[] = []
	const vip = {
		id: 'tag_vip',
		name: 'VIP',
		category: 'vip',
		colorToken: 'amber',
		sensitive: false,
		system: false,
	}
	const people = [
		personRow('g_g1', 'Rana Saleh'),
		personRow('g_g2', 'Omar Fadel', {
			tags: [vip],
			flags: { vip: true, allergy: false, noShowRisk: false },
		}),
	]
	let notes: Array<{
		id: string
		body: string
		pinned: boolean
		createdAt: number
	}> = []
	let nextNote = 1

	await page.route('**/operator/people**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({
			method,
			path,
			search: url.search,
			body,
			authorization: request.headers()['authorization'],
		})
		if (path === '/operator/people/tags') {
			return json(route, { tags: [vip] })
		}
		if (path === '/operator/people' && method === 'GET') {
			const q = (url.searchParams.get('q') ?? '').toLowerCase()
			const onlyVip = url.searchParams.get('vip') === '1'
			const rows = people.filter(
				(p) =>
					(!q || p.name.toLowerCase().includes(q)) && (!onlyVip || p.flags.vip),
			)
			return json(route, {
				people: rows,
				nextCursor: null,
				total: rows.length,
				meta: { hasOrders: false, walkInCount: 0 },
			})
		}
		const notesPath = path.match(/^\/operator\/people\/([^/]+)\/notes$/)
		if (notesPath && method === 'POST') {
			const note = {
				id: `n${nextNote++}`,
				body: body.body,
				pinned: Boolean(body.pinned),
				createdAt: Date.now(),
			}
			notes = [note, ...notes]
			return json(route, { note }, 201)
		}
		const profile = path.match(/^\/operator\/people\/([^/]+)$/)
		if (profile && method === 'GET') {
			const person = people.find(
				(p) => p.key === decodeURIComponent(profile[1]!),
			)
			if (!person) return json(route, { error: 'not_found' }, 404)
			return json(route, {
				key: person.key,
				canonicalKey: person.key,
				kind: 'guest',
				status: 'guest_no_sign_in',
				signedIn: false,
				customerLinked: false,
				walkIn: false,
				name: person.name,
				phone: person.phone,
				email: person.email,
				customer: null,
				marketing: null,
				access: {
					customers: true,
					dining: 'full',
					canUpdateCustomers: true,
					canUpdateDining: true,
					canDelete: false,
				},
				dining: {
					guest: {
						id: person.key.slice(2),
						firstName: person.name.split(' ')[0],
						lastName: person.name.split(' ')[1],
						phone: person.phone,
						email: person.email,
						locale: 'en',
						allergyNotes: null,
						hasAllergy: false,
						visits: 3,
						covers: 8,
						noShows: 0,
						lateCancels: 0,
						cancels: 0,
						firstVisitAt: null,
						lastVisitAt: null,
						version: 1,
						tags: person.tags,
					},
					nextBookingAt: null,
					notes,
					pinnedNotes: notes.filter((n) => n.pinned),
					reservations: [
						{
							id: 'r1',
							locationId,
							businessDate: TODAY,
							localStartMin: 1110,
							partySize: 2,
							status: 'completed',
							channel: 'online',
							lateCancel: false,
							serviceName: 'Dinner',
							guestRequests: null,
							dietaryNotes: null,
						},
					],
				},
			})
		}
		return json(route, { ok: true })
	})

	await page.route('**/operator/reservations/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		const headers = request.headers()
		requests.push({
			method,
			path,
			search: url.search,
			body,
			authorization: headers['authorization'],
		})

		if (path === '/operator/reservations/book/today') {
			return json(route, {
				locationId,
				businessDate: TODAY,
				totalParties: 4,
				totalCovers: 11,
				counts: { booked: 2, confirmed: 1, seated: 1 },
				coversByService: [
					{ serviceId: 'svc-dinner', name: 'Dinner', parties: 4, covers: 11 },
				],
				waitlistCount: 2,
				nextArrivals: [
					{
						reservationId: 'r1',
						time: '18:30',
						partySize: 2,
						firstName: 'Lina',
						status: 'confirmed',
					},
				],
			})
		}

		return json(route, { ok: true })
	})

	return { requests }
}

test.describe('Customers people list, reservation reports on the main Reports page and Bookings today block', () => {
	test('Customers lists guests and customers together, searches and filters on the server and keeps notes with the profile', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocation(org.id)
		await enableFlags(org.id)
		const { requests } = await stubApi(page, location.id)

		await navigate('/:slug/customers', { slug: org.slug })
		await expect(page.getByTestId('person-row-g_g1')).toBeVisible()
		await expect(page.getByTestId('person-row-g_g2')).toBeVisible()
		await expect(page.getByTestId('person-status-guest').first()).toBeVisible()
		await expect(page.getByTestId('customers-count')).toContainText('2')

		await page.getByTestId('customers-search').fill('omar')
		await expect(page.getByTestId('person-row-g_g1')).toHaveCount(0)
		await expect(page.getByTestId('person-row-g_g2')).toBeVisible()
		expect(
			requests.some(
				(r) =>
					r.path === '/operator/people' &&
					r.search.includes('q=omar') &&
					r.search.includes('limit=50'),
			),
		).toBe(true)
		expect(requests.every((r) => r.authorization?.startsWith('Bearer '))).toBe(
			true,
		)

		await page.getByTestId('customers-search').fill('')
		await expect(page.getByTestId('person-row-g_g1')).toBeVisible()
		await page.getByTestId('customers-filter-vip').click()
		await expect(page.getByTestId('person-row-g_g1')).toHaveCount(0)
		await expect(page.getByTestId('person-row-g_g2')).toBeVisible()

		await page.getByTestId('person-link-g_g2').click()
		await expect(page.getByTestId('person-profile-screen')).toBeVisible()
		await expect(page.getByTestId('person-history')).toBeVisible()
		await page.getByTestId('guest-note-input').fill('Prefers the window')
		await page.getByTestId('guest-note-pin-new').click()
		await page.getByTestId('guest-note-add').click()
		await expect(page.getByTestId('guest-notes')).toContainText(
			'Prefers the window',
		)
		const note = requests.find(
			(r) => r.method === 'POST' && r.path.endsWith('/g_g2/notes'),
		)
		expect(note?.body).toMatchObject({
			body: 'Prefers the window',
			pinned: true,
		})

		// The old Guests address lands on Customers.
		await page.goto(`/${org.slug}/reservations/guests`)
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/customers`))
	})

	test('Reservation reports live on the main Reports page (no Reservations tab or menu item) and run one straight from tenant-api', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocation(org.id)
		await enableFlags(org.id)
		await stubApi(page, location.id)
		const analytics: Array<{ body: any; authorization: string | undefined }> =
			[]
		await page.route('**/analytics/query', async (route) => {
			const request = route.request()
			if (request.method() === 'OPTIONS') {
				return route.fulfill({ status: 204, headers: CORS })
			}
			analytics.push({
				body: request.postDataJSON(),
				authorization: request.headers()['authorization'],
			})
			return json(route, {
				total: 8,
				value: 12.5,
				valueInfo: {
					measure: 'ratio',
					field: 'noShowRate',
					label: 'No-show rate',
					type: 'percent',
				},
				segments: [
					{
						key: 'Dinner',
						label: 'Dinner',
						count: 8,
						percent: 100,
						value: 12.5,
					},
				],
				refreshedAt: new Date().toISOString(),
			})
		})
		const dataBodies: string[] = []
		page.on('response', async (response) => {
			if (response.url().includes('.data')) {
				dataBodies.push(await response.text().catch(() => ''))
			}
		})

		await navigate('/:slug/reservations/today', { slug: org.slug })
		// Reports is not a Reservations tab: it is the "Reservations" group on the
		// main Reports page, reached from the Reports sidebar entry.
		const tabs = page.getByRole('navigation', { name: 'Reservations sections' })
		await expect(tabs.getByRole('link', { name: 'Reports' })).toHaveCount(0)
		await expect(tabs.getByRole('link', { name: 'Guests' })).toHaveCount(0)
		await page.goto(`/${org.slug}/reports?location=${location.id}`)
		await expect(
			page.getByRole('link', { name: /No-shows & cancellations/ }),
		).toBeVisible()

		await page.getByRole('link', { name: /No-shows & cancellations/ }).click()
		await expect(page).toHaveURL(/\/reports\/new\?template=rsv-no-show-rate/)
		await expect.poll(() => analytics.length).toBeGreaterThan(0)
		// The browser called tenant-api with its own token; no App `.data`
		// response carried a reservation fact.
		const first = analytics[0]!
		expect(first.authorization).toMatch(/^Bearer /)
		expect(first.body.definition.subject).toBe('bookings')
		expect(
			first.body.definition.filters.conditions.some(
				(condition: { field: string; value: string }) =>
					condition.field === 'location' &&
					condition.value === 'Downtown Bistro',
			),
		).toBe(true)
		for (const body of dataBodies) {
			expect(body).not.toContain('noShowRate":12.5')
		}

		// Old links and bookmarks land on the same page, keeping the language.
		await page.goto(
			`/${org.slug}/reservations/reports?location=${location.id}&lng=ar`,
		)
		await expect(page).toHaveURL(/\/reports\?category=Reservations/)
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
	})

	test('Bookings today block can be added once and loads straight from tenant-api', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocation(org.id)
		await enableFlags(org.id)
		const { requests } = await stubApi(page, location.id)
		const dataBodies: string[] = []
		page.on('response', async (response) => {
			if (response.url().includes('.data')) {
				dataBodies.push(await response.text().catch(() => ''))
			}
		})

		await navigate('/:slug', { slug: org.slug })
		await page.getByRole('button', { name: 'Edit layout' }).click()
		await page.getByRole('button', { name: 'Add block' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add block' })
		await dialog.getByRole('button', { name: /^Bookings today/ }).click()

		const block = page.getByTestId('bookings-today-block')
		await expect(block).toBeVisible()
		await expect(page.getByTestId('bookings-today-parties')).toContainText('4')
		await expect(page.getByTestId('bookings-today-covers')).toContainText('11')
		await expect(page.getByTestId('bookings-today-arrivals')).toContainText(
			'Lina',
		)

		const today = requests.find(
			(r) => r.path === '/operator/reservations/book/today',
		)
		expect(today?.authorization).toMatch(/^Bearer /)
		expect(today?.search).toContain(`locationId=${location.id}`)
		expect(dataBodies.some((body) => body.includes('Lina'))).toBe(false)

		await page.getByRole('button', { name: 'Add block' }).click()
		await expect(
			dialog.getByRole('button', { name: /^Bookings today/ }),
		).toHaveCount(0)
	})
})
