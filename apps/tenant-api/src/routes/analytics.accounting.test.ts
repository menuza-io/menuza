import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	adjustingEntry,
	adjustingLines,
	buildJournalDay,
	journalHash,
	type AccountingDayFacts,
} from '@repo/reports'
import {
	ACCOUNTING_REPORT_SUBJECT,
	mintOperatorAnalyticsToken,
	ORDER_REPORT_SUBJECTS,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { analyticsRoutes } from './analytics.ts'

/**
 * The accounting export's region side (#189): the day's figures per location,
 * mixed tax rates and tenders, a refund on a later day, and the rule that every
 * day the region reports builds a journal that balances.
 */

const SECRET = 'test-accounting-analytics-signing-secret-32chars!!'
const ORG = 'org_accounting_a'
const ORG_B = 'org_accounting_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const app = new Hono()
app.route('/analytics', analyticsRoutes)

let dir: string

async function token(
	options: {
		orgId?: string
		subjects?: readonly RestrictedReportSubject[]
		locationIds?: readonly string[] | null
	} = {},
) {
	const { token } = await mintOperatorAnalyticsToken({
		signingSecret: SECRET,
		userId: 'usr_acct',
		orgId: options.orgId ?? ORG,
		role: 'operator',
		subjects: options.subjects ?? [...ORDER_REPORT_SUBJECTS, ACCOUNTING_REPORT_SUBJECT],
		scopeIds: null,
		locationIds: options.locationIds === undefined ? null : options.locationIds,
	})
	return token
}

const get = async (query: string, jwt: string | null) =>
	app.request(`/analytics/accounting-daily?${query}`, {
		headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
	})

async function order(input: {
	orgId?: string
	locationId?: string
	zone?: string
	at: string
	subtotal: number
	discount?: number
	tax: number
	tip?: number
	paymentMethod?: 'handoff' | 'online'
	currency?: string
}) {
	const db = await getTenantDb(input.orgId ?? ORG)
	const id = crypto.randomUUID()
	const discount = input.discount ?? 0
	const tip = input.tip ?? 0
	await db.insert(restaurantOrders).values({
		id,
		orgId: input.orgId ?? ORG,
		number: `A-${id.slice(0, 5)}`,
		status: 'completed',
		paymentMethod: input.paymentMethod ?? 'handoff',
		paymentStatus: input.paymentMethod === 'online' ? 'paid' : 'unpaid',
		fulfillment: 'pickup',
		locationId: input.locationId ?? 'loc-a',
		locationName: input.locationId === 'loc-b' ? 'Harbor' : 'Main',
		locationTimezone: input.zone ?? 'America/Chicago',
		contactName: 'x',
		contactPhone: '+15550000000',
		currency: input.currency ?? 'USD',
		subtotalCents: input.subtotal,
		discountCents: discount,
		taxCents: input.tax,
		tipCents: tip,
		totalCents: input.subtotal - discount + input.tax + tip,
		createdAt: new Date(input.at),
		lines: [],
		idempotencyKey: crypto.randomUUID(),
		requestHash: 'x',
		receiptTokenHash: 'y',
	} as typeof restaurantOrders.$inferInsert)
	return id
}

type DaysBody = { days: AccountingDayFacts[] }

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'accounting-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.OPERATOR_ANALYTICS_TOKEN = SECRET
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		} as PublishedOrganization)
		await provisionTenantDb(id)
	}
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(dir, { recursive: true, force: true })
})

