import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	createReportDefinition,
	monthlyAsOf,
	templatesFor,
} from '@repo/reports'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { runReportInRegion } from '../services/scheduled-report-service.ts'
import {
	reportsInternalRoutes,
	reportsPublicRoutes,
} from './reports-internal.ts'

/**
 * Scheduled report emails in the region (#121): the App's job posts a send
 * request; the region runs the report with the analytics engine, emails each
 * recipient and answers a status. Mocked email: nothing leaves the process.
 */

const ANALYTICS = 'test-reports-analytics-signing-secret-32chars!!'
const INTERNAL = 'test-internal-command-token-for-reports-32chars'
const HMAC = 'test-auth-hmac-secret-for-report-csv-links-32chars'
const ORG = 'org_report_send_a'
const ORG_B = 'org_report_send_b'
const KSA_ORG = 'org_report_send_ksa'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const app = new Hono()
app.route('/internal/reports', reportsInternalRoutes)
app.route('/reports', reportsPublicRoutes)

const NOW = '2026-11-27T14:00:00.000Z' // Friday 08:00 in Chicago; yesterday = Thu Nov 26
const THU = Date.UTC(2026, 10, 26, 18, 0) // Thu Nov 26, 12:00 Chicago
const LAST_THU = Date.UTC(2026, 10, 19, 18, 0)
const WED = Date.UTC(2026, 10, 25, 18, 0)

let dir: string
let seq = 0
async function sale(orgId: string, at: number, cents: number, tipCents = 0) {
	seq += 1
	const db = await getTenantDb(orgId)
	await db.insert(restaurantOrders).values({
		id: crypto.randomUUID(),
		orgId,
		number: `R-${seq}`,
		status: 'completed',
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		fulfillment: 'pickup',
		locationId: 'loc-a',
		locationName: 'Main',
		locationTimezone: 'America/Chicago',
		contactName: 'Layla Guest',
		contactPhone: '+15551234567',
		contactEmail: 'layla@example.com',
		currency: 'USD',
		subtotalCents: cents,
		taxCents: 0,
		tipCents,
		totalCents: cents + tipCents,
		createdAt: new Date(at),
		lines: [],
		idempotencyKey: crypto.randomUUID(),
		requestHash: 'x',
		receiptTokenHash: 'y',
	} as typeof restaurantOrders.$inferInsert)
}

const SALES_GRANTS = {
	subjects: [
		'orders',
		'order_items',
		'order_options',
		'sales',
		'order_refunds',
		'reviews',
	],
	scopeIds: null,
	locationIds: null,
	modules: [] as string[],
}

function request(over: Record<string, unknown> = {}) {
	return {
		orgId: ORG,
		scheduleId: 'sch_1',
		runKey: '2026-11-27',
		now: NOW,
		timeZone: 'America/Chicago',
		locale: 'en',
		organizationName: 'Acme Kitchen',
		reportUrl: 'https://app.example.test/acme/reports',
		report: { kind: 'daily_summary', reviews: { count: 3, previousCount: 1 } },
		recipients: [
			{
				userId: 'usr_owner',
				email: 'owner@example.com',
				grants: SALES_GRANTS,
				unsubscribeUrl: 'https://app.example.test/unsub?t=abc',
			},
		],
		...over,
	}
}

async function post(body: unknown, token: string | null = INTERNAL) {
	return app.request('/internal/reports/send', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	})
}

type SendResult = {
	results: Array<{ userId: string; status: string; reason?: string }>
}
const emailMock = vi.mocked(sendTenantEmail)

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'report-send-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.OPERATOR_ANALYTICS_TOKEN = ANALYTICS
	process.env.INTERNAL_COMMAND_TOKEN = INTERNAL
	process.env.AUTH_HMAC_SECRET = HMAC
	process.env.TENANT_API_URL = 'https://tenant.example.test'
	process.env.REPORT_EMAIL_ENABLED = 'true'
	emailMock.mockClear()
	for (const [id, region] of [
		[ORG, 'us'],
		[ORG_B, 'us'],
		[KSA_ORG, 'ksa'],
	] as const) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: region,
			name: id,
		} as PublishedOrganization)
	}
	await provisionTenantDb(ORG)
	await provisionTenantDb(ORG_B)
	await sale(ORG, THU, 10_000, 500) // yesterday: 100.00 net, 5.00 tip
	await sale(ORG, THU + 60_000, 5_000) // yesterday: 50.00
	await sale(ORG, LAST_THU, 8_000) // same weekday last week: 80.00
	await sale(ORG, WED, 99_900) // another weekday: in neither
	await sale(ORG_B, THU, 77_700) // another organization
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(dir, { recursive: true, force: true })
})

