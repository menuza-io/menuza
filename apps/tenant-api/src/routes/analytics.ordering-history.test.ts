import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	type OrderingHistory,
} from '@repo/common/ordering-history'
import { type MenuRoster } from '@repo/common/slow-sellers'
import { createReportDefinition } from '@repo/reports'
import {
	mintOperatorAnalyticsToken,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	menuAvailabilityEvents,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { analyticsRoutes } from './analytics.ts'

const ANALYTICS_TOKEN = 'test-ordering-analytics-signing-secret-32chars!!'
const ORG = 'org_ordering_hist_a'
const ORG_B = 'org_ordering_hist_b'
const LOC = 'loc_a'
const LOC_B = 'loc_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const fake = vi.hoisted(() => ({
	history: null as null | ((orgId: string) => OrderingHistory | null),
	roster: null as MenuRoster | null,
	askedOrgs: [] as string[],
}))
vi.mock('../lib/ordering-history.ts', () => ({
	getOrderingHistory: vi.fn(async (orgId: string) => {
		fake.askedOrgs.push(orgId)
		return fake.history ? fake.history(orgId) : null
	}),
}))
vi.mock('../lib/menu-roster.ts', () => ({
	getMenuRoster: vi.fn(async () => fake.roster),
	clearMenuRosterCache: vi.fn(),
}))

const app = new Hono()
app.route('/analytics', analyticsRoutes)

const HOUR = 3_600_000
const DAY = 86_400_000
// A past Monday (UTC): 2026-10-05.
const D0 = Date.UTC(2026, 9, 5)
const at = (dayOffset: number, hour: number, minute = 0) =>
	D0 + dayOffset * DAY + hour * HOUR + minute * 60_000

const ORDER_SUBJECTS = [
	'orders',
	'order_items',
	'order_options',
	'missed_online_sales',
] as const satisfies readonly RestrictedReportSubject[]

async function token(
	options: {
		orgId?: string
		subjects?: readonly RestrictedReportSubject[]
		locationIds?: readonly string[] | null
		secret?: string
	} = {},
) {
	const { token } = await mintOperatorAnalyticsToken({
		signingSecret: options.secret ?? ANALYTICS_TOKEN,
		userId: 'usr_ordering',
		orgId: options.orgId ?? ORG,
		role: 'operator',
		subjects: options.subjects ?? ORDER_SUBJECTS,
		scopeIds: null,
		locationIds: options.locationIds === undefined ? null : options.locationIds,
	})
	return token
}

function historyOf(
	over: Partial<OrderingHistory['locations'][number]> = {},
	extra: OrderingHistory['locations'] = [],
): (orgId: string) => OrderingHistory {
	return (orgId) => ({
		orgId,
		locations: [
			{
				id: LOC,
				name: 'Olaya',
				timezone: 'UTC',
				currency: 'SAR',
				// Open 12:00 to 22:00 on the day, a 10 hour day.
				openWindows: [{ from: at(0, 12), to: at(0, 22) }],
				pauses: [],
				closures: [],
				...over,
			},
			...extra,
		],
	})
}

const uptimeQuery = (jwt: string, query = '') =>
	app.request(
		`/analytics/online-uptime?preset=custom&start=${new Date(at(0, 0)).toISOString()}&end=${new Date(at(1, 0)).toISOString()}${query}`,
		{ headers: { Authorization: `Bearer ${jwt}` } },
	)

let tempDir: string

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'ordering-history-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.OPERATOR_ANALYTICS_TOKEN = ANALYTICS_TOKEN
	fake.history = null
	fake.roster = null
	fake.askedOrgs = []
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		})
		await provisionTenantDb(id)
	}
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(tempDir, { recursive: true, force: true })
	orgs.clear()
})