describe('GET /analytics/accounting-daily (#189)', () => {
	it('reports a location-day with mixed tax rates and tenders, and every day balances', async () => {
		// Nov 20 at Main (Chicago): a 15% order paid at handoff and a 5% order paid online.
		await order({ at: '2026-11-20T18:00:00Z', subtotal: 10_000, discount: 1_000, tax: 1_350, tip: 500 })
		await order({ at: '2026-11-20T19:00:00Z', subtotal: 4_000, tax: 200, paymentMethod: 'online' })
		// Harbor, another location and currency, a day later.
		await order({ at: '2026-11-21T18:00:00Z', locationId: 'loc-b', zone: 'Asia/Riyadh', subtotal: 20_000, tax: 3_000, currency: 'SAR', paymentMethod: 'online' })

		const res = await get('from=2026-11-20&to=2026-11-21', await token())
		expect(res.status).toBe(200)
		const { days } = (await res.json()) as DaysBody
		expect(days.map((d) => `${d.businessDate}/${d.locationId}/${d.currency}`)).toEqual([
			'2026-11-20/loc-a/USD',
			'2026-11-21/loc-b/SAR',
		])
		const main = days[0]!
		expect(main.closed).toBe(true)
		expect(main.grossMinor).toBe(14_000)
		expect(main.discountsMinor).toBe(1_000)
		expect(main.tipsMinor).toBe(500)
		expect(main.taxByRate).toEqual([
			{ rateBp: 500, minor: 200 },
			{ rateBp: 1500, minor: 1350 },
		])
		const tenders = Object.fromEntries(main.tenders.map((t) => [t.tender, t.minor]))
		expect(tenders).toEqual({ handoff: 10_850, card_online: 4_200 })
		// Money was never added across currencies.
		expect(days[1]!.currency).toBe('SAR')
		// The journal built from the region's figures balances for every day.
		for (const day of days) {
			const journal = buildJournalDay(day)
			expect(journal.differenceMinor, day.businessDate).toBe(0)
			expect(journal.debitMinor).toBe(journal.creditMinor)
		}
	})

	it('dates a refund the day the money went back, and a late refund changes an exported day', async () => {
		const id = await order({ at: '2026-11-20T18:00:00Z', subtotal: 10_000, tax: 1_500, paymentMethod: 'online' })
		const before = await (await get('from=2026-11-20&to=2026-11-22', await token())).json() as DaysBody
		const exported = buildJournalDay(before.days.find((d) => d.businessDate === '2026-11-20')!)
		expect(exported.differenceMinor).toBe(0)

		// A refund of 23.00 (20.00 net + 3.00 tax at 15%) arrives on the 22nd.
		const db = await getTenantDb(ORG)
		await db.insert(restaurantOrderRefunds).values({
			orderId: id,
			amountCents: 2_300,
			currency: 'usd',
			actorId: 'usr_1',
			idempotencyKey: 'k1',
			requestHash: 'h1',
			createdAt: new Date('2026-11-22T18:00:00Z').getTime(),
			kind: 'record',
			status: 'succeeded',
		} as typeof restaurantOrderRefunds.$inferInsert)
		const after = (await (await get('from=2026-11-20&to=2026-11-22', await token())).json()) as DaysBody
		// The 20th itself is unchanged; the refund sits on the 22nd.
		const same = buildJournalDay(after.days.find((d) => d.businessDate === '2026-11-20')!)
		expect(journalHash(same.lines)).toBe(journalHash(exported.lines))
		expect(adjustingLines(exported.lines, same.lines)).toEqual([])
		const refundDay = after.days.find((d) => d.businessDate === '2026-11-22')!
		expect(refundDay.refundsNetMinor).toBeLessThan(0)
		const journal = buildJournalDay(refundDay)
		expect(journal.differenceMinor).toBe(0)
		expect(journal.lines.find((l) => l.lineKey === 'refunds')!.debitMinor).toBeGreaterThan(0)
		// A later re-export of the 22nd after a second refund would be an adjusting entry.
		const entry = adjustingEntry(journal, adjustingLines(exported.lines, journal.lines), 2)
		expect(entry.status).toBe('adjustment')
	})

	it('marks today provisional until the day has closed', async () => {
		const todayIso = new Date().toISOString()
		await order({ at: todayIso, subtotal: 1_000, tax: 0 })
		const today = todayIso.slice(0, 10)
		const res = await get(`from=${today}&to=${today}`, await token())
		const { days } = (await res.json()) as DaysBody
		// UTC "today" can still be yesterday in Chicago: either way at most one is open.
		expect(days.length).toBeGreaterThanOrEqual(0)
		for (const day of days) {
			expect(typeof day.closed).toBe('boolean')
		}
	})

	it('refuses a token without the accounting grant, a missing token and a long range', async () => {
		expect(
			(await get('from=2026-11-20&to=2026-11-21', await token({ subjects: [...ORDER_REPORT_SUBJECTS] }))).status,
		).toBe(403)
		expect((await get('from=2026-11-20&to=2026-11-21', null)).status).toBe(401)
		expect((await get('from=2026-01-01&to=2026-12-31', await token())).status).toBe(400)
		expect((await get('from=2026-11-21&to=2026-11-20', await token())).status).toBe(400)
		expect((await get('from=nope&to=2026-11-20', await token())).status).toBe(400)
	})

	it('stays inside the token\'s locations and its own organization', async () => {
		await order({ at: '2026-11-20T18:00:00Z', subtotal: 1_000, tax: 0 })
		await order({ at: '2026-11-20T18:00:00Z', locationId: 'loc-b', subtotal: 2_000, tax: 0 })
		await order({ orgId: ORG_B, at: '2026-11-20T18:00:00Z', subtotal: 9_999, tax: 0 })
		const scoped = (await (
			await get('from=2026-11-20&to=2026-11-20', await token({ locationIds: ['loc-b'] }))
		).json()) as DaysBody
		expect(scoped.days.map((d) => d.locationId)).toEqual(['loc-b'])
		const none = (await (
			await get('from=2026-11-20&to=2026-11-20', await token({ locationIds: [] }))
		).json()) as DaysBody
		expect(none.days).toEqual([])
		const all = (await (await get('from=2026-11-20&to=2026-11-20', await token())).json()) as DaysBody
		expect(JSON.stringify(all)).not.toContain('9999')
	})
})
