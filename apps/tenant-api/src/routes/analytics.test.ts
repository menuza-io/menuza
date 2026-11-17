import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createReportDefinition,
	isSalesReportSubject,
	organizationTemplates,
	type ReportDefinition,
	type TimeframePreset,
} from '@repo/reports'
import {
	mintOperatorAnalyticsToken,
	ORDER_REPORT_SUBJECTS,
	ORG_WIDE_REPORT_SUBJECTS,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	voiceCalls,
} from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import {
	analyticsRoutes,
	loadPhoneCallRecords,
	mapPhoneCalls,
	type PhoneCallReportRow,
} from './analytics.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
}))

const day = 86_400_000
const base = new Date('2026-03-01T12:00:00Z').getTime()

function row(overrides: Partial<PhoneCallReportRow> = {}): PhoneCallReportRow {
	return {
		startedAt: new Date(base),
		callerPhone: '+15550001111',
		channel: 'phone',
		purpose: 'ordering',
		outcome: 'resolved',
		transferResult: 'none',
		calledWhileOpen: true,
		durationSeconds: 30,
		linkSent: false,
		followUpStatus: 'resolved',
		rating: null,
		sentiment: null,
		...overrides,
	}
}

describe('mapPhoneCalls', () => {
	it('maps call rows to report fields with fallbacks', () => {
		const [record] = mapPhoneCalls([
			row({
				purpose: null,
				outcome: null,
				calledWhileOpen: null,
				callerPhone: null,
				durationSeconds: null,
			}),
		])
		expect(record).toEqual({
			startedAt: new Date(base),
			callerPhone: '',
			channel: 'phone',
			purpose: 'unknown',
			outcome: 'unknown',
			resolvedByAssistant: false,
			transferResult: 'none',
			calledWhileOpen: false,
			durationBucket: 'under_1',
			linkSent: false,
			repeatCaller: false,
			followUpStatus: 'resolved',
			rating: 'none',
			sentiment: 'unknown',
		})
	})

	it('buckets durations', () => {
		const buckets = mapPhoneCalls(
			[59, 60, 179, 180, 299, 300].map((durationSeconds, index) =>
				row({ durationSeconds, callerPhone: `+1555000000${index}` }),
			),
		).map((record) => record.durationBucket)
		expect(buckets).toEqual([
			'under_1',
			'1_to_3',
			'1_to_3',
			'3_to_5',
			'3_to_5',
			'over_5',
		])
	})

	it('counts calls handled without staff', () => {
		const records = mapPhoneCalls([
			row({ outcome: 'resolved' }),
			row({ outcome: 'link_sent' }),
			row({ outcome: 'resolved', transferResult: 'answered' }),
			row({ outcome: 'message_taken' }),
		])
		expect(records.map((record) => record.resolvedByAssistant)).toEqual([
			true,
			true,
			false,
			false,
		])
	})

	it('maps ratings and sentiment', () => {
		const records = mapPhoneCalls([
			row({ rating: 4, sentiment: 'negative', followUpStatus: 'open' }),
		])
		expect(records[0]).toMatchObject({
			rating: '4',
			sentiment: 'negative',
			followUpStatus: 'open',
		})
	})

	it('flags repeat callers within the previous 30 days', () => {
		const records = mapPhoneCalls([
			row({ startedAt: new Date(base + 10 * day) }),
			row({ startedAt: new Date(base) }),
			row({ startedAt: new Date(base + 45 * day) }),
			row({
				startedAt: new Date(base + 46 * day),
				callerPhone: '+15550002222',
			}),
		])
		expect(records.map((record) => record.repeatCaller)).toEqual([
			true,
			false,
			false,
			false,
		])
	})

	it('finds repeat callers in calls from before the report window', () => {
		const records = mapPhoneCalls(
			[
				row({ startedAt: new Date(base + 40 * day) }),
				row({ startedAt: new Date(base + 40 * day), callerPhone: '+1555' }),
			],
			[{ startedAt: new Date(base + 20 * day), callerPhone: '+15550001111' }],
		)
		expect(records).toHaveLength(2)
		expect(records.map((record) => record.repeatCaller)).toEqual([true, false])
	})
})

