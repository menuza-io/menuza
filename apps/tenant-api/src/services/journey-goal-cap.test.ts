import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	journeyStepExecutions,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	marketingSettings,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createJourney,
	evaluateJourneyCondition,
	executeJourneyStep,
	getJourneyRunTimeline,
} from './journey-service.ts'
import { DAY, insertOrder, insertPosSale, NOW } from './loyalty-test-fixture.ts'
import { setCustomerSubscription } from './marketing-audience.ts'
import { createAudience } from './marketing-audience-service.ts'
import { cappedCustomerIds, readFrequencyCap } from './journey-guards.ts'

vi.mock('@repo/email', () => ({
	sendOciEmail: vi.fn().mockResolvedValue({
		status: 'success',
		data: { messageId: 'email-msg-1' },
	}),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true, sid: 'sid', mock: true }),
}))

const ORG = 'clw9x0a12000008l00gcap01'
const email = {
	subject: 'Hi',
	bodyHtml: '<p>Hello</p>',
	bodyText: 'Hello',
}

describe('journey goal and frequency cap (#99)', () => {
	let dir: string
	let db: TenantDatabase

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-goalcap-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.TENANT_API_URL = 'https://tenant.example.com'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	async function setup(goal: 'order' | null = null) {
		const [customer] = await db
			.insert(customers)
			.values({
				id: 'g1',
				name: 'Guest One',
				email: 'guest@example.com',
				phone: '+15550000001',
				phoneVerified: true,
			})
			.returning()
		await setCustomerSubscription(db, {
			customerId: customer!.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'signup',
			confirmedEmail: customer!.email,
		})
		const [journey] = await db
			.insert(marketingJourneys)
			.values({
				name: 'Welcome',
				status: 'active',
				triggerType: 'order_first_placed',
				goal,
			})
			.returning()
		return { customer: customer!, journey: journey! }
	}

	async function run(
		journeyId: string,
		customerId: string,
		startedAt: Date,
		extra: Record<string, unknown> = {},
	) {
		const [row] = await db
			.insert(journeyRuns)
			.values({
				journeyId,
				customerId,
				status: 'running',
				triggerEvent: 'order_first_placed',
				startedAt,
				contextData: JSON.stringify({
					startedAtMs: startedAt.getTime(),
					...extra,
				}),
			})
			.returning()
		return row!
	}

	const step = (
		journeyId: string,
		runId: string,
		customerId: string,
		nodeId = 'n1',
	) =>
		executeJourneyStep(ORG, {
			orgId: ORG,
			journeyId,
			runId,
			customerId,
			nodeId,
			nodeType: 'action_email',
			config: email,
		})

	it('stops the run before a step when the guest ordered after it started, a delay included', async () => {
		const { customer, journey } = await setup('order')
		const started = new Date(NOW - DAY)
		const r = await run(journey.id, customer.id, started)
		// The order that started the run came before it: not the goal.
		await insertOrder(ORG, {
			customerId: customer.id,
			createdAt: new Date(NOW - 2 * DAY),
		})
		expect((await step(journey.id, r.id, customer.id, 'a')).status).toBe(
			'delivered',
		)
		// A delay passes, the guest orders: the next step does not send.
		await insertOrder(ORG, {
			customerId: customer.id,
			createdAt: new Date(NOW - 1000),
		})
		const second = await step(journey.id, r.id, customer.id, 'b')
		expect(second.status).toBe('halted')
		const stored = await db
			.select()
			.from(journeyRuns)
			.where(eq(journeyRuns.id, r.id))
			.get()
		expect(stored?.status).toBe('cancelled')
		expect(stored?.errorMessage).toBe('Goal reached: the guest placed an order')
		const timeline = await getJourneyRunTimeline(ORG, r.id)
		expect(JSON.stringify(timeline)).toContain('Goal reached')
	})

	it('a Station sale linked to the guest reaches the goal; a journey with no goal ignores orders', async () => {
		const { customer, journey } = await setup('order')
		const r = await run(journey.id, customer.id, new Date(NOW - DAY))
		await insertPosSale(ORG, {
			customerPhone: customer.phone,
			rungUpAt: NOW - 1000,
		})
		expect((await step(journey.id, r.id, customer.id)).status).toBe('halted')

		await db
			.update(marketingJourneys)
			.set({ goal: null })
			.where(eq(marketingJourneys.id, journey.id))
		const r2 = await run(journey.id, customer.id, new Date(NOW - DAY))
		expect((await step(journey.id, r2.id, customer.id, 'x')).status).toBe(
			'delivered',
		)
	})

	it('an operator test run never stops for the goal', async () => {
		const { customer, journey } = await setup('order')
		await insertOrder(ORG, {
			customerId: customer.id,
			createdAt: new Date(NOW - 1000),
		})
		const r = await db
			.insert(journeyRuns)
			.values({
				journeyId: journey.id,
				customerId: customer.id,
				status: 'running',
				triggerEvent: 'manual',
				startedAt: new Date(NOW - DAY),
				contextData: JSON.stringify({ isTestRun: true }),
			})
			.returning()
		// A test run of an active journey still sends (it is a test).
		expect((await step(journey.id, r[0]!.id, customer.id)).status).not.toBe(
			'halted',
		)
	})

	async function messages(
		customerId: string,
		n: number,
		extra: Partial<typeof marketingMessages.$inferInsert> = {},
	) {
		for (let i = 0; i < n; i += 1) {
			await db.insert(marketingMessages).values({
				customerId,
				channel: 'email',
				status: 'Sent',
				sentAt: new Date(Date.now() - 60_000),
				...extra,
			})
		}
	}

	it('skips a step over the cap with frequency_capped and the timeline says why; failed sends and old ones do not count', async () => {
		const { customer, journey } = await setup()
		await db.insert(marketingSettings).values({
			key: 'frequency_cap',
			value: { limit: 3, days: 7 },
		})
		await messages(customer.id, 2)
		await messages(customer.id, 5, { status: 'Failed' })
		await messages(customer.id, 5, { sentAt: new Date(Date.now() - 10 * DAY) })
		const r1 = await run(journey.id, customer.id, new Date())
		expect((await step(journey.id, r1.id, customer.id, 'a')).status).toBe(
			'delivered',
		)
		// Now at 3 in the window: the next one is capped.
		const r2 = await run(journey.id, customer.id, new Date())
		const capped = await step(journey.id, r2.id, customer.id, 'b')
		expect(capped.status).toBe('skipped')
		expect(capped.reason).toBe('frequency_capped')
		const timeline = await getJourneyRunTimeline(ORG, r2.id)
		expect(JSON.stringify(timeline)).toContain('frequency_capped')
		const exec = await db
			.select()
			.from(journeyStepExecutions)
			.where(eq(journeyStepExecutions.runId, r2.id))
			.get()
		expect(exec?.status).toBe('skipped')
	})

	it('counts broadcast messages too, and does nothing without a cap', async () => {
		const { customer, journey } = await setup()
		for (let i = 0; i < 3; i += 1) {
			const [campaign] = await db
				.insert(marketingCampaigns)
				.values({ name: `B${i}`, content: 'x', status: 'Completed' })
				.returning()
			await messages(customer.id, 1, { campaignId: campaign!.id })
		}
		// No cap saved: not limited, as before.
		expect(await readFrequencyCap(db)).toBeNull()
		const r1 = await run(journey.id, customer.id, new Date())
		expect((await step(journey.id, r1.id, customer.id, 'a')).status).toBe(
			'delivered',
		)
		await db.insert(marketingSettings).values({
			key: 'frequency_cap',
			value: { limit: 3, days: 7 },
		})
		const cap = (await readFrequencyCap(db))!
		expect([
			...(await cappedCustomerIds(db, [customer.id], cap, Date.now())),
		]).toEqual([customer.id])
	})

	it('conditions read orders, spend, days since the last order, upcoming reservations and audience membership', async () => {
		const { customer, journey } = await setup()
		await insertOrder(ORG, {
			customerId: customer.id,
			createdAt: new Date(Date.now() - 10 * DAY),
			subtotalCents: 4000,
		})
		const r = await run(journey.id, customer.id, new Date())
		const check = async (field: string, operator: string, value: string) =>
			(
				await evaluateJourneyCondition(ORG, {
					orgId: ORG,
					journeyId: journey.id,
					runId: r.id,
					customerId: customer.id,
					nodeId: `c-${field}-${operator}-${value}`,
					condition: { field, operator: operator as 'equals', value },
				})
			).result
		expect(await check('orders_last_30_days', 'greater_than', '0')).toBe(true)
		expect(await check('orders_last_30_days', 'equals', '1')).toBe(true)
		expect(await check('lifetime_spend', 'greater_than', '3999')).toBe(true)
		expect(await check('days_since_last_order', 'greater_than', '9')).toBe(true)
		expect(await check('days_since_last_order', 'greater_than', '11')).toBe(
			false,
		)
		expect(await check('has_upcoming_reservation', 'equals', 'true')).toBe(
			false,
		)

		const created = await createAudience(db, {
			name: 'Has ordered',
			definition: {
				match: 'all',
				rules: [{ field: 'orders_count', op: 'gte', value: 1 }],
			},
		})
		if (!created.ok) throw new Error('audience')
		expect(await check('audience', 'equals', created.value.id)).toBe(true)
		expect(await check('audience', 'not_equals', created.value.id)).toBe(false)
		// A deleted audience answers "no" on both sides: no path opens by accident.
		expect(await check('audience', 'equals', 'gone')).toBe(false)
		expect(await check('audience', 'not_equals', 'gone')).toBe(false)
		// Values compared are never kept in the run timeline.
		expect(
			JSON.stringify(await getJourneyRunTimeline(ORG, r.id)),
		).not.toContain('guest@example.com')
	})

	it('stores the goal and the program on create, and refuses a second journey from the same program', async () => {
		const first = await createJourney(ORG, {
			name: 'Welcome series',
			triggerType: 'order_first_placed',
			goal: 'order',
			programId: 'first_order_thank_you',
			programVersion: 1,
		})
		expect(first.success).toBe(true)
		const stored = await db
			.select()
			.from(marketingJourneys)
			.where(eq(marketingJourneys.name, 'Welcome series'))
			.get()
		expect(stored?.goal).toBe('order')
		expect(stored?.programId).toBe('first_order_thank_you')
		const second = await createJourney(ORG, {
			name: 'Again',
			triggerType: 'order_first_placed',
			programId: 'first_order_thank_you',
		})
		expect(second).toMatchObject({
			success: false,
			error: 'program_already_active',
			statusCode: 409,
		})
	})
})
