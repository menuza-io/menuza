import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createReportDefinition, type ReportDefinition } from '@repo/reports'
import {
	DELIVERY_REPORT_SUBJECTS,
	mintOperatorAnalyticsToken,
	SALES_STAFF_FIELD_PERMISSION,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import {
	deliveryRuns,
	deliveryRunStops,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	staffMembers,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { recordOrderStep } from '../services/order-steps.ts'
import { analyticsRoutes } from './analytics.ts'

/**
 * Own-driver delivery reports (#324): deliveries and times per driver, cash and
 * tips, problems; the driver's name only with the staff grant; zones, never an
 * address; limited by the token's subjects, locations and organization.
 */

const SECRET = 'test-deliveries-analytics-signing-secret-32chars!!'
const ORG = 'org_delivery_report_a'
const ORG_B = 'org_delivery_report_b'
const LOC = 'loc-a'
const LOC_B = 'loc-b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))
// Zone names come from the App's order context: here, two zones by id.
vi.mock('../services/order-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/order-service.ts')>()),
	fetchOrderContext: vi.fn(async () => ({
		ok: true,
		data: {
			menu: {
				locations: [
					{
						id: LOC,
						deliveryZones: [
							{ id: 'zone-downtown', name: 'Downtown' },
							{ id: 'zone-north', name: 'North side' },
						],
					},
				],
			},
		},
	})),
}))

const app = new Hono()
app.route('/analytics', analyticsRoutes)

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 5, 12, 0) // a past Monday, noon UTC
const RANGE = {
	field: 'deliveredAt',
	preset: 'custom' as const,
	start: new Date(T0 - 24 * 60 * MIN).toISOString(),
	end: new Date(T0 + 24 * 60 * MIN).toISOString(),
}

async function token(
	options: {
		orgId?: string
		subjects?: readonly RestrictedReportSubject[]
		locationIds?: readonly string[] | null
	} = {},
) {
	const { token } = await mintOperatorAnalyticsToken({
		signingSecret: SECRET,
		userId: 'usr_report',
		orgId: options.orgId ?? ORG,
		role: 'operator',
		subjects: options.subjects ?? [...DELIVERY_REPORT_SUBJECTS],
		scopeIds: null,
		locationIds: options.locationIds === undefined ? null : options.locationIds,
	})
	return token
}

function definition(
	subject: 'deliveries' | 'driver_deliveries',
	extra: Partial<Parameters<typeof createReportDefinition>[0]> = {},
): ReportDefinition {
	return createReportDefinition({
		subject,
		timeframe: { ...RANGE, field: subject === 'deliveries' ? 'deliveredAt' : 'periodEnd' },
		visualization: { chartStyle: 'table', measure: 'count', sortBy: 'none', hideCounts: false },
		settings: { title: 'Deliveries', notes: '', timezone: 'UTC', includeToday: true, hidePartial: false },
		...extra,
	} as never)
}

const run = async (def: ReportDefinition, jwt: string) =>
	app.request('/analytics/query', {
		method: 'POST',
		headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ definition: def, timeZone: 'UTC' }),
	})

let dir: string
let ana: string
let ben: string