describe('loadPhoneCallRecords', () => {
	const orgId = 'clw9x0a12000008l00report01'
	const now = new Date('2026-03-20T12:00:00Z')
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-report-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function definition(preset: TimeframePreset) {
		return createReportDefinition({
			subject: 'phone_calls',
			timeframe: { field: 'startedAt', preset },
			visualization: {
				chartStyle: 'single_number',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Calls', notes: '', timezone: 'user' },
		})
	}

	async function insertCalls(
		calls: Array<{ daysAgo: number; phone: string | null }>,
	) {
		const db = await getTenantDb(orgId)
		await db.insert(voiceCalls).values(
			calls.map(({ daysAgo, phone }, index) => ({
				channel: 'phone' as const,
				roomName: `room-${index}`,
				callerPhone: phone,
				startedAt: new Date(now.getTime() - daysAgo * day),
			})),
		)
		return db
	}

	it('reads only the window plus a 30 day repeat-caller lookback', async () => {
		const db = await insertCalls([
			{ daysAgo: 1, phone: '+15550000001' },
			{ daysAgo: 2, phone: '+15550000002' },
			{ daysAgo: 3, phone: '+15550000003' },
			// Before the window, inside the lookback: makes 0001 a repeat.
			{ daysAgo: 20, phone: '+15550000001' },
			// Older than the lookback: 0002 is not a repeat.
			{ daysAgo: 45, phone: '+15550000002' },
		])
		const { records, truncated } = await loadPhoneCallRecords(
			db,
			definition('last_7_days'),
			now,
		)
		expect(truncated).toBe(false)
		expect(
			records.map((record) => [record.callerPhone, record.repeatCaller]),
		).toEqual([
			['+15550000001', true],
			['+15550000002', false],
			['+15550000003', false],
		])
	})

	it('keeps the most recent calls when the cap is hit', async () => {
		const db = await insertCalls([
			{ daysAgo: 1, phone: '+15550000001' },
			{ daysAgo: 2, phone: '+15550000002' },
			// Dropped by the cap, but still an earlier call for 0002.
			{ daysAgo: 3, phone: '+15550000002' },
			{ daysAgo: 400, phone: null },
		])
		const { records, truncated } = await loadPhoneCallRecords(
			db,
			definition('all_time'),
			now,
			2,
		)
		expect(truncated).toBe(true)
		expect(
			records.map((record) => [record.callerPhone, record.repeatCaller]),
		).toEqual([
			['+15550000001', false],
			['+15550000002', true],
		])
	})

	it('serves phone call reports from the bounded loader', async () => {
		await insertCalls([
			{ daysAgo: 0, phone: '+15550000001' },
			{ daysAgo: 40, phone: '+15550000002' },
		])
		const internalCommandToken = 'analytics-internal-token-1234567890'
		const previousToken = process.env.OPERATOR_ANALYTICS_TOKEN
		process.env.OPERATOR_ANALYTICS_TOKEN = internalCommandToken
		process.env.DATA_REGION = 'us'
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'report',
			name: 'Report',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.useFakeTimers({ now, toFake: ['Date'] })
		try {
			const { token } = await mintOperatorAnalyticsToken({
				signingSecret: internalCommandToken,
				userId: 'user_1',
				orgId,
				role: 'admin',
				subjects: ['phone_calls'],
			})
			const res = await analyticsRoutes.request('/query', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ definition: definition('last_30_days') }),
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body).toMatchObject({ total: 1 })
			expect(body).not.toHaveProperty('sourceTruncated')
		} finally {
			vi.useRealTimers()
			process.env.OPERATOR_ANALYTICS_TOKEN = previousToken ?? ''
		}
	})
})