describe('/analytics/online-uptime (#405)', () => {
	it('shows 90% with the reason for a location paused for an hour of a 10 hour day', async () => {
		fake.history = historyOf({ pauses: [{ from: at(0, 18), to: at(0, 19) }] })
		const res = await uptimeQuery(await token())
		expect(res.status).toBe(200)
		const body = (await res.json()) as any
		expect(body.locations).toHaveLength(1)
		expect(body.locations[0]).toMatchObject({
			locationId: LOC,
			uptimePercent: 90,
			scheduledMinutes: 600,
			minutes: { open: 540, paused: 60, dishes: 0, closed: 0 },
		})
		expect(body.overall.uptimePercent).toBe(90)
		expect(body.locations[0].days[0]).toMatchObject({ uptimePercent: 90 })
	})

	it('does not count overnight closed hours as downtime', async () => {
		// A pause from 20:00 to 02:00 next morning: only the 2 open hours count.
		fake.history = historyOf({ pauses: [{ from: at(0, 20), to: at(1, 0) }] })
		const body = (await (await uptimeQuery(await token())).json()) as any
		expect(body.locations[0].minutes.paused).toBe(120)
		expect(body.locations[0].uptimePercent).toBe(80)
		fake.history = historyOf()
		const quiet = (await (await uptimeQuery(await token())).json()) as any
		expect(quiet.locations[0].uptimePercent).toBe(100)
		expect(quiet.locations[0].scheduledMinutes).toBe(600)
	})

	it('splits downtime by reason: dishes unavailable only when every orderable dish was out, and closures', async () => {
		fake.roster = {
			orgId: ORG,
			dishes: [
				{ id: 'd1', name: 'A', createdAt: 0, availabilityStatus: 'available', unavailableUntil: null, categoryId: '', categoryName: '', menuId: '', menuName: '', price: 0, hiddenLocationIds: [] },
				{ id: 'd2', name: 'B', createdAt: 0, availabilityStatus: 'available', unavailableUntil: null, categoryId: '', categoryName: '', menuId: '', menuName: '', price: 0, hiddenLocationIds: [] },
				// Not orderable here: nothing to wait for.
				{ id: 'd3', name: 'C', createdAt: 0, availabilityStatus: 'available', unavailableUntil: null, categoryId: '', categoryName: '', menuId: '', menuName: '', price: 0, hiddenLocationIds: [LOC] },
			],
			locations: [],
		} as MenuRoster
		const db = await getTenantDb(ORG)
		const out = (id: string, from: number, to: number) => [
			{ locationId: LOC, entityType: 'item' as const, entityId: id, event: 'unavailable' as const, occurredAt: new Date(from) },
			{ locationId: LOC, entityType: 'item' as const, entityId: id, event: 'available' as const, occurredAt: new Date(to) },
		]
		await db.insert(menuAvailabilityEvents).values([
			...out('d1', at(0, 13), at(0, 17)), // d1 out 13:00 to 17:00
			...out('d2', at(0, 15), at(0, 19)), // d2 out 15:00 to 19:00: both out 15 to 17
		])
		fake.history = historyOf({
			closures: [{ from: at(0, 20), to: at(0, 22) }],
			openWindows: [{ from: at(0, 12), to: at(0, 20) }],
		})
		const body = (await (await uptimeQuery(await token())).json()) as any
		expect(body.dishesKnown).toBe(true)
		expect(body.locations[0].minutes).toMatchObject({
			dishes: 120,
			closed: 120,
			paused: 0,
		})
		// 8 open hours plus the 2 a closure took away: 600 minutes scheduled.
		expect(body.locations[0].scheduledMinutes).toBe(600)
		expect(body.locations[0].uptimePercent).toBe(60)
	})

	it('answers only for the locations the token covers and the organization it was minted for', async () => {
		fake.history = historyOf(
			{},
			[
				{
					id: LOC_B,
					name: 'Malaz',
					timezone: 'UTC',
					currency: 'SAR',
					openWindows: [{ from: at(0, 12), to: at(0, 22) }],
					pauses: [{ from: at(0, 12), to: at(0, 17) }],
					closures: [],
				},
			],
		)
		const scoped = (await (
			await uptimeQuery(await token({ locationIds: [LOC] }))
		).json()) as any
		expect(scoped.locations.map((l: any) => l.locationId)).toEqual([LOC])
		const both = (await (await uptimeQuery(await token())).json()) as any
		// Lowest uptime first, to compare locations.
		expect(both.locations.map((l: any) => l.locationId)).toEqual([LOC_B, LOC])
		// Asking for one of them.
		const one = (await (
			await uptimeQuery(await token(), `&locationIds=${LOC_B}`)
		).json()) as any
		expect(one.locations.map((l: any) => l.locationId)).toEqual([LOC_B])
		// Only the token's own organization is asked about.
		fake.askedOrgs = []
		await uptimeQuery(await token({ orgId: ORG_B }))
		expect(fake.askedOrgs).toEqual([ORG_B])
	})

	it('refuses a forged token, a token without the grant, and says so when history cannot be read', async () => {
		fake.history = historyOf()
		expect((await uptimeQuery(await token({ secret: 'another-secret-another-secret-123' }))).status).toBe(401)
		expect((await uptimeQuery(await token({ subjects: ['orders'] }))).status).toBe(403)
		fake.history = () => null
		const down = await uptimeQuery(await token())
		expect(down.status).toBe(503)
		expect(await down.json()).toMatchObject({ error: 'history_unavailable' })
	})
})