/** One stop with every time given in minutes after T0, written like the service writes it. */
async function stop(options: {
	orgId?: string
	driver: string
	locationId?: string
	status?: 'delivered' | 'problem'
	problem?: string
	placed: number
	ready: number
	pickedUp: number
	ended: number
	promisedUntil?: number | null
	cash?: number
	tipCents?: number
	zoneId?: string
	runId?: string
}) {
	const db = await getTenantDb(options.orgId ?? ORG)
	const orderId = crypto.randomUUID()
	await db.insert(restaurantOrders).values({
		id: orderId,
		orgId: options.orgId ?? ORG,
		number: `D-${orderId.slice(0, 4)}`,
		status: 'completed',
		paymentMethod: 'handoff',
		paymentStatus: 'paid',
		fulfillment: 'delivery',
		locationId: options.locationId ?? LOC,
		locationName: 'Main',
		locationTimezone: 'UTC',
		contactName: 'Layla Guest',
		contactPhone: '+15551234567',
		contactEmail: 'layla@example.com',
		currency: 'USD',
		subtotalCents: 2500,
		taxCents: 0,
		tipCents: options.tipCents ?? 0,
		totalCents: 2500,
		deliveryAddress: '233 South Wacker Drive, Chicago',
		deliveryUnit: 'Suite 4',
		deliveryNotes: 'Front desk',
		deliveryZoneId: options.zoneId ?? 'zone-downtown',
		createdAt: new Date(T0 + options.placed * MIN),
		promisedUntil:
			options.promisedUntil === null || options.promisedUntil === undefined
				? null
				: new Date(T0 + options.promisedUntil * MIN),
		lines: [],
		idempotencyKey: crypto.randomUUID(),
		requestHash: 'x',
		receiptTokenHash: 'y',
	})
	await recordOrderStep(
		db,
		orderId,
		{ actorKind: 'operator', actorId: 'u', source: 'app', step: 'ready', at: T0 + options.ready * MIN },
		T0 + options.ready * MIN,
	)
	const [created] = await db
		.insert(deliveryRuns)
		.values({
			locationId: options.locationId ?? LOC,
			driverStaffId: options.driver,
			status: 'completed',
			createdByKind: 'manager',
			createdAt: T0 + options.ready * MIN,
			completedAt: T0 + options.ended * MIN,
		})
		.returning()
	const delivered = (options.status ?? 'delivered') === 'delivered'
	await db.insert(deliveryRunStops).values({
		runId: created!.id,
		orderId,
		stopNo: 1,
		status: options.status ?? 'delivered',
		cashDueCents: options.cash ?? 0,
		cashCollectedCents: delivered ? (options.cash ?? 0) : 0,
		zoneId: options.zoneId ?? 'zone-downtown',
		problemKind: delivered ? null : ((options.problem ?? 'not_home') as 'not_home'),
		createdAt: T0 + options.ready * MIN,
		pickedUpAt: T0 + options.pickedUp * MIN,
		...(delivered
			? { deliveredAt: T0 + options.ended * MIN, deliveredByKind: 'driver' as const }
			: { problemAt: T0 + options.ended * MIN }),
	})
}

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'delivery-report-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.OPERATOR_ANALYTICS_TOKEN = SECRET
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, { id, slug: id, customDomain: null, hasProvisionedDb: true, dataRegion: 'us', name: id })
		await provisionTenantDb(id)
	}
	const db = await getTenantDb(ORG)
	ana = crypto.randomUUID()
	ben = crypto.randomUUID()
	await db.insert(staffMembers).values([
		{ id: ana, firstName: 'Ana', lastName: 'Driver' },
		{ id: ben, firstName: 'Ben', lastName: 'Rider' },
	])
	// Ana: two deliveries. #1: ready +20, picked up +25, delivered +40, promised +40 (on time),
	// cash 25.00, tip 3.00, Downtown. #2: ready +30, picked up +40, delivered +70, promised +60
	// (10 minutes late), North side, tip 1.00.
	await stop({ driver: ana, placed: 0, ready: 20, pickedUp: 25, ended: 40, promisedUntil: 40, cash: 2500, tipCents: 300 })
	await stop({ driver: ana, placed: 10, ready: 30, pickedUp: 40, ended: 70, promisedUntil: 60, tipCents: 100, zoneId: 'zone-north' })
	// Ben: one delivery (ready +10, picked up +30, delivered +50, no promised time) and one problem.
	await stop({ driver: ben, placed: 0, ready: 10, pickedUp: 30, ended: 50, promisedUntil: null })
	await stop({ driver: ben, placed: 5, ready: 15, pickedUp: 35, ended: 55, status: 'problem', problem: 'not_home' })
	// Ben at another location, outside a location-limited token.
	await stop({ driver: ben, locationId: LOC_B, placed: 0, ready: 10, pickedUp: 20, ended: 60, promisedUntil: 90 })
})
afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id)
	rmSync(dir, { recursive: true, force: true })
})

const rowOf = (body: { rows: Array<Record<string, string>> }, driver: string) =>
	body.rows.find((row) => row.driver === driver)

