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

function guestRow(
	id: string,
	firstName: string,
	lastName: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		firstName,
		lastName,
		name: `${firstName} ${lastName}`,
		phoneE164: '+15555550101',
		email: `${firstName.toLowerCase()}@example.test`,
		locale: 'en',
		allergyNotes: null,
		hasAllergy: false,
		visits: 3,
		covers: 8,
		noShows: 0,
		cancels: 0,
		lateCancels: 0,
		firstVisitAt: null,
		lastVisitAt: null,
		erasedAt: null,
		customerLinked: false,
		version: 1,
		tags: [] as unknown[],
		...overrides,
	}
}

async function stubApi(page: Page, locationId: string) {
	const requests: StubRequest[] = []
	const vip = {
		id: 'tag_vip',
		name: 'VIP',
		category: 'general',
		colorToken: 'amber',
		sensitive: false,
	}
	const guests = [
		guestRow('g1', 'Rana', 'Saleh'),
		guestRow('g2', 'Omar', 'Fadel', { tags: [vip] }),
	]
	let notes: Array<{
		id: string
		body: string
		pinned: boolean
		createdAt: number
	}> = []
	let nextNote = 1

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

		if (path === '/operator/reservations/guests/tags') {
			return json(route, { tags: [vip] })
		}
		if (path === '/operator/reservations/guests' && method === 'GET') {
			const q = (url.searchParams.get('q') ?? '').toLowerCase()
			const tag = url.searchParams.get('tag')
			const rows = guests.filter(
				(g) =>
					(!q || g.name.toLowerCase().includes(q)) &&
					(!tag || g.tags.length > 0),
			)
			return json(route, { guests: rows, nextCursor: null, total: rows.length })
		}

		const profile = path.match(/^\/operator\/reservations\/guests\/([^/]+)$/)
		if (profile && method === 'GET') {
			const guest = guests.find((g) => g.id === profile[1])
			if (!guest) return json(route, { error: 'not_found' }, 404)
			return json(route, {
				guest,
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
					},
				],
			})
		}
		const notesPath = path.match(
			/^\/operator\/reservations\/guests\/([^/]+)\/notes$/,
		)
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

		return json(route, { ok: true })
	})

	return { requests }
}

test.describe('Reservations guestbook, generic reports link and Bookings today block', () => {
	test('Guestbook lists, searches, filters by tag and keeps notes with the profile', async ({
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

		await navigate('/:slug/reservations/guests', { slug: org.slug })
		await expect(page.getByTestId('guest-row-g1')).toBeVisible()
		await expect(page.getByTestId('guest-row-g2')).toBeVisible()
		await expect(page.getByTestId('guests-count')).toContainText('2')

		await page.getByTestId('guests-search').fill('omar')
		await expect(page.getByTestId('guest-row-g1')).toHaveCount(0)
		await expect(page.getByTestId('guest-row-g2')).toBeVisible()
		expect(
			requests.some(
				(r) =>
					r.path === '/operator/reservations/guests' &&
					r.search.includes('q=omar') &&
					r.search.includes('limit=50'),
			),
		).toBe(true)
		expect(requests.every((r) => r.authorization?.startsWith('Bearer '))).toBe(
			true,
		)

		await page.getByTestId('guests-search').fill('')
		await expect(page.getByTestId('guest-row-g1')).toBeVisible()
		await page.getByTestId('guests-tag-filter').click()
		await page.getByRole('option', { name: 'VIP' }).click()
		await expect(page.getByTestId('guest-row-g1')).toHaveCount(0)
		await expect(page.getByTestId('guest-row-g2')).toBeVisible()

		await page.getByTestId('guest-link-g2').click()
		await expect(page.getByTestId('guest-profile-screen')).toBeVisible()
		await expect(page.getByTestId('guest-history')).toBeVisible()
		await page.getByTestId('guest-note-input').fill('Prefers the window')
		await page.getByTestId('guest-note-pin-new').click()
		await page.getByTestId('guest-note-add').click()
		await expect(page.getByTestId('guest-notes')).toContainText(
			'Prefers the window',
		)
		const note = requests.find(
			(r) => r.method === 'POST' && r.path.endsWith('/g2/notes'),
		)
		expect(note?.body).toMatchObject({
			body: 'Prefers the window',
			pinned: true,
		})
	})

	test('Reservations Reports links to the generic Reports page, opens the Reservations templates and runs one straight from tenant-api', async ({
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
		// Reports is a plain link out of Reservations, not a screen of its own.
		await page
			.getByRole('navigation', { name: 'Reservations sections' })
			.getByRole('link', { name: 'Reports' })
			.click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/reports\\?category=Reservations`),
		)
		await expect(page).toHaveURL(new RegExp(`location=${location.id}`))
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