describe('POST /query', () => {
	const internalCommandToken = 'analytics-internal-token-1234567890'
	const previousToken = process.env.OPERATOR_ANALYTICS_TOKEN
	afterEach(() => {
		process.env.OPERATOR_ANALYTICS_TOKEN = previousToken
	})

	it('refuses phone call reports without the phone call permission', async () => {
		process.env.OPERATOR_ANALYTICS_TOKEN = internalCommandToken
		const definition = organizationTemplates().find(
			(template) => template.definition.subject === 'phone_calls',
		)!.definition
		const { token } = await mintOperatorAnalyticsToken({
			signingSecret: internalCommandToken,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'admin',
		})
		const res = await analyticsRoutes.request('/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({ error: 'forbidden_subject' })
	})
})

describe('POST /query order reports', () => {
	const internalCommandToken = 'analytics-internal-token-1234567890'
	const orgId = 'clw9x0a12000008l00report02'
	const now = new Date('2026-03-20T12:00:00Z')
	const previousToken = process.env.OPERATOR_ANALYTICS_TOKEN
	let tempDir: string

	beforeEach(async () => {
		process.env.OPERATOR_ANALYTICS_TOKEN = internalCommandToken
		process.env.DATA_REGION = 'us'
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-order-report-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'orders',
			name: 'Orders',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.useFakeTimers({ now, toFake: ['Date'] })
	})

	afterEach(async () => {
		vi.useRealTimers()
		process.env.OPERATOR_ANALYTICS_TOKEN = previousToken ?? ''
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function templateDefinition(id: string) {
		return organizationTemplates().find((template) => template.id === id)!
			.definition
	}

	async function query(
		definition: ReportDefinition,
		subjects: readonly RestrictedReportSubject[] = [],
	) {
		const granted = [...ORG_WIDE_REPORT_SUBJECTS, ...subjects]
		const { token } = await mintOperatorAnalyticsToken({
			signingSecret: internalCommandToken,
			userId: 'user_1',
			orgId,
			role: 'operator',
			// An analytics-access token always lists the organization-wide subjects.
			subjects: granted,
			...(granted.some((subject) => isSalesReportSubject(subject))
				? { locationIds: null as const }
				: {}),
		})
		const res = await analyticsRoutes.request('/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
		return {
			status: res.status,
			body: (await res.json()) as Record<string, unknown>,
		}
	}

	async function insertAda() {
		const db = await getTenantDb(orgId)
		const [ada] = await db
			.insert(customers)
			.values({
				name: 'Ada',
				phone: '+15550000001',
				createdAt: new Date(now.getTime() - 30 * day),
			})
			.returning({ id: customers.id })
		return { db, adaId: ada!.id }
	}

	it.each([
		'channel-sales-by-channel',
		'refunds-by-reason',
		'cancelled-by-reason',
	])('refuses the %s sales report without menu access', async (id) => {
		const { status, body } = await query(templateDefinition(id))
		expect(status).toBe(403)
		expect(body).toMatchObject({ error: 'forbidden_subject' })
	})

	it.each(['sales-total', 'items-top-sellers', 'option-group-sales'])(
		'refuses the %s report without menu access',
		async (id) => {
			const { status, body } = await query(templateDefinition(id))
			expect(status).toBe(403)
			expect(body).toMatchObject({ error: 'forbidden_subject' })
		},
	)

	it.each([
		'customers-average-spend',
		'customers-first-order-by-month',
		'customers-recent',
	])(
		'refuses the %s report, which reads order history, without menu access',
		async (id) => {
			const { status, body } = await query(templateDefinition(id))
			expect(status).toBe(403)
			expect(body).toMatchObject({
				error: 'forbidden_subject',
				message: 'You do not have permission to report on order data.',
			})
		},
	)

	it('serves customer reports that skip order history without menu access', async () => {
		await insertAda()
		const { status, body } = await query(templateDefinition('customer-count'))
		expect(status).toBe(200)
		expect(body).toMatchObject({ total: 1 })
	})

	it('serves sales and customer spend from orders that count toward sales', async () => {
		const { db, adaId } = await insertAda()
		const order = (
			number: string,
			daysAgo: number,
			values: Partial<typeof restaurantOrders.$inferInsert>,
		): typeof restaurantOrders.$inferInsert => ({
			orgId,
			number,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: 'loc_1',
			locationName: 'Downtown',
			contactName: 'Ada',
			contactPhone: '+15550000001',
			currency: 'usd',
			subtotalCents: 1000,
			taxCents: 100,
			totalCents: 1100,
			lines: [],
			idempotencyKey: `idempotency-${number}`,
			requestHash: 'request-hash',
			receiptTokenHash: `receipt-${number}`,
			createdAt: new Date(now.getTime() - daysAgo * day),
			...values,
		})
		await db.insert(restaurantOrders).values([
			order('A1', 2, { customerId: adaId }),
			// A paid guest checkout with Ada's number.
			order('A2', 1, {
				status: 'preparing',
				paymentMethod: 'online',
				paymentStatus: 'paid',
				contactPhone: '(555) 000-0001',
				totalCents: 2000,
			}),
			order('A3', 1, {
				status: 'accepted',
				paymentMethod: 'online',
				paymentStatus: 'pending',
				holdExpiresAt: new Date(now.getTime() + 600_000),
				totalCents: 5000,
			}),
			order('A4', 1, { status: 'cancelled', totalCents: 7000 }),
		])

		const sales = await query(
			templateDefinition('sales-total'),
			ORDER_REPORT_SUBJECTS,
		)
		expect(sales.status).toBe(200)
		expect(sales.body).toMatchObject({
			total: 2,
			value: 31,
			valueInfo: {
				measure: 'sum',
				field: 'total',
				type: 'currency',
				currency: 'USD',
			},
		})
		expect(sales.body).not.toHaveProperty('sourceTruncated')

		const spend = await query(
			templateDefinition('customers-average-spend'),
			ORDER_REPORT_SUBJECTS,
		)
		expect(spend.status).toBe(200)
		expect(spend.body).toMatchObject({ total: 1, value: 31 })
	})
})

describe('GET /today', () => {
	const internalCommandToken = 'analytics-internal-token-1234567890'
	const orgId = 'clw9x0a12000008l00today001'
	// 15:30 in New York (EDT), 22:30 in Riyadh, the same instant.
	const now = new Date('2026-06-10T19:30:00Z')
	const previousToken = process.env.OPERATOR_ANALYTICS_TOKEN
	let tempDir: string

	beforeEach(async () => {
		process.env.OPERATOR_ANALYTICS_TOKEN = internalCommandToken
		process.env.DATA_REGION = 'us'
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-today-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'today',
			name: 'Today',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.useFakeTimers({ now, toFake: ['Date'] })
	})

	afterEach(async () => {
		vi.useRealTimers()
		process.env.OPERATOR_ANALYTICS_TOKEN = previousToken ?? ''
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function tokenFor(
		subjects: readonly RestrictedReportSubject[],
		tokenOrgId = orgId,
	) {
		const { token } = await mintOperatorAnalyticsToken({
			signingSecret: internalCommandToken,
			userId: 'user_1',
			orgId: tokenOrgId,
			role: 'operator',
			subjects: [...subjects],
			...(subjects.some((subject) => isSalesReportSubject(subject))
				? { locationIds: null as const }
				: {}),
		})
		return token
	}

	async function today(
		locations: Array<[string, string]>,
		token?: string,
		salesBasis: 'gross' | 'net' = 'net',
	): Promise<{ status: number; body: Record<string, any> }> {
		const query = new URLSearchParams({
			locationIds: locations.map(([id]) => id).join(','),
			timeZones: locations.map(([, zone]) => zone).join(','),
			salesBasis,
		})
		const res = await analyticsRoutes.request(`/today?${query}`, {
			headers: {
				Authorization: `Bearer ${token ?? (await tokenFor(ORDER_REPORT_SUBJECTS))}`,
			},
		})
		return { status: res.status, body: (await res.json()) as any }
	}

	let sequence = 0
	function order(
		values: Partial<typeof restaurantOrders.$inferInsert>,
	): typeof restaurantOrders.$inferInsert {
		sequence += 1
		const number = `T${sequence}`
		return {
			orgId,
			number,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: 'loc_ny',
			locationName: 'New York',
			contactName: 'Guest',
			contactPhone: `+1555000${String(sequence).padStart(4, '0')}`,
			currency: 'usd',
			subtotalCents: 1000,
			taxCents: 0,
			totalCents: 1000,
			lines: [],
			idempotencyKey: `idempotency-${number}`,
			requestHash: 'request-hash',
			receiptTokenHash: `receipt-${number}`,
			createdAt: now,
			...values,
		}
	}

	it('refuses a token without the order grant', async () => {
		const { status, body } = await today(
			[['loc_ny', 'America/New_York']],
			await tokenFor([]),
		)
		expect(status).toBe(403)
		expect(body).toMatchObject({ error: 'forbidden_subject' })
	})

	it('refuses forged tokens', async () => {
		const { token } = await mintOperatorAnalyticsToken({
			signingSecret: 'some-other-signing-secret-123456',
			userId: 'user_1',
			orgId,
			role: 'operator',
			subjects: [...ORDER_REPORT_SUBJECTS],
			locationIds: null,
		})
		const { status } = await today([['loc_ny', 'America/New_York']], token)
		expect(status).toBe(401)
	})

	it('refuses mismatched or invalid location lists', async () => {
		const query = new URLSearchParams({
			locationIds: 'loc_ny,loc_ruh',
			timeZones: 'America/New_York',
		})
		const res = await analyticsRoutes.request(`/today?${query}`, {
			headers: {
				Authorization: `Bearer ${await tokenFor(ORDER_REPORT_SUBJECTS)}`,
			},
		})
		expect(res.status).toBe(400)
		const bad = await today([['loc_ny', 'Not/AZone']])
		expect(bad.status).toBe(400)
	})

	it('matches net sales from counted orders for the same day and location', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(restaurantOrders).values([
			order({ subtotalCents: 1250, totalCents: 1250 }),
			order({
				subtotalCents: 2000,
				totalCents: 2000,
				paymentMethod: 'online',
				paymentStatus: 'paid',
				status: 'preparing',
			}),
			// Not counted: cancelled, and online still waiting on payment.
			order({ totalCents: 9000, status: 'cancelled' }),
			order({
				totalCents: 7000,
				status: 'accepted',
				paymentMethod: 'online',
				paymentStatus: 'pending',
				holdExpiresAt: new Date(now.getTime() + 600_000),
			}),
			// Yesterday in New York.
			order({
				subtotalCents: 500,
				totalCents: 500,
				createdAt: new Date(now.getTime() - day),
			}),
		])

		const { status, body } = await today([['loc_ny', 'America/New_York']])
		expect(status).toBe(200)
		expect(body.today).toEqual([
			{ currency: 'USD', salesMinor: 3250, orders: 2 },
		])
		expect(body.yesterday).toEqual([
			{ currency: 'USD', salesMinor: 500, orders: 1 },
		])
		expect(body.lastWeek).toEqual([])
		expect(body.salesBasis).toBe('net')

		const gross = await today(
			[['loc_ny', 'America/New_York']],
			undefined,
			'gross',
		)
		expect(gross.body.today[0].salesMinor).toBe(3250)
	})

	it('counts each location over its own business day', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(restaurantOrders).values([
			// 01:00 in Riyadh today, 18:00 yesterday in New York.
			order({
				locationId: 'loc_ruh',
				currency: 'sar',
				subtotalCents: 4000,
				totalCents: 4000,
				createdAt: new Date('2026-06-09T22:00:00Z'),
			}),
			// Not today in New York, and after 15:30 yesterday: in neither.
			order({
				locationId: 'loc_ny',
				subtotalCents: 700,
				totalCents: 700,
				createdAt: new Date('2026-06-09T22:00:00Z'),
			}),
			// 12:00 yesterday in New York: yesterday up to this time.
			order({
				locationId: 'loc_ny',
				subtotalCents: 1500,
				totalCents: 1500,
				createdAt: new Date('2026-06-09T16:00:00Z'),
			}),
			// 06:00 in New York today, 13:00 in Riyadh today.
			order({
				locationId: 'loc_ny',
				subtotalCents: 2500,
				totalCents: 2500,
				createdAt: new Date('2026-06-10T10:00:00Z'),
			}),
		])
		const { body } = await today([
			['loc_ny', 'America/New_York'],
			['loc_ruh', 'Asia/Riyadh'],
		])
		// Two currencies, never summed.
		expect(body.today).toEqual([
			{ currency: 'SAR', salesMinor: 4000, orders: 1 },
			{ currency: 'USD', salesMinor: 2500, orders: 1 },
		])
		expect(body.yesterday).toEqual([
			{ currency: 'USD', salesMinor: 1500, orders: 1 },
		])
	})

	it('counts distinct guests, first-time and returning, with totals only', async () => {
		const db = await getTenantDb(orgId)
		const [ada] = await db
			.insert(customers)
			.values({ name: 'Ada', phone: '+15550009999' })
			.returning({ id: customers.id })
		await db.insert(restaurantOrders).values([
			// Ada ordered last month and twice today: one returning guest.
			order({
				customerId: ada!.id,
				contactName: 'Ada',
				createdAt: new Date(now.getTime() - 30 * day),
			}),
			order({ customerId: ada!.id, contactName: 'Ada' }),
			order({ contactPhone: '(555) 000-9999', contactName: 'Ada' }),
			// Two new guests.
			order({ contactName: 'Grace' }),
			order({ contactName: 'Linus' }),
		])
		const { body } = await today([['loc_ny', 'America/New_York']])
		expect(body.guests).toEqual({ total: 3, firstTime: 2, returning: 1 })
		const text = JSON.stringify(body)
		for (const pii of ['Ada', 'Grace', 'Linus', '555', ada!.id]) {
			expect(text).not.toContain(pii)
		}
	})
})