describe('Deliveries by driver (#324)', () => {
	it('shows deliveries, times, late deliveries, cash, tips and problems per driver', async () => {
		const response = await run(definition('driver_deliveries'), await token({ subjects: [...DELIVERY_REPORT_SUBJECTS, SALES_STAFF_FIELD_PERMISSION] }))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.columns.map((c: { id: string }) => c.id)).toEqual([
			'driver',
			'deliveries',
			'avgMinutesReadyToPickedUp',
			'avgMinutesPickedUpToDelivered',
			'lateDeliveries',
			'cashCollected',
			'tips',
			'problems',
		])
		expect(body.total).toBe(2)
		const a = rowOf(body, 'Ana Driver')!
		expect(a).toMatchObject({ deliveries: '2', lateDeliveries: '1' })
		// Ready to picked up: (5 + 10) / 2 = 7.5; picked up to delivered: (15 + 30) / 2 = 22.5.
		expect(a.avgMinutesReadyToPickedUp).toMatch(/7\.5/)
		expect(a.avgMinutesPickedUpToDelivered).toMatch(/22\.5/)
		expect(a.cashCollected).toMatch(/25\.00/)
		expect(a.tips).toMatch(/4\.00/)
		expect(a.problems).toBe('0')
		const b = rowOf(body, 'Ben Rider')!
		// Ben at LOC: one delivery, one problem; the other location's delivery counts too (no location filter).
		expect(b).toMatchObject({ deliveries: '2', problems: '1' })
		// Rows name the driver so the screen can open that driver's deliveries.
		expect(body.rows.every((row: Record<string, string>) => typeof row.__ref === 'string' && row.__ref)).toBe(true)
	})

	it('narrows to a location, like the report asks', async () => {
		const only = definition('driver_deliveries', {
			filters: { combinator: 'and', conditions: [{ field: 'locationId', operator: 'eq', value: LOC }] },
		} as never)
		const body = await (await run(only, await token({ subjects: [...DELIVERY_REPORT_SUBJECTS, SALES_STAFF_FIELD_PERMISSION] }))).json()
		expect(rowOf(body, 'Ben Rider')).toMatchObject({ deliveries: '1', problems: '1' })
		expect(rowOf(body, 'Ana Driver')).toMatchObject({ deliveries: '2' })
	})

	it('shows totals without names to a member without the staff grant', async () => {
		const response = await run(definition('driver_deliveries'), await token())
		expect(response.status).toBe(200)
		const text = await response.text()
		expect(text).not.toMatch(/Ana|Ben|Driver Ana|Rider/)
		const body = JSON.parse(text)
		expect(body.rows.map((row: Record<string, string>) => row.driver).sort()).toEqual(['Driver 1', 'Driver 2'])
		// The figures are the same as with names.
		const totals = body.rows.map((row: Record<string, string>) => Number(row.deliveries)).sort()
		expect(totals).toEqual([2, 2])
		// The row ids do not carry staff ids either.
		for (const row of body.rows) expect(row.__ref).toMatch(/^driver-\d+$/)
		expect(text).not.toContain(ana)
		expect(text).not.toContain(ben)
	})

	it('opens one driver\'s deliveries for the period, with a zone and no address', async () => {
		const jwt = await token({ subjects: [...DELIVERY_REPORT_SUBJECTS, SALES_STAFF_FIELD_PERMISSION] })
		const summary = await (await run(definition('driver_deliveries'), jwt)).json()
		const ref = summary.rows.find((row: Record<string, string>) => row.driver === 'Ana Driver').__ref
		const list = definition('deliveries', {
			filters: { combinator: 'and', conditions: [{ field: 'driverKey', operator: 'eq', value: ref }] },
		} as never)
		const response = await run(list, jwt)
		const text = await response.text()
		const body = JSON.parse(text)
		expect(body.total).toBe(2)
		expect(body.rows.map((row: Record<string, string>) => row.zone).sort()).toEqual(['Downtown', 'North side'])
		expect(body.rows.every((row: Record<string, string>) => row.driver === 'Ana Driver')).toBe(true)
		// Zones only: nothing a guest told us.
		expect(text).not.toMatch(/Wacker|Suite 4|Front desk|Layla|Guest|1555|layla@/i)
	})

	it('reports delivery times by hour and by zone, promised against actual', async () => {
		const jwt = await token()
		const byZone = await (
			await run(
				definition('deliveries', {
					groupBy: ['zone'],
					visualization: { chartStyle: 'bar', measure: 'average', valueField: 'minutesActual', sortBy: 'none', hideCounts: false },
					filters: { combinator: 'and', conditions: [{ field: 'outcome', operator: 'eq', value: 'delivered' }] },
				} as never),
				jwt,
			)
		).json()
		const downtown = byZone.segments.find((s: { label: string }) => s.label === 'Downtown')
		// Ana #1 (40 min) and Ben's delivery (50 min) in Downtown, plus Ben at the other location (60 min).
		expect(downtown.value).toBeCloseTo(50, 0)
		const promised = await (
			await run(
				definition('deliveries', {
					groupBy: ['zone'],
					visualization: { chartStyle: 'bar', measure: 'average', valueField: 'minutesPromised', sortBy: 'none', hideCounts: false },
				} as never),
				jwt,
			)
		).json()
		const north = promised.segments.find((s: { label: string }) => s.label === 'North side')
		expect(north.value).toBeCloseTo(50, 0) // placed +10, promised +60
		const byHour = await (
			await run(
				definition('deliveries', {
					groupBy: ['deliveredAt'],
					timeBucket: 'hour_of_day',
					visualization: { chartStyle: 'bar', measure: 'average', valueField: 'minutesActual', sortBy: 'label', hideCounts: false },
				} as never),
				jwt,
			)
		).json()
		// Deliveries end between 12:40 and 13:10 UTC: the 12:00 and 13:00 hours.
		expect(byHour.segments.map((s: { label: string }) => s.label).length).toBeGreaterThanOrEqual(1)
	})

	it('measures late against the promised time, and leaves out deliveries with none', async () => {
		const jwt = await token()
		const late = await (
			await run(
				definition('deliveries', {
					groupBy: ['zone'],
					visualization: { chartStyle: 'table', measure: 'ratio', valueField: 'lateRate', sortBy: 'none', hideCounts: false },
				} as never),
				jwt,
			)
		).json()
		const north = late.segments.find((s: { label: string }) => s.label === 'North side')
		expect(north.value).toBeCloseTo(100, 0) // the one promised delivery there was 10 minutes late
		const downtown = late.segments.find((s: { label: string }) => s.label === 'Downtown')
		// Promised and on time (equal is not late); Ben's with no promise is not judged.
		expect(downtown.value).toBeLessThan(100)
	})
})

