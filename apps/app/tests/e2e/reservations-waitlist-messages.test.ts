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

const BUSINESS_DATE = '2026-04-20'

type StubRequest = { method: string; path: string; body: any }

async function enableFlags(organizationId: string) {
	await db.insert(ConfigFlag).values(
		[
			RESERVATIONS_FLAG_KEYS.enabled,
			RESERVATIONS_FLAG_KEYS.online,
			RESERVATIONS_FLAG_KEYS.waitlist,
		].map((key) => ({
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

function json(route: any, data: unknown, status = 200, headers = {}) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json', ...headers },
		body: JSON.stringify(data),
	})
}

function entry(
	locationId: string,
	id: string,
	overrides: Record<string, unknown> = {},
) {
	const now = Date.now()
	return {
		id,
		locationId,
		businessDate: BUSINESS_DATE,
		guestId: null,
		displayName: `Guest ${id}`,
		firstName: 'Guest',
		lastName: id,
		phone: null,
		email: null,
		partySize: 2,
		areaPrefId: null,
		channel: 'walk_in',
		status: 'waiting',
		quotedMin: 20,
		quotedReadyAt: now + 20 * 60_000,
		notifiedAt: null,
		responseDeadlineAt: null,
		reservationId: null,
		sortKey: 1,
		notes: null,
		smsOptIn: false,
		locale: 'en',
		version: 1,
		joinedAt: now - 5 * 60_000,
		createdAt: now - 5 * 60_000,
		position: 1,
		...overrides,
	}
}

async function stubApi(page: Page, locationId: string) {
	const requests: StubRequest[] = []
	let entries = [
		entry(locationId, 'w1', {
			displayName: 'Rana Saleh',
			partySize: 2,
			position: 1,
			sortKey: 1,
		}),
		entry(locationId, 'w2', {
			displayName: 'Omar Fadel',
			partySize: 3,
			position: 2,
			sortKey: 2,
		}),
	]
	let messageVersion = 3
	let messaging: Record<string, any> = {
		kinds: { confirmation: true, reminder: true, reconfirm_request: false },
		reminderHours: 24,
		reconfirmEnabled: false,
		reconfirmHours: 48,
		quietHours: { startMin: 1260, endMin: 480 },
		smsEnabled: true,
	}
	let notes: Record<string, { en: string; ar: string }> = {}
	let waitlistSettings = {
		locationId,
		version: 1,
		waitlistEnabled: true,
		waitlistOnline: true,
		notifyMeEnabled: false,
		waitlistResponseMin: 10,
		waitlistMaxParties: null as number | null,
	}

	const table = (id: string, label: string, x: number) => ({
		id,
		locationId,
		areaId: 'area-main',
		label,
		minCovers: 2,
		maxCovers: 4,
		shape: 'square',
		x,
		y: 90,
		width: 96,
		height: 96,
		rotation: 0,
		combinable: false,
		isBookableOnline: true,
		isActive: true,
		version: 1,
	})

	const occupant = {
		id: 'rsv-1',
		locationId,
		confirmationCode: 'RSV101',
		guestId: 'guest-1',
		guestName: 'Lina Haddad',
		guestPhone: '+15550101001',
		partySize: 3,
		businessDate: BUSINESS_DATE,
		localStartMin: 1140,
		durationMin: 90,
		status: 'confirmed',
		channel: 'phone',
		serviceId: 'svc-dinner',
		areaPrefId: 'area-main',
		tableIds: ['table-1'],
		lockTable: false,
		locked: false,
		version: 1,
	}

	const kinds = [
		{ kind: 'confirmation', waitlist: false },
		{ kind: 'reminder', waitlist: false },
		{ kind: 'reconfirm_request', waitlist: false },
		{ kind: 'waitlist_joined', waitlist: true },
	]

	const settingsBody = () => ({
		ok: true,
		locationId,
		version: messageVersion,
		messaging,
		kinds: kinds.map(({ kind, waitlist }) => ({
			kind,
			waitlist,
			enabled: messaging.kinds[kind] ?? true,
			notes: notes[kind] ?? { en: '', ar: '' },
		})),
		noteMaxLength: 500,
	})

	const listing = () => {
		let position = 0
		const withPositions = entries.map((e) => ({
			...e,
			position: ['waiting', 'notified', 'on_the_way'].includes(e.status)
				? ++position
				: null,
		}))
		const count = (status: string) =>
			withPositions.filter((e) => e.status === status).length
		return {
			locationId,
			businessDate: BUSINESS_DATE,
			now: Date.now(),
			waitlistResponseMin: waitlistSettings.waitlistResponseMin,
			counts: {
				active: count('waiting') + count('notified') + count('on_the_way'),
				waiting: count('waiting'),
				notified: count('notified'),
				onTheWay: count('on_the_way'),
			},
			entries: withPositions,
		}
	}

	await page.route('**/operator/reservations/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path, body })

		if (method === 'GET' && path === '/operator/reservations/book/day') {
			return json(route, {
				etag: '"day-1"',
				dayVersion: 1,
				settingsVersion: 1,
				floorPlanVersion: 1,
				locationId,
				businessDate: BUSINESS_DATE,
				timezone: 'America/New_York',
				dayStartMin: 240,
				areas: [
					{
						id: 'area-main',
						locationId,
						name: 'Main Dining',
						nameI18n: { en: 'Main Dining', ar: 'الصالة الرئيسية' },
						sortOrder: 0,
						isOutdoor: false,
						isBookableOnline: true,
						isActive: true,
						version: 1,
					},
				],
				tables: [table('table-1', 'T1', 80), table('table-2', 'T2', 240)],
				combinations: [],
				elements: [],
				services: [
					{
						id: 'svc-dinner',
						locationId,
						name: 'Dinner',
						nameI18n: { en: 'Dinner', ar: 'العشاء' },
						code: 'dinner',
						daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
						firstSeatingMin: 1020,
						lastSeatingMin: 1320,
						endMin: 1380,
						slotIntervalMin: 15,
						defaultTurnTimeMin: 90,
						onlineBookable: true,
						sortOrder: 0,
						color: '#3b82f6',
						isActive: true,
						version: 1,
					},
				],
				sectionLayouts: [],
				sectionAssignments: [],
				serviceNotes: [],
				scheduleBlocks: [],
				reservations: [occupant],
				waitlist: [],
				holds: [],
				pacing: [],
				moveNotices: [],
			})
		}

		if (path === '/operator/reservations/book/waitlist') {
			if (method === 'GET') return json(route, listing())
		}

		const action = path.match(
			/^\/operator\/reservations\/book\/waitlist\/([^/]+)\/([a-z-]+)$/,
		)
		if (action && method === 'POST') {
			const id = decodeURIComponent(action[1]!)
			const kind = action[2]!
			const current = entries.find((e) => e.id === id)!
			const patch = (fields: Record<string, unknown>) => {
				const next = { ...current, ...fields, version: current.version + 1 }
				entries = entries.map((e) => (e.id === id ? next : e))
				return next
			}
			if (kind === 'notify') {
				const next = patch({
					status: 'notified',
					notifiedAt: Date.now(),
					responseDeadlineAt: Date.now() + 10 * 60_000,
				})
				return json(route, { entry: next, changed: true })
			}
			if (kind === 'seat') {
				const taken = (body.tableIds ?? []).includes('table-1')
				if (taken && !body.resolution && !body.overbook) {
					const occ = {
						kind: 'reservation',
						reservationId: occupant.id,
						confirmationCode: occupant.confirmationCode,
						status: occupant.status,
						partySize: occupant.partySize,
						startAt: Date.now(),
						endAt: Date.now() + 90 * 60_000,
						tableIds: ['table-1'],
						guestName: occupant.guestName,
					}
					return json(
						route,
						{
							error: 'table_occupied',
							message: 'The table is occupied for this party’s time',
							occupant: occ,
							occupants: [occ],
							resolutions: ['swap', 'move', 'overbook'],
						},
						409,
					)
				}
				const next = patch({ status: 'seated', reservationId: 'rsv-new' })
				return json(route, { entry: next, reservation: null, moves: [] })
			}
		}

		if (path === '/operator/reservations/setup/message-texts') {
			if (method === 'GET') return json(route, settingsBody())
			if (method === 'PUT') {
				if (body.messaging) {
					messaging = {
						...messaging,
						...body.messaging,
						kinds: { ...messaging.kinds, ...(body.messaging.kinds ?? {}) },
					}
				}
				for (const text of body.texts ?? []) {
					notes[text.kind] = {
						...(notes[text.kind] ?? { en: '', ar: '' }),
						[text.locale]: text.customNote,
					}
				}
				messageVersion += 1
				return json(route, settingsBody())
			}
		}
		if (path === '/operator/reservations/setup/message-texts/preview') {
			const kind = url.searchParams.get('kind') ?? 'confirmation'
			const note = notes[kind]?.en ?? ''
			return json(route, {
				kind,
				locale: url.searchParams.get('locale') ?? 'en',
				subject: 'Your table is confirmed',
				html: `<p>Hello Sample Guest. ${note}</p>`,
				text: `Hello Sample Guest. ${note}`,
				sms: null,
			})
		}

		if (
			path === `/operator/reservations/setup/locations/${locationId}/waitlist`
		) {
			if (method === 'GET') return json(route, waitlistSettings)
			if (method === 'PUT') {
				waitlistSettings = {
					...waitlistSettings,
					...body,
					version: waitlistSettings.version + 1,
				}
				delete (waitlistSettings as any).expectedVersion
				return json(route, waitlistSettings)
			}
		}

		return json(route, { ok: true })
	})

	return { requests }
}

test.describe('Reservations messages and waitlist UI', () => {
	test('Guest Messages settings edit kinds, hours, notes and refresh the preview', async ({
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

		await navigate('/:slug/reservations/settings/messages', { slug: org.slug })
		await expect(
			page.getByTestId('reservations-settings-messages-page'),
		).toBeVisible()

		await page.getByTestId('message-kind-switch-reminder').click()
		await expect(page.getByTestId('message-dirty-badge')).toBeVisible()
		await page.getByTestId('message-save').click()
		await expect(page.getByTestId('message-saved')).toBeVisible()

		const save = requests.find(
			(r) =>
				r.method === 'PUT' &&
				r.path === '/operator/reservations/setup/message-texts',
		)
		expect(save?.body.expectedVersion).toBe(3)
		expect(save?.body.messaging.kinds.reminder).toBe(false)
		await expect(page.getByTestId('message-preview-card')).toBeVisible()
	})

	test('Waitlist screen notifies a party and the seat dialog refuses a taken table with the swap choice', async ({
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

		await navigate('/:slug/reservations/waitlist', { slug: org.slug })
		await expect(page.getByTestId('waitlist-card-w1')).toBeVisible()
		await expect(page.getByTestId('waitlist-count-active')).toContainText('2')

		await page.getByTestId('waitlist-notify-w1').click()
		await expect(page.getByTestId('waitlist-status-w1')).toContainText(
			/notified/i,
		)
		expect(
			requests.some(
				(r) =>
					r.method === 'POST' &&
					r.path === '/operator/reservations/book/waitlist/w1/notify',
			),
		).toBe(true)

		// A waiting party's Seat lives in its row menu; the row's one primary
		// button is Notify.
		await page.getByTestId('waitlist-more-w2').click()
		await page.getByTestId('waitlist-seat-w2').click()
		await page.getByRole('combobox', { name: 'Table' }).click()
		await page.getByRole('option', { name: /^T1/ }).click()
		await page.getByTestId('waitlist-seat-submit').click()
		await expect(page.getByTestId('waitlist-seat-swap')).toBeVisible()
		await expect(page.getByTestId('waitlist-seat-move')).toBeVisible()
		await page.getByTestId('waitlist-seat-swap').click()
		await expect(page.getByTestId('waitlist-seat-dialog')).toBeHidden()

		const seats = requests.filter((r) => r.path.endsWith('/w2/seat'))
		expect(seats).toHaveLength(2)
		expect(seats[1]?.body.resolution).toBe('swap')
	})

	test('Waitlist settings save the response window against the version', async ({
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

		await navigate('/:slug/reservations/settings/waitlist', { slug: org.slug })
		await expect(page.getByTestId('waitlist-settings-form')).toBeVisible()
		await page.getByTestId('waitlist-setting-response-min').fill('15')
		await page.getByTestId('waitlist-setting-notify-me').click()
		await page.getByTestId('waitlist-settings-save').click()
		await expect(page.getByTestId('waitlist-settings-saved')).toBeVisible()

		const save = requests.find(
			(r) => r.method === 'PUT' && r.path.endsWith(`/${location.id}/waitlist`),
		)
		expect(save?.body).toMatchObject({
			expectedVersion: 1,
			waitlistResponseMin: 15,
			notifyMeEnabled: true,
		})
	})

	test('Floor: dropping a waitlist party on an occupied table offers swap, move and overbook; Arabic mirrors the chrome', async ({
		page,
		login,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocation(org.id)
		await enableFlags(org.id)
		const { requests } = await stubApi(page, location.id)

		await page.goto(
			`/${org.slug}/reservations/floor?location=${location.id}&date=${BUSINESS_DATE}`,
		)
		const card = page.getByTestId('floor-waitlist-card-w1')
		await expect(card).toBeVisible()
		const target = page.getByTestId('floor-table-table-1')
		await expect(target).toBeVisible()

		// Synthetic DragEvents: the same events the browser fires, without mouse moves.
		const transfer = await page.evaluateHandle(() => new DataTransfer())
		await card.dispatchEvent('dragstart', { dataTransfer: transfer })
		await target.dispatchEvent('dragover', { dataTransfer: transfer })
		await target.dispatchEvent('drop', { dataTransfer: transfer })

		const prompt = page.getByTestId('floor-waitlist-overbook-prompt')
		await expect(prompt).toBeVisible()
		await expect(page.getByTestId('floor-waitlist-occupant')).toContainText(
			'Lina Haddad',
		)
		await expect(page.getByTestId('floor-waitlist-resolve-swap')).toBeVisible()
		await expect(page.getByTestId('floor-waitlist-resolve-move')).toBeVisible()
		await expect(
			page.getByTestId('floor-waitlist-overbook-confirm'),
		).toBeVisible()

		await page.getByTestId('floor-waitlist-resolve-swap').click()
		await expect(page.getByTestId('floor-action-banner')).toContainText(
			'Rana Saleh',
		)
		const seats = requests.filter((r) => r.path.endsWith('/w1/seat'))
		expect(seats.map((r) => r.body.resolution ?? null)).toEqual([null, 'swap'])
		expect(seats[1]?.body.tableIds).toEqual(['table-1'])

		await page.goto(
			`/${org.slug}/reservations/waitlist?location=${location.id}&lng=ar`,
		)
		await expect(page.getByTestId('waitlist-screen')).toBeVisible()
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
	})
})
