/**
 * #115 in the region: online orders credited to Menuza campaigns, "Clicked" and
 * "Reached", refunds taken off, one credit per order, counts only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	journeyStepExecutions,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { insertOrder } from './loyalty-test-fixture.ts'
import {
	campaignAttribution,
	journeyStepAttribution,
	overviewAttribution,
} from './marketing-attribution.ts'

const orgId = 'clw9x0a12000008l00attrib01'
const NOW = Date.UTC(2026, 10, 20, 12)
const DAY = 24 * 60 * 60 * 1000
const at = (offsetMs: number) => new Date(NOW + offsetMs)

describe('campaign attribution (#115)', () => {
	let tempDir: string
	let db: TenantDatabase

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-attr-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
	})
	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function guest(name: string) {
		const [row] = await db
			.insert(customers)
			.values({
				name,
				phone: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
				phoneVerified: true,
			})
			.returning()
		return row!.id
	}
	async function broadcast(name: string) {
		const id = randomUUID()
		await db.insert(marketingCampaigns).values({
			id,
			name,
			channel: 'email',
			subject: 's',
			content: 'c',
			status: 'Completed',
			segmentationRules: JSON.stringify({ audience: 'all' }),
		})
		return id
	}
	async function message(
		customerId: string,
		campaignId: string,
		sentAt: Date,
		status = 'Sent',
	) {
		await db.insert(marketingMessages).values({
			id: randomUUID(),
			customerId,
			campaignId,
			channel: 'email',
			status,
			sentAt,
		})
	}
	const order = (
		customerId: string | null,
		createdAt: Date,
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) =>
		insertOrder(orgId, {
			customerId,
			createdAt,
			subtotalCents: 2000,
			totalCents: 2000,
			...overrides,
		})

	it('an order after a click is credited to that campaign, and Reached is never below Clicked', async () => {
		const ana = await guest('Ana')
		const campaign = await broadcast('Spring')
		await message(ana, campaign, at(-3 * DAY))
		await order(ana, at(-2 * DAY), {
			attribution: { campaignId: campaign, utmMedium: 'email' },
			attributionSource: 'email',
		})
		const overview = await overviewAttribution(db, { days: 30, now: NOW })
		expect(overview.clicked).toEqual({ orders: 1, revenueMinor: 2000 })
		expect(overview.reached).toEqual({ orders: 1, revenueMinor: 2000 })
		const detail = await campaignAttribution(db, campaign)
		expect(detail.clicked).toEqual({ orders: 1, revenueMinor: 2000 })
		expect(detail.reached.orders).toBeGreaterThanOrEqual(detail.clicked.orders)
	})

	it('Reached also counts guests we messaged who ordered within 14 days without a click; Clicked does not', async () => {
		const ben = await guest('Ben')
		const campaign = await broadcast('Brunch')
		await message(ben, campaign, at(-10 * DAY))
		await order(ben, at(-3 * DAY)) // no attribution at all: direct
		const overview = await overviewAttribution(db, { days: 30, now: NOW })
		expect(overview.clicked).toEqual({ orders: 0, revenueMinor: 0 })
		expect(overview.reached).toEqual({ orders: 1, revenueMinor: 2000 })
		expect(overview.reached.orders).toBeGreaterThanOrEqual(
			overview.clicked.orders,
		)
		expect(overview.reached.revenueMinor).toBeGreaterThanOrEqual(
			overview.clicked.revenueMinor,
		)
		expect((await campaignAttribution(db, campaign)).reached.orders).toBe(1)
		expect((await campaignAttribution(db, campaign)).clicked.orders).toBe(0)
	})

	it('a message older than 14 days, or sent after the order, does not reach it', async () => {
		const cy = await guest('Cy')
		const campaign = await broadcast('Old')
		await message(cy, campaign, at(-20 * DAY))
		await order(cy, at(-2 * DAY))
		const dan = await guest('Dan')
		await order(dan, at(-5 * DAY))
		await message(dan, campaign, at(-4 * DAY))
		const overview = await overviewAttribution(db, { days: 30, now: NOW })
		expect(overview.reached).toEqual({ orders: 0, revenueMinor: 0 })
	})

	it('a guest reached by two messages is credited to the most recent one, once', async () => {
		const eve = await guest('Eve')
		const first = await broadcast('First')
		const second = await broadcast('Second')
		await message(eve, first, at(-9 * DAY))
		await message(eve, second, at(-4 * DAY))
		await order(eve, at(-2 * DAY))
		const firstView = await campaignAttribution(db, first)
		const secondView = await campaignAttribution(db, second)
		expect(firstView.reached.orders).toBe(0)
		expect(secondView.reached).toEqual({ orders: 1, revenueMinor: 2000 })
		// And once in the totals.
		expect(
			(await overviewAttribution(db, { days: 30, now: NOW })).reached.orders,
		).toBe(1)
	})

	it('refunds reduce revenue, and an order refunded in full is no revenue', async () => {
		const fay = await guest('Fay')
		const campaign = await broadcast('Promo')
		await message(fay, campaign, at(-3 * DAY))
		const attribution = { campaignId: campaign }
		await order(fay, at(-2 * DAY), {
			attribution,
			attributionSource: 'campaign',
			refundedCents: 500,
		})
		await order(fay, at(-1 * DAY), {
			attribution,
			attributionSource: 'campaign',
			refundedCents: 2000,
		})
		// A refund the provider later reversed counts as never made.
		await order(fay, at(-1 * DAY + 3600_000), {
			attribution,
			attributionSource: 'campaign',
			refundedCents: 700,
			refundReversedCents: 700,
		})
		const overview = await overviewAttribution(db, { days: 30, now: NOW })
		expect(overview.clicked.revenueMinor).toBe(1500 + 0 + 2000)
		expect((await campaignAttribution(db, campaign)).clicked.revenueMinor).toBe(
			3500,
		)
	})

	it('a cancelled or unpaid order does not count, and a completed pay-at-pickup order does', async () => {
		const gus = await guest('Gus')
		const campaign = await broadcast('Promo')
		const attribution = { campaignId: campaign }
		await order(gus, at(-2 * DAY), { attribution, status: 'cancelled' })
		await order(gus, at(-2 * DAY), {
			attribution,
			status: 'accepted',
			paymentMethod: 'online',
			paymentStatus: 'pending',
		})
		await order(gus, at(-2 * DAY), {
			attribution,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
		})
		await order(gus, at(-2 * DAY), {
			attribution,
			status: 'accepted',
			paymentMethod: 'online',
			paymentStatus: 'paid',
		})
		const detail = await campaignAttribution(db, campaign)
		expect(detail.clicked).toEqual({ orders: 2, revenueMinor: 4000 })
	})

	it('a guest who ordered without an account is credited by the campaign in the link', async () => {
		const campaign = await broadcast('Guest checkout')
		await order(null, at(-1 * DAY), {
			attribution: { campaignId: campaign },
			attributionSource: 'campaign',
		})
		const overview = await overviewAttribution(db, { days: 30, now: NOW })
		expect(overview.clicked.orders).toBe(1)
		expect(overview.reached.orders).toBe(1)
	})

	it('counts the messages sent and the different guests they reached in the period', async () => {
		const [a, b] = [await guest('A'), await guest('B')]
		// One message per guest per broadcast, so each message is its own broadcast.
		await message(a, await broadcast('C1'), at(-3 * DAY))
		await message(a, await broadcast('C2'), at(-2 * DAY))
		await message(b, await broadcast('C3'), at(-1 * DAY))
		await message(b, await broadcast('C4'), at(-40 * DAY)) // outside 30 days
		await message(b, await broadcast('C5'), at(-1 * DAY), 'Failed') // never sent
		const overview = await overviewAttribution(db, { days: 30, now: NOW })
		expect(overview.messagesSent).toBe(3)
		expect(overview.guestsReached).toBe(2)
		expect(
			(await overviewAttribution(db, { days: 7, now: NOW })).messagesSent,
		).toBe(3)
		expect(
			(await overviewAttribution(db, { days: 90, now: NOW })).messagesSent,
		).toBe(4)
	})

	it('holds only counts and amounts: no guest, name, phone or message id', async () => {
		const hal = await guest('Hal Secret')
		const campaign = await broadcast('Private')
		await message(hal, campaign, at(-3 * DAY))
		await order(hal, at(-2 * DAY), { attribution: { campaignId: campaign } })
		const text = JSON.stringify([
			await overviewAttribution(db, { days: 30, now: NOW }),
			await campaignAttribution(db, campaign),
		])
		expect(text).not.toContain('Hal')
		expect(text).not.toContain(hal)
		expect(text).not.toContain('+1555')
	})

	it('automation steps get their own orders and revenue, both ways', async () => {
		const ivy = await guest('Ivy')
		const [journey] = await db
			.insert(marketingJourneys)
			.values({ name: 'Welcome', status: 'active' })
			.returning()
		const [run] = await db
			.insert(journeyRuns)
			.values({ journeyId: journey!.id, customerId: ivy })
			.returning()
		const execution = async (nodeId: string) => {
			const [row] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run!.id,
					journeyId: journey!.id,
					customerId: ivy,
					nodeId,
					nodeType: 'action_email',
					stepType: 'email',
					status: 'delivered',
				})
				.returning()
			return row!.id
		}
		const stepA = await execution('step-a')
		const stepB = await execution('step-b')
		const stepMessage = async (executionId: string, sentAt: Date) =>
			db.insert(marketingMessages).values({
				id: randomUUID(),
				customerId: ivy,
				journeyStepExecutionId: executionId,
				channel: 'email',
				status: 'Sent',
				sentAt,
			})
		await stepMessage(stepA, at(-6 * DAY))
		await stepMessage(stepB, at(-3 * DAY))
		// One order clicked from step A; one only reached by step B (the latest).
		await order(ivy, at(-5 * DAY), {
			attribution: { campaignId: journey!.id, stepId: 'step-a' },
		})
		await order(ivy, at(-1 * DAY))
		const steps = await journeyStepAttribution(db, journey!.id)
		const byNode = Object.fromEntries(steps.map((step) => [step.nodeId, step]))
		expect(byNode['step-a']!.clicked).toEqual({ orders: 1, revenueMinor: 2000 })
		expect(byNode['step-b']!.clicked).toEqual({ orders: 0, revenueMinor: 0 })
		for (const step of steps) {
			expect(step.reached.orders).toBeGreaterThanOrEqual(step.clicked.orders)
		}
		// The order after step B's message credits step B, once.
		expect(byNode['step-b']!.reached.orders).toBe(1)
		expect(
			await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.customerId, ivy)),
		).toHaveLength(2)
	})
})