describe('Delivery reports: who may run them (#324)', () => {
	it('refuses a token that does not list the subject, and an unknown organization', async () => {
		for (const subject of ['deliveries', 'driver_deliveries'] as const) {
			const noGrant = await run(definition(subject), await token({ subjects: [] }))
			expect(noGrant.status).toBe(403)
			expect((await noGrant.json()).error).toBe('forbidden_subject')
		}
		const forged = await run(definition('deliveries'), 'forged.token.value')
		expect(forged.status).toBe(401)
		const wrongSecret = await mintOperatorAnalyticsToken({
			signingSecret: 'another-signing-secret-that-is-long-enough-123',
			userId: 'u',
			orgId: ORG,
			role: 'operator',
			subjects: [...DELIVERY_REPORT_SUBJECTS],
			scopeIds: null,
		})
		expect((await run(definition('deliveries'), wrongSecret.token)).status).toBe(401)
	})

	it('limits a token to its locations, and keeps organizations apart', async () => {
		const jwt = await token({ locationIds: [LOC] })
		const own = await (await run(definition('deliveries'), jwt)).json()
		expect(own.total).toBe(4)
		const none = await (await run(definition('deliveries'), await token({ locationIds: [] }))).json()
		expect(none.total).toBe(0)
		// Another organization's token reads that organization's own (empty) database.
		const other = await (await run(definition('deliveries'), await token({ orgId: ORG_B }))).json()
		expect(other.total).toBe(0)
	})
})