describe('POST /internal/reports/send: daily summary (#121)', () => {
	it('refuses a missing or wrong internal token', async () => {
		expect((await post(request(), null)).status).toBe(401)
		expect(
			(await post(request(), 'wrong-token-wrong-token-wrong')).status,
		).toBe(401)
		expect(emailMock).not.toHaveBeenCalled()
	})

	it("emails yesterday's numbers against the same weekday last week, with a CSV link and one-click unsubscribe", async () => {
		const res = await post(request())
		expect(res.status).toBe(200)
		expect(((await res.json()) as SendResult).results).toEqual([
			{ userId: 'usr_owner', status: 'sent' },
		])
		expect(emailMock).toHaveBeenCalledTimes(1)
		const sent = emailMock.mock.calls[0]![0]
		expect(sent.to).toBe('owner@example.com')
		expect(sent.subject).toContain('Daily summary')
		expect(sent.text).toContain('Net sales: $150.00')
		// Up 87.5% on last Thursday's $80.00.
		expect(sent.text).toContain('up 87.5%')
		expect(sent.text).toContain('Orders: 2')
		// Wednesday and the other organization never leak in.
		expect(sent.text).not.toContain('999')
		expect(sent.text).not.toContain('777')
		expect(sent.text).toContain('New reviews: 3')
		expect(sent.text).toContain('https://app.example.test/unsub?t=abc')
		expect(sent.extraHeaders).toMatchObject({
			'List-Unsubscribe': '<https://app.example.test/unsub?t=abc>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		})
		// No guest data in an aggregate email.
		expect(sent.html + sent.text).not.toMatch(/Layla|layla@|5551234567/)

		// The CSV link rebuilds the same figures.
		const csvUrl =
			/https:\/\/tenant\.example\.test\/reports\/csv\/[^\s"]+/.exec(
				sent.text,
			)![0]
		const url = new URL(csvUrl)
		const csv = await app.request(`${url.pathname}${url.search}`)
		expect(csv.status).toBe(200)
		expect(csv.headers.get('content-type')).toContain('text/csv')
		const body = await csv.text()
		expect(body).toContain('Net sales,$150.00,$80.00,up 87.5%')
	})

	it('leaves out the lines a recipient has no grant for, and skips one with none', async () => {
		const res = await post(
			request({
				recipients: [
					{
						userId: 'usr_viewer',
						email: 'viewer@example.com',
						grants: { ...SALES_GRANTS, subjects: [] },
						unsubscribeUrl: 'https://app.example.test/unsub?t=v',
					},
					{
						userId: 'usr_owner',
						email: 'owner@example.com',
						grants: SALES_GRANTS,
						unsubscribeUrl: 'https://app.example.test/unsub?t=o',
					},
				],
			}),
		)
		const body = (await res.json()) as SendResult
		expect(body.results).toEqual([
			{
				userId: 'usr_viewer',
				status: 'skipped_no_access',
				reason: 'no_access',
			},
			{ userId: 'usr_owner', status: 'sent' },
		])
		expect(emailMock).toHaveBeenCalledTimes(1)
		expect(emailMock.mock.calls[0]![0].to).toBe('owner@example.com')
		// No labor or covers line: those subjects were not granted.
		expect(emailMock.mock.calls[0]![0].text).not.toContain('Labor cost')
		expect(emailMock.mock.calls[0]![0].text).not.toContain('Covers')
	})

	it('shows two currencies side by side, never summed', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(restaurantOrders).values({
			id: crypto.randomUUID(),
			orgId: ORG,
			number: 'R-SAR',
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: 'loc-b',
			locationName: 'Riyadh',
			locationTimezone: 'Asia/Riyadh',
			contactName: 'x',
			contactPhone: '+966500000000',
			currency: 'SAR',
			subtotalCents: 37_500,
			taxCents: 0,
			totalCents: 37_500,
			createdAt: new Date(THU),
			lines: [],
			idempotencyKey: crypto.randomUUID(),
			requestHash: 'x',
			receiptTokenHash: 'y',
		} as typeof restaurantOrders.$inferInsert)
		await post(request())
		const text = emailMock.mock.calls[0]![0].text
		expect(text).toMatch(
			/Net sales: .*\$150\.00.*\/.*SAR|Net sales: .*SAR.*\/.*\$150\.00/,
		)
	})

	it('drops the send when the node kill switch is off', async () => {
		process.env.REPORT_EMAIL_ENABLED = 'false'
		const res = await post(request())
		expect(((await res.json()) as SendResult).results[0]).toMatchObject({
			status: 'dropped',
		})
		expect(emailMock).not.toHaveBeenCalled()
	})

	it('records a failed send per recipient without stopping the others', async () => {
		emailMock.mockResolvedValueOnce({
			status: 'error',
			error: { message: 'smtp down' },
		} as never)
		const res = await post(
			request({
				recipients: [
					{
						userId: 'usr_a',
						email: 'a@example.com',
						grants: SALES_GRANTS,
						unsubscribeUrl: 'https://app.example.test/unsub?t=a',
					},
					{
						userId: 'usr_b',
						email: 'b@example.com',
						grants: SALES_GRANTS,
						unsubscribeUrl: 'https://app.example.test/unsub?t=b',
					},
				],
			}),
		)
		expect(((await res.json()) as SendResult).results).toEqual([
			{ userId: 'usr_a', status: 'failed', reason: 'email_error' },
			{ userId: 'usr_b', status: 'sent' },
		])
	})

	it('renders Arabic for an Arabic recipient', async () => {
		await post(request({ locale: 'ar' }))
		const sent = emailMock.mock.calls[0]![0]
		expect(sent.html).toContain('dir="rtl"')
		expect(sent.text).toContain('الملخص اليومي')
	})
})

describe('POST /internal/reports/send: saved reports (#121)', () => {
	const salesReport = createReportDefinition({
		subject: 'sales',
		timeframe: { field: 'occurredAt', preset: 'yesterday' },
		groupBy: ['channel'],
		visualization: {
			chartStyle: 'table',
			measure: 'sum',
			valueField: 'netSales',
			sortBy: 'label',
		},
		settings: { title: 'Sales by channel', timezone: 'user' },
	})

	it('runs the saved definition with the analytics engine and emails the table', async () => {
		const res = await post(
			request({
				report: {
					kind: 'saved',
					title: 'Sales by channel',
					definition: salesReport,
				},
			}),
		)
		expect(((await res.json()) as SendResult).results[0]).toEqual({
			userId: 'usr_owner',
			status: 'sent',
		})
		const sent = emailMock.mock.calls[0]![0]
		expect(sent.subject).toContain('Sales by channel')
		expect(sent.text).toContain('Online menu')
		expect(sent.text).toContain('150')
	})

	it('refuses a report with a customer phone field (nothing is sent)', async () => {
		const personal = createReportDefinition({
			subject: 'orders',
			timeframe: { field: 'createdAt', preset: 'yesterday' },
			columns: ['number', 'customerPhone'],
			visualization: { chartStyle: 'table' },
			settings: { title: 'Orders with phones', timezone: 'user' },
		})
		const res = await post(
			request({
				report: { kind: 'saved', title: 'Orders', definition: personal },
			}),
		)
		expect(res.status).toBe(422)
		expect(((await res.json()) as { error: string }).error).toBe(
			'report_has_personal_fields',
		)
		expect(emailMock).not.toHaveBeenCalled()
	})

	it("skips a recipient who lost the grant for the report's subject", async () => {
		const res = await post(
			request({
				report: {
					kind: 'saved',
					title: 'Sales by channel',
					definition: salesReport,
				},
				recipients: [
					{
						userId: 'usr_lost',
						email: 'lost@example.com',
						grants: { ...SALES_GRANTS, subjects: ['customers'] },
						unsubscribeUrl: 'https://app.example.test/unsub?t=l',
					},
				],
			}),
		)
		expect(((await res.json()) as SendResult).results).toEqual([
			{ userId: 'usr_lost', status: 'skipped_no_access', reason: 'no_access' },
		])
		expect(emailMock).not.toHaveBeenCalled()
	})
})

describe('region and link rules (#121)', () => {
	it('a US node refuses a Saudi organization; the Saudi node serves it', async () => {
		const wrong = await post(request({ orgId: KSA_ORG }))
		expect(wrong.status).toBe(409)
		process.env.DATA_REGION = 'ksa'
		await provisionTenantDb(KSA_ORG)
		try {
			const ok = await post(request({ orgId: KSA_ORG }))
			expect(ok.status).toBe(200)
			expect(emailMock).toHaveBeenCalledTimes(1)
		} finally {
			await destroyTenantDb(KSA_ORG).catch(() => {})
		}
	})

	it('answers 404 to a forged, expired or other-organization CSV link', async () => {
		await post(request())
		const text = emailMock.mock.calls[0]![0].text
		const url = new URL(
			/https:\/\/tenant\.example\.test\/reports\/csv\/[^\s"]+/.exec(text)![0],
		)
		const token = url.searchParams.get('t')!
		const [payload, mac] = token.split('.')
		const forged = `${payload}.${'0'.repeat(mac!.length)}`
		const cases = [
			`${url.pathname}?t=${encodeURIComponent(forged)}`,
			`/reports/csv/${ORG_B}?t=${encodeURIComponent(token)}`,
			`${url.pathname}`,
			`${url.pathname}?t=garbage`,
		]
		for (const target of cases) {
			expect((await app.request(target)).status).toBe(404)
		}
	})
})

describe('POST /internal/reports/figures: the monthly totals (#221)', () => {
	async function figures(
		body: Record<string, unknown>,
		token: string | null = INTERNAL,
	) {
		return app.request('/internal/reports/figures', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		})
	}
	type FiguresBody = {
		groups: Array<{
			key: string
			figures: Array<{
				id: string
				entries: Array<{ currency: string | null; value: number }>
				previous: Array<{ currency: string | null; value: number }>
			}>
		}>
	}
	const grants = (subjects: string[]) => ({
		subjects,
		scopeIds: null,
		locationIds: null,
		modules: ['marketing'],
	})

	async function seedOctober() {
		// Start clean: the file's default sales belong to the daily summary tests.
		await (await getTenantDb(ORG)).delete(restaurantOrders)
		// October, in two locations with their own zones: the Chicago sale a few
		// hours before midnight UTC on Oct 1 is still September there.
		const at = (iso: string) => new Date(iso).getTime()
		await sale(ORG, at('2026-10-10T18:00:00Z'), 10_000)
		await sale(ORG, at('2026-10-20T18:00:00Z'), 5_000)
		await sale(ORG, at('2026-10-01T03:00:00Z'), 777) // Sep 30, 22:00 in Chicago
		await sale(ORG, at('2026-09-12T18:00:00Z'), 2_000) // September
		const db = await getTenantDb(ORG)
		await db.insert(restaurantOrders).values({
			id: crypto.randomUUID(),
			orgId: ORG,
			number: 'R-RUH',
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: 'loc-ruh',
			locationName: 'Riyadh',
			locationTimezone: 'Asia/Riyadh',
			contactName: 'x',
			contactPhone: '+966500000000',
			currency: 'SAR',
			subtotalCents: 20_000,
			taxCents: 0,
			totalCents: 20_000,
			createdAt: new Date(at('2026-10-01T03:00:00Z')), // Oct 1, 06:00 in Riyadh
			lines: [],
			idempotencyKey: crypto.randomUUID(),
			requestHash: 'x',
			receiptTokenHash: 'y',
		} as typeof restaurantOrders.$inferInsert)
		// A cancelled order never counts.
		await db.insert(restaurantOrders).values({
			id: crypto.randomUUID(),
			orgId: ORG,
			number: 'R-CAN',
			status: 'cancelled',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: 'loc-a',
			locationName: 'Main',
			locationTimezone: 'America/Chicago',
			contactName: 'x',
			contactPhone: '+15550000000',
			currency: 'USD',
			subtotalCents: 90_000,
			taxCents: 0,
			totalCents: 90_000,
			createdAt: new Date(at('2026-10-15T18:00:00Z')),
			lines: [],
			idempotencyKey: crypto.randomUUID(),
			requestHash: 'x',
			receiptTokenHash: 'y',
		} as typeof restaurantOrders.$inferInsert)
	}

	it("answers each location's own month, currencies apart, and equals the matching report templates", async () => {
		await seedOctober()
		const res = await figures({
			orgId: ORG,
			month: '2026-10',
			timeZone: 'America/Chicago',
			groups: [
				{
					key: 'all',
					grants: grants(['sales', 'orders']),
					figureIds: ['directSales', 'directOrders', 'onlineSales'],
				},
			],
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as FiguresBody
		const by = Object.fromEntries(body.groups[0]!.figures.map((f) => [f.id, f]))
		// USD: 100 + 50 in Chicago's October; the Sep 30 sale is September's.
		// SAR: the Riyadh order is October's there.
		expect(by.directSales!.entries).toEqual([
			{ currency: 'SAR', value: 200 },
			{ currency: 'USD', value: 150 },
		])
		// September (set against it): Chicago's Sep 12 and Sep 30 sales.
		expect(by.directSales!.previous).toEqual([
			{ currency: 'USD', value: 27.77 },
		])
		expect(by.directOrders!.entries).toEqual([{ currency: null, value: 3 }])

		// The same month through the existing "Total orders" template, run by the
		// same route: counted orders, each location's own month.
		const template = templatesFor('organization').find(
			(t) => t.id === 'orders-total',
		)!
		const definition = {
			...template.definition,
			timeframe: {
				...template.definition.timeframe,
				preset: 'last_complete_month' as const,
			},
		}
		const report = await runReportInRegion({
			orgId: ORG,
			definition,
			grants: { ...grants(['orders']), modules: [] } as never,
			timeZone: 'America/Chicago',
			asOf: monthlyAsOf('2026-10').current,
		})
		if (!report.ok) throw new Error(report.reason)
		expect(report.result.total).toBe(by.directOrders!.entries[0]!.value)
	})

	it('limits a location-scoped member to their own locations', async () => {
		await seedOctober()
		const res = await figures({
			orgId: ORG,
			month: '2026-10',
			timeZone: 'America/Chicago',
			groups: [
				{
					key: 'ruh',
					grants: { ...grants(['sales']), locationIds: ['loc-ruh'] },
					figureIds: ['directSales', 'directOrders'],
				},
			],
		})
		const body = (await res.json()) as FiguresBody
		const by = Object.fromEntries(body.groups[0]!.figures.map((f) => [f.id, f]))
		expect(by.directSales!.entries).toEqual([{ currency: 'SAR', value: 200 }])
		expect(by.directOrders!.entries).toEqual([{ currency: null, value: 1 }])
	})

	it('hides a figure the grants do not cover, and one whose module is off', async () => {
		await seedOctober()
		const res = await figures({
			orgId: ORG,
			month: '2026-10',
			timeZone: 'America/Chicago',
			groups: [
				{
					key: 'none',
					grants: grants([]),
					figureIds: ['directSales', 'callsAnswered'],
				},
				{
					key: 'sales',
					grants: grants(['sales']),
					figureIds: ['directSales', 'bookings'],
				},
			],
		})
		const body = (await res.json()) as FiguresBody
		expect(body.groups.find((g) => g.key === 'none')!.figures).toEqual([])
		const ids = body.groups
			.find((g) => g.key === 'sales')!
			.figures.map((f) => f.id)
		// Sales granted; bookings need the reservations subject and module.
		expect(ids).toEqual(['directSales'])
	})

	it('needs the internal token, refuses an unknown figure and a wrong-region organization', async () => {
		expect((await figures({}, null)).status).toBe(401)
		expect(
			(
				await figures({
					orgId: ORG,
					month: '2026-10',
					timeZone: 'UTC',
					groups: [
						{ key: 'a', grants: grants(['sales']), figureIds: ['newReviews'] },
					],
				})
			).status,
		).toBe(400)
		expect(
			(
				await figures({
					orgId: KSA_ORG,
					month: '2026-10',
					timeZone: 'UTC',
					groups: [
						{ key: 'a', grants: grants(['sales']), figureIds: ['directSales'] },
					],
				})
			).status,
		).toBe(409)
	})
})