describe('/analytics/missed-estimate (#176)', () => {
	async function order(
		orgId: string,
		createdAt: number,
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		const db = await getTenantDb(orgId)
		const n = Math.random().toString(36).slice(2)
		await db.insert(restaurantOrders).values({
			orgId,
			number: `M-${n}`,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: LOC,
			locationName: 'Olaya',
			contactName: 'Guest',
			contactPhone: '+966500000000',
			currency: 'sar',
			subtotalCents: 4000,
			taxCents: 0,
			totalCents: 4000,
			lines: [],
			idempotencyKey: `idem-${n}`,
			requestHash: 'hash',
			receiptTokenHash: `receipt-${n}`,
			createdAt: new Date(createdAt),
			...overrides,
		})
	}

	const week = (k: number) => ({
		from: at(-7 * k, 18),
		to: at(-7 * k, 20),
	})
	const post = async (jwt: string, body: unknown) =>
		app.request('/analytics/missed-estimate', {
			method: 'POST',
			headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

	it('averages the same window of the earlier weeks, as an estimate, and counts only web and QR orders that count toward sales', async () => {
		// Week 1: 2 orders, week 2: 4 orders (+ ones that must not count).
		await order(ORG, at(-7, 18, 30))
		await order(ORG, at(-7, 19, 10))
		for (const minute of [5, 20, 40, 55]) await order(ORG, at(-14, 18, minute))
		await order(ORG, at(-14, 18, 30), { status: 'cancelled' })
		await order(ORG, at(-14, 18, 31), { currency: 'usd' })
		await order(ORG, at(-14, 18, 32), { locationId: LOC_B })
		await order(ORG_B, at(-14, 18, 33))
		// Outside the window.
		await order(ORG, at(-7, 20, 30))
		const res = await post(await token(), {
			locationId: LOC,
			currency: 'SAR',
			windows: [
				{
					id: 'a',
					from: at(0, 18),
					to: at(0, 20),
					weeks: [week(1), week(2)],
				},
			],
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as any
		expect(body.estimate).toBe(true)
		expect(body.estimates[0]).toEqual({
			id: 'a',
			enough: true,
			orders: 3,
			salesMinor: 12000,
			weeksUsed: 2,
		})
	})

	it('gives no estimate with fewer than two usable weeks', async () => {
		await order(ORG, at(-7, 18, 30))
		const res = await post(await token(), {
			locationId: LOC,
			currency: 'SAR',
			windows: [{ id: 'a', from: at(0, 18), to: at(0, 20), weeks: [week(1)] }],
		})
		expect(((await res.json()) as any).estimates[0]).toEqual({
			id: 'a',
			enough: false,
			weeksUsed: 1,
		})
	})

	it('refuses a location outside the token, an organization it was not minted for, a forged token and silly windows', async () => {
		const request = {
			locationId: LOC,
			currency: 'SAR',
			windows: [{ id: 'a', from: at(0, 18), to: at(0, 20), weeks: [week(1), week(2)] }],
		}
		expect((await post(await token({ locationIds: [LOC_B] }), request)).status).toBe(403)
		expect((await post(await token({ secret: 'another-secret-another-secret-123' }), request)).status).toBe(401)
		expect((await post(await token({ subjects: ['orders'] }), request)).status).toBe(403)
		// A window longer than a day is not an estimate request.
		expect(
			(
				await post(await token(), {
					...request,
					windows: [{ id: 'a', from: at(0, 0), to: at(1, 6), weeks: [] }],
				})
			).status,
		).toBe(400)
		// Another organization's token reads only its own sales: none here.
		await order(ORG, at(-7, 18, 30))
		await order(ORG, at(-14, 18, 30))
		const other = await post(await token({ orgId: ORG_B }), request)
		expect(((await other.json()) as any).estimates[0]).toMatchObject({
			enough: true,
			orders: 0,
			salesMinor: 0,
		})
	})
})

describe('the Estimated missed online sales report (#176)', () => {
	const definition = createReportDefinition({
		subject: 'missed_online_sales',
		timeframe: {
			field: 'startedAt',
			preset: 'custom',
			start: new Date(at(0, 0)).toISOString(),
			end: new Date(at(1, 0)).toISOString(),
		},
		columns: ['startedAt', 'location', 'minutesPaused', 'estimatedOrders', 'estimatedSales', 'weeksUsed'],
		visualization: { chartStyle: 'table', measure: 'count', sortBy: 'none', hideCounts: false },
		settings: { title: 'Missed', notes: '', timezone: 'UTC' },
	})

	it('lists each pause with its estimate and leaves it blank, not zero, when there is not enough history', async () => {
		// Open every day of the weeks before, so every week is comparable.
		const openWindows = Array.from({ length: 40 }, (_, i) => ({
			from: at(-35 + i, 12),
			to: at(-35 + i, 22),
		}))
		fake.history = historyOf({
			openWindows,
			pauses: [{ from: at(0, 18), to: at(0, 20) }],
		})
		const db = await getTenantDb(ORG)
		void db
		for (const k of [1, 2, 3, 4]) {
			await (async () => {
				const d = await getTenantDb(ORG)
				await d.insert(restaurantOrders).values({
					orgId: ORG,
					number: `R-${k}`,
					status: 'completed',
					paymentMethod: 'handoff',
					paymentStatus: 'unpaid',
					fulfillment: 'pickup',
					locationId: LOC,
					locationName: 'Olaya',
					contactName: 'Guest',
					contactPhone: '+966500000000',
					currency: 'sar',
					subtotalCents: 5000,
					taxCents: 0,
					totalCents: 5000,
					lines: [],
					idempotencyKey: `idem-r-${k}`,
					requestHash: 'hash',
					receiptTokenHash: `receipt-r-${k}`,
					createdAt: new Date(at(-7 * k, 19)),
				})
			})()
		}
		const res = await app.request('/analytics/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as any
		expect(body.rows).toHaveLength(1)
		expect(body.rows[0]).toMatchObject({
			location: 'Olaya',
			weeksUsed: '4',
		})
		expect(body.rows[0].estimatedOrders).toBe('1')
		// A pause with one comparable week only: no estimate, an empty cell.
		fake.history = historyOf({
			openWindows: [{ from: at(0, 12), to: at(0, 22) }, { from: at(-7, 12), to: at(-7, 22) }],
			pauses: [{ from: at(0, 18), to: at(0, 20) }],
		})
		const thin = (await (
			await app.request('/analytics/query', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${await token()}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ definition }),
			})
		).json()) as any
		expect(thin.rows[0].estimatedOrders).toBe('—')
		expect(thin.rows[0].weeksUsed).toBe('1')
		// No history from the control plane: it says so rather than guessing.
		fake.history = () => null
		const down = await app.request('/analytics/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
		expect(down.status).toBe(503)
	})
})
