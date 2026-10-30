import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_OUTBOX_MAX_ATTEMPTS,
	LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS,
	LOYALTY_PURGE_AFTER_MS,
	LOYALTY_RESERVATION_TTL_MS,
	LoyaltyDomainError,
} from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyIdempotencyKeys,
	loyaltyOutbox,
	provisionTenantDb,
} from '@repo/tenant-db'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onLoyaltyDeferred } from '../lib/loyalty-alarm.ts'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { posOrderLoyaltySource } from '../restaurant/pos-loyalty-source.ts'
import { LOYALTY_TILL_SOURCE } from './loyalty-code-service.ts'
import {
	LOYALTY_OUTBOX_LEASE_MS,
	processLoyaltyOutbox,
	queueLoyaltySourceInTx,
	registerLoyaltySourceAdapter,
	settleLoyaltySources,
} from './loyalty-purchase-service.ts'
import {
	readRedemptionInTx,
	resolveRedemption,
} from './loyalty-redemption-service.ts'
import {
	fanOutLoyaltyTick,
	rotateOrgIds,
	runLoyaltyTickForOrg,
	runLoyaltyTickLogged,
	type LoyaltyTickResult,
} from './loyalty-tick-service.ts'
import {
	activateProgram,
	balanceOf,
	expectLoyaltyError,
	givePoints,
	insertCustomer,
	insertPosSale,
	loyaltyCart,
	makeMember,
	makeReward,
	NOW,
	reserveReward,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_tick'

let directory: string
let customerCounter = 0

async function member(points = 0): Promise<string> {
	const customerId = `cus_${++customerCounter}`
	await insertCustomer(ORG, { id: customerId })
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return memberId
}

async function readRedemption(id: string) {
	const db = await getTenantDb(ORG)
	return readRedemptionInTx(db, id)
}

async function outboxRow(sourceType: string, sourceId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyOutbox)
		.where(
			and(
				eq(loyaltyOutbox.sourceType, sourceType),
				eq(loyaltyOutbox.sourceId, sourceId),
			),
		)
		.get()
}

/** Every read of a till sale fails: a stand-in for a broken source. */
function breakTillSales() {
	registerLoyaltySourceAdapter({
		type: 'pos_order',
		async read() {
			throw new LoyaltyDomainError('loyalty_unavailable')
		},
	})
}

/** A redemption bound to a till sale, `boundAt` controlled. */
async function boundTillRedemption(saleId: string, at: number) {
	const memberId = await member(10)
	const reward = await makeReward(ORG)
	return reserveReward(ORG, {
		memberId,
		rewardId: reward.id,
		source: { type: 'pos_order', id: saleId },
		channel: 'pos',
		at,
	})
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-tick-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	registerLoyaltySourceAdapter(posOrderLoyaltySource)
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('runLoyaltyTickForOrg', () => {
	it('an organization with no program has nothing to do', async () => {
		const result = await runLoyaltyTickForOrg(ORG, { now: NOW })
		expect(result).toEqual({
			holdsReleased: 0,
			approvalsExpired: 0,
			outboxProcessed: 0,
			outboxFailed: 0,
			outboxParked: 0,
			outboxParkedTotal: 0,
			uploadsMissing: 0,
			uploadsMissingTotal: 0,
			needsFollowUp: false,
			nextDueAt: null,
		})
	})

	it('releases expired holds, leaves live ones, and says when to return', async () => {
		await activateProgram(ORG)
		const memberId = await member(30)
		const reward = await makeReward(ORG)
		const stale = await reserveReward(ORG, { memberId, rewardId: reward.id })
		const live = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			at: NOW + 1000,
		})

		// Before the first hold expires: nothing released, follow-up at expiry.
		const early = await runLoyaltyTickForOrg(ORG, { now: NOW + 1000 })
		expect(early).toMatchObject({
			holdsReleased: 0,
			needsFollowUp: true,
			nextDueAt: NOW + LOYALTY_RESERVATION_TTL_MS,
		})

		const result = await runLoyaltyTickForOrg(ORG, {
			now: NOW + LOYALTY_RESERVATION_TTL_MS,
		})
		expect(result.holdsReleased).toBe(1)
		expect((await readRedemption(stale.id))!).toMatchObject({
			state: 'released',
			releaseReason: 'expired',
		})
		expect((await readRedemption(live.id))!.state).toBe('reserved')
		// The released points are back; the live hold keeps its ten.
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 30,
			reserved: 10,
		})
		expect(result.nextDueAt).toBe(NOW + 1000 + LOYALTY_RESERVATION_TTL_MS)
	})

	it('expires till requests past their time', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		// A pending approval created directly through the code path.
		const { customerId } = await (async () => {
			const db = await getTenantDb(ORG)
			const { loyaltyMembers } = await import('@repo/tenant-db')
			const row = await db
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.id, memberId))
				.get()
			return { customerId: row!.customerId! }
		})()
		const deviceId = `dev_tick`
		const { insertPosDevice } = await import('./loyalty-test-fixture.ts')
		await insertPosDevice(ORG, { id: deviceId })
		const { issueMemberCode, identifyMemberByCode, requestTillApproval } =
			await import('./loyalty-code-service.ts')
		const { code } = await issueMemberCode(ORG, {
			customerId,
			features: { enabled: true, redemption: true },
			now: NOW,
		})
		const till = await identifyMemberByCode(ORG, {
			code,
			device: { id: deviceId, locationId: 'loc_1' },
			features: { enabled: true, redemption: true },
			now: NOW,
		})
		const approval = await requestTillApproval(ORG, {
			binding: till.member.binding,
			device: { id: deviceId, locationId: 'loc_1' },
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: 'sale_tick',
			cart: loyaltyCart(),
			targetLineId: null,
			features: { enabled: true, redemption: true },
			now: NOW,
		})
		const result = await runLoyaltyTickForOrg(ORG, {
			now: NOW + LOYALTY_APPROVAL_TTL_MS,
		})
		expect(result.approvalsExpired).toBe(1)
		const db = await getTenantDb(ORG)
		const { loyaltyApprovals } = await import('@repo/tenant-db')
		const row = await db
			.select()
			.from(loyaltyApprovals)
			.where(eq(loyaltyApprovals.id, approval.id))
			.get()
		expect(row!.status).toBe('expired')
	})

	it('a stale till redemption queues its uploaded sale exactly once, and goes to review when the sale never closes', async () => {
		await activateProgram(ORG)
		const boundAt = NOW
		const redemption = await boundTillRedemption('sale_uploaded', boundAt)
		// Still open on the till: reconciling it changes nothing.
		await insertPosSale(ORG, {
			id: 'sale_uploaded',
			status: 'open',
			paidAt: null,
		})

		const t1 = boundAt + LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS
		const first = await runLoyaltyTickForOrg(ORG, { now: t1 })
		expect(first).toMatchObject({ uploadsMissing: 0, outboxProcessed: 1 })
		const row1 = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_uploaded'))!
		expect(row1.status).toBe('done')
		// The redemption stays bound: a sale on file is never a timer's call.
		expect((await readRedemption(redemption.id))!.state).toBe('bound')
		// Reconciled and still open a day after the reward was approved: the
		// closing revision never arrived, so the tick still has work on it.
		expect(first.nextDueAt).toBe(t1)

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		let second: LoyaltyTickResult
		try {
			second = await runLoyaltyTickForOrg(ORG, { now: t1 + 60_000 })
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty till sale never closed',
				expect.objectContaining({ orgId: ORG, saleId: 'sale_uploaded' }),
			)
		} finally {
			errorSpy.mockRestore()
		}
		expect(second).toMatchObject({
			outboxProcessed: 0,
			uploadsMissing: 1,
			uploadsMissingTotal: 1,
			nextDueAt: null,
		})
		// Never queued again: the outbox row is the one the first tick left.
		expect(await outboxRow(LOYALTY_TILL_SOURCE, 'sale_uploaded')).toMatchObject(
			{
				status: 'done',
				attempts: row1.attempts,
				createdAt: row1.createdAt,
			},
		)
		expect((await readRedemption(redemption.id))!).toMatchObject({
			state: 'review',
			reviewReason: 'upload_missing',
		})
		expect(await balanceOf(ORG, redemption.memberId)).toMatchObject({
			points: 10,
			reserved: 10,
		})

		const third = await runLoyaltyTickForOrg(ORG, { now: t1 + 120_000 })
		expect(third).toMatchObject({ uploadsMissing: 0, uploadsMissingTotal: 1 })
	})

	it('a stale till redemption on a sale closed without it gives the points back', async () => {
		await activateProgram(ORG)
		const redemption = await boundTillRedemption('sale_closed', NOW)
		// Paid, and no loyalty discount on it.
		await insertPosSale(ORG, { id: 'sale_closed' })
		await runLoyaltyTickForOrg(ORG, {
			now: NOW + LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS,
		})
		expect((await readRedemption(redemption.id))!).toMatchObject({
			state: 'released',
			releaseReason: 'reward_not_used',
		})
		expect(await balanceOf(ORG, redemption.memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
	})

	it('a queued till sale that keeps failing is retried, never queued again', async () => {
		await activateProgram(ORG)
		breakTillSales()
		const boundAt = NOW
		const redemption = await boundTillRedemption('sale_uploaded', boundAt)
		await insertPosSale(ORG, { id: 'sale_uploaded' })

		const t1 = boundAt + LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS
		const first = await runLoyaltyTickForOrg(ORG, { now: t1 })
		expect(first.uploadsMissing).toBe(0)
		// The row was queued, then the tick's outbox pass tried to reconcile it:
		// one failed attempt.
		const row1 = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_uploaded'))!
		expect(row1).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'loyalty_unavailable',
		})
		// The redemption stays bound: a sale on file is never a timer's call.
		expect((await readRedemption(redemption.id))!.state).toBe('bound')

		// A second tick before the backoff is due must not reset the row.
		const second = await runLoyaltyTickForOrg(ORG, { now: t1 + 1000 })
		const row2 = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_uploaded'))!
		expect(row2).toMatchObject({
			attempts: 1,
			createdAt: row1.createdAt,
			nextAttemptAt: row1.nextAttemptAt,
		})
		expect(second.outboxFailed).toBe(0)

		// After the backoff the outbox pass retries it, still without the tick
		// re-queueing: the attempt counter keeps climbing toward the park.
		await runLoyaltyTickForOrg(ORG, { now: row2.nextAttemptAt })
		const row3 = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_uploaded'))!
		expect(row3.attempts).toBe(2)
		expect(row3.createdAt).toBe(row1.createdAt)
	})

	it('keeps counting sources parked by an earlier tick, not only new ones', async () => {
		await activateProgram(ORG)
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyOutbox).values({
			sourceType: LOYALTY_TILL_SOURCE,
			sourceId: 'sale_parked_earlier',
			status: 'failed',
			attempts: 12,
			nextAttemptAt: NOW,
			lastError: 'loyalty_unavailable',
			createdAt: NOW,
			updatedAt: NOW,
		})
		const result = await runLoyaltyTickForOrg(ORG, { now: NOW + 60_000 })
		expect(result).toMatchObject({ outboxParked: 0, outboxParkedTotal: 1 })
		const aggregate = await fanOutLoyaltyTick({
			orgIds: [ORG],
			run: (orgId) => runLoyaltyTickForOrg(orgId, { now: NOW + 120_000 }),
		})
		expect(aggregate).toMatchObject({ outboxParked: 0, outboxParkedTotal: 1 })
	})

	it('a source one tick parks is still counted by every later tick until an operator answers', async () => {
		await activateProgram(ORG)
		breakTillSales()
		const redemption = await boundTillRedemption('sale_parks', NOW)
		await insertPosSale(ORG, { id: 'sale_parks' })

		// The tick a day later queues the uploaded sale, and every retry fails.
		let now = NOW + LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS
		let parkedBy: LoyaltyTickResult | null = null
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			for (let tick = 1; tick <= LOYALTY_OUTBOX_MAX_ATTEMPTS; tick++) {
				const result = await runLoyaltyTickForOrg(ORG, { now })
				const row = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_parks'))!
				if (row.status === 'failed') {
					parkedBy = result
					break
				}
				now = row.nextAttemptAt
			}
		} finally {
			errorSpy.mockRestore()
		}
		expect(parkedBy).toMatchObject({ outboxParked: 1, outboxParkedTotal: 1 })

		// An hour later, the run the cron makes: nothing parks, one still waits.
		const hour = 60 * 60_000
		const later = await runLoyaltyTickForOrg(ORG, { now: now + hour })
		expect(later).toMatchObject({ outboxParked: 0, outboxParkedTotal: 1 })
		const hourly = await fanOutLoyaltyTick({
			orgIds: [ORG],
			run: (orgId) => runLoyaltyTickForOrg(orgId, { now: now + 2 * hour }),
		})
		expect(hourly).toMatchObject({
			errors: 0,
			outboxParked: 0,
			outboxParkedTotal: 1,
		})

		// Parking sent the bound redemption to review; deciding it ends the park.
		expect((await readRedemption(redemption.id))!.state).toBe('review')
		await resolveRedemption(ORG, {
			redemptionId: redemption.id,
			action: 'release',
			note: 'sale voided at the till',
			actorId: 'op_test',
			locationIds: null,
			now: now + 3 * hour,
		})
		const answered = await runLoyaltyTickForOrg(ORG, { now: now + 4 * hour })
		expect(answered.outboxParkedTotal).toBe(0)
	})

	it('re-arming a queued source for a held upload keeps its retry budget', async () => {
		await activateProgram(ORG)
		await boundTillRedemption('sale_held_loop', NOW)
		// A parked row: it exhausted its attempts and waits for an operator.
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyOutbox).values({
			sourceType: LOYALTY_TILL_SOURCE,
			sourceId: 'sale_held_loop',
			status: 'failed',
			attempts: 12,
			nextAttemptAt: NOW,
			lastError: 'boom',
			createdAt: NOW,
			updatedAt: NOW,
		})
		await withLoyaltyWrite({ orgId: ORG, now: NOW + 1000 }, async (tx, ctx) => {
			await queueLoyaltySourceInTx(
				tx,
				{ type: LOYALTY_TILL_SOURCE, id: 'sale_held_loop' },
				ctx.now,
				{ preserveAttempts: true },
			)
		})
		expect(
			(await outboxRow(LOYALTY_TILL_SOURCE, 'sale_held_loop'))!,
		).toMatchObject({ status: 'pending', attempts: 12 })
		// Queueing for a real sale change still resets the budget.
		await withLoyaltyWrite({ orgId: ORG, now: NOW + 2000 }, async (tx, ctx) => {
			await queueLoyaltySourceInTx(
				tx,
				{ type: LOYALTY_TILL_SOURCE, id: 'sale_held_loop' },
				ctx.now,
			)
		})
		expect(
			(await outboxRow(LOYALTY_TILL_SOURCE, 'sale_held_loop'))!,
		).toMatchObject({ status: 'pending', attempts: 0 })
	})

	it('a stale till redemption whose sale never arrived goes to review, once', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'pos_order', id: 'sale_never' },
			channel: 'pos',
			at: NOW,
		})
		const at = NOW + LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const first = await runLoyaltyTickForOrg(ORG, { now: at })
			expect(first).toMatchObject({ uploadsMissing: 1, uploadsMissingTotal: 1 })
			// Both the per-review line and the tick summary name the organization.
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty till sale never uploaded',
				expect.objectContaining({ orgId: ORG, saleId: 'sale_never' }),
			)
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty tick needs attention',
				expect.objectContaining({
					orgId: ORG,
					uploadsMissing: 1,
					uploadsMissingTotal: 1,
				}),
			)
		} finally {
			errorSpy.mockRestore()
		}
		expect((await readRedemption(redemption.id))!).toMatchObject({
			state: 'review',
			reviewReason: 'upload_missing',
		})
		// The points stay held for the operator's decision.
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 10,
		})
		// Not new on the next tick, but still waiting: the hourly run keeps
		// failing on it whichever tick sent it to review.
		const second = await runLoyaltyTickForOrg(ORG, { now: at + 60_000 })
		expect(second).toMatchObject({ uploadsMissing: 0, uploadsMissingTotal: 1 })
		const hour = 60 * 60_000
		const hourly = await fanOutLoyaltyTick({
			orgIds: [ORG],
			run: (orgId) => runLoyaltyTickForOrg(orgId, { now: at + hour }),
		})
		expect(hourly).toMatchObject({ uploadsMissing: 0, uploadsMissingTotal: 1 })

		// Once an operator decides it, nothing is waiting any more.
		await resolveRedemption(ORG, {
			redemptionId: redemption.id,
			action: 'release',
			note: 'sale never reached the register',
			actorId: 'op_test',
			locationIds: null,
			now: at + 2 * hour,
		})
		const answered = await runLoyaltyTickForOrg(ORG, { now: at + 3 * hour })
		expect(answered).toMatchObject({
			uploadsMissing: 0,
			uploadsMissingTotal: 0,
		})
	})

	it('a till redemption younger than a day is left alone', async () => {
		await activateProgram(ORG)
		const redemption = await boundTillRedemption('sale_fresh', NOW)
		const result = await runLoyaltyTickForOrg(ORG, {
			now: NOW + LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS - 1,
		})
		expect(result.uploadsMissing).toBe(0)
		expect((await readRedemption(redemption.id))!.state).toBe('bound')
		expect(await outboxRow(LOYALTY_TILL_SOURCE, 'sale_fresh')).toBeUndefined()
	})

	it('one failing row never stops the rest of the tick, and the outbox pass still runs', async () => {
		await activateProgram(ORG)
		const memberId = await member(30)
		const reward = await makeReward(ORG)
		const poisoned = await reserveReward(ORG, { memberId, rewardId: reward.id })
		const healthy = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			at: NOW + 1,
		})
		// A closed till sale with a reward on it, waiting in the outbox.
		const tillReward = await boundTillRedemption('sale_queued', NOW)
		await insertPosSale(ORG, { id: 'sale_queued' })
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx, ctx) =>
			queueLoyaltySourceInTx(
				tx,
				{ type: LOYALTY_TILL_SOURCE, id: 'sale_queued' },
				ctx.now,
			),
		)
		const db = await getTenantDb(ORG)
		await db.run(
			sql.raw(
				`CREATE TRIGGER poisoned_hold BEFORE UPDATE ON loyalty_redemptions WHEN OLD.id = '${poisoned.id}' BEGIN SELECT RAISE(ABORT, 'boom +15551230000'); END`,
			),
		)
		const at = NOW + 1 + LOYALTY_RESERVATION_TTL_MS
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const result = await runLoyaltyTickForOrg(ORG, { now: at })
			expect(result).toMatchObject({
				holdsReleased: 1,
				outboxProcessed: 1,
				outboxFailed: 0,
			})
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty tick step failed',
				expect.objectContaining({
					orgId: ORG,
					step: 'expired_hold',
					rowId: poisoned.id,
					errorName: expect.any(String),
				}),
			)
			// The driver's message quotes bound values: it is never logged.
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('15551230000')
		} finally {
			errorSpy.mockRestore()
		}
		expect((await readRedemption(poisoned.id))!.state).toBe('reserved')
		expect((await readRedemption(healthy.id))!).toMatchObject({
			state: 'released',
			releaseReason: 'expired',
		})
		expect(await outboxRow(LOYALTY_TILL_SOURCE, 'sale_queued')).toMatchObject({
			status: 'done',
		})
		expect((await readRedemption(tillReward.id))!).toMatchObject({
			state: 'released',
			releaseReason: 'reward_not_used',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 30,
			reserved: 10,
		})

		// Once the row can be written again, the next tick releases it.
		await db.run(sql`DROP TRIGGER poisoned_hold`)
		const next = await runLoyaltyTickForOrg(ORG, { now: at + 60_000 })
		expect(next.holdsReleased).toBe(1)
		expect((await readRedemption(poisoned.id))!.state).toBe('released')
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 30,
			reserved: 0,
		})
	})

	it('purges done outbox rows and dead idempotency keys past the cutoff', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		// One done row long past the cutoff, one recent.
		const redemption = await boundTillRedemption('sale_old', NOW)
		await boundTillRedemption('sale_new', NOW)
		void redemption
		void reward
		const db = await getTenantDb(ORG)
		const cutoff = NOW + 31 * 24 * 60 * 60_000
		for (const [sourceId, doneAt] of [
			['sale_old', NOW],
			['sale_new', cutoff - 1000],
		] as const) {
			await db
				.insert(loyaltyOutbox)
				.values({
					sourceType: 'restaurant_order',
					sourceId,
					status: 'done',
					attempts: 0,
					nextAttemptAt: doneAt,
					doneAt,
					createdAt: doneAt,
					updatedAt: doneAt,
				})
				.onConflictDoNothing()
		}
		// An idempotency record long dead and one still alive.
		for (const [key, expiresAt] of [
			['dead', NOW],
			['alive', cutoff + 60_000],
		] as const) {
			await db.insert(loyaltyIdempotencyKeys).values({
				scope: 'test',
				key,
				requestHash: `hash-${key}`,
				statusCode: 200,
				responseJson: '{}',
				expiresAt,
				createdAt: NOW,
			})
		}
		const result = await runLoyaltyTickForOrg(ORG, { now: cutoff })
		expect(result.needsFollowUp).toBe(false)
		const outboxRows = await db
			.select()
			.from(loyaltyOutbox)
			.where(eq(loyaltyOutbox.sourceType, 'restaurant_order'))
		expect(outboxRows.map((row) => row.sourceId)).toEqual(['sale_new'])
		const keys = await db
			.select()
			.from(loyaltyIdempotencyKeys)
			.where(eq(loyaltyIdempotencyKeys.scope, 'test'))
		expect(keys.map((row) => row.key)).toEqual(['alive'])
	})
})

describe('the outbox', () => {
	/** A till sale on file with a reward bound to it, queued for the outbox. */
	async function queuedTillSale(saleId: string, attempts = 0) {
		const redemption = await boundTillRedemption(saleId, NOW)
		await insertPosSale(ORG, { id: saleId })
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyOutbox).values({
			sourceType: LOYALTY_TILL_SOURCE,
			sourceId: saleId,
			status: 'pending',
			attempts,
			nextAttemptAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		return redemption
	}

	it('parks a source on its last attempt even when its reviews cannot be written', async () => {
		await activateProgram(ORG)
		breakTillSales()
		const redemption = await queuedTillSale(
			'sale_last_try',
			LOYALTY_OUTBOX_MAX_ATTEMPTS - 1,
		)
		const db = await getTenantDb(ORG)
		await db.run(
			sql.raw(
				`CREATE TRIGGER no_review BEFORE UPDATE ON loyalty_redemptions WHEN OLD.id = '${redemption.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
			),
		)
		const at = NOW + 1000
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const result = await processLoyaltyOutbox(ORG, { now: at })
			expect(result).toEqual({ processed: 0, failed: 1, parked: 1 })
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty parked source review failed',
				expect.objectContaining({
					orgId: ORG,
					sourceId: 'sale_last_try',
					errorName: expect.any(String),
				}),
			)
		} finally {
			errorSpy.mockRestore()
		}
		const row = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_last_try'))!
		expect(row).toMatchObject({
			status: 'failed',
			attempts: LOYALTY_OUTBOX_MAX_ATTEMPTS,
			lastError: 'loyalty_unavailable',
			claimedUntil: null,
		})
		expect(row.nextAttemptAt).toBeGreaterThan(at)
		expect((await readRedemption(redemption.id))!.state).toBe('bound')
		// Parked is final until an operator acts: no driver retries it.
		await db.run(sql`DROP TRIGGER no_review`)
		expect(
			await processLoyaltyOutbox(ORG, { now: row.nextAttemptAt + 1000 }),
		).toEqual({ processed: 0, failed: 0, parked: 0 })
		const tick = await runLoyaltyTickForOrg(ORG, {
			now: row.nextAttemptAt + 2000,
		})
		expect(tick).toMatchObject({ outboxParked: 0, outboxParkedTotal: 1 })
	})

	it('two drivers that overlap reconcile a row once and count its failure once', async () => {
		await activateProgram(ORG)
		let reads = 0
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered!: () => void
		const inside = new Promise<void>((resolve) => {
			entered = resolve
		})
		registerLoyaltySourceAdapter({
			type: 'pos_order',
			async read() {
				reads += 1
				entered()
				await gate
				throw new LoyaltyDomainError('loyalty_unavailable')
			},
		})
		await queuedTillSale('sale_overlap')
		const at = NOW + 1000
		const first = processLoyaltyOutbox(ORG, { now: at })
		await inside
		// The second driver reads the due list while the first is mid-reconcile.
		const second = processLoyaltyOutbox(ORG, { now: at })
		await new Promise((resolve) => setTimeout(resolve, 50))
		release()
		const results = await Promise.all([first, second])
		expect(reads).toBe(1)
		expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(1)
		expect(await outboxRow(LOYALTY_TILL_SOURCE, 'sale_overlap')).toMatchObject({
			status: 'pending',
			attempts: 1,
			claimedUntil: null,
		})
	})

	it('a second driver failing the same attempt, or a row another driver holds, counts nothing', async () => {
		await activateProgram(ORG)
		breakTillSales()
		await queuedTillSale('sale_double_fail')
		const source = { type: LOYALTY_TILL_SOURCE, id: 'sale_double_fail' }
		const at = NOW + 1000
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			// The outbox driver fails the row first and counts the attempt.
			expect(await processLoyaltyOutbox(ORG, { now: at })).toEqual({
				processed: 0,
				failed: 1,
				parked: 0,
			})
			expect(await outboxRow(source.type, source.id)).toMatchObject({
				attempts: 1,
				claimedUntil: null,
			})
			// A settle driver that failed the same attempt (the row is no longer
			// due at that time) adds nothing.
			await settleLoyaltySources(ORG, [source], { now: at })
			expect(await outboxRow(source.type, source.id)).toMatchObject({
				attempts: 1,
			})

			// Another driver holds the row (an unexpired lease): a failure that
			// is not under that lease adds nothing either.
			const row = (await outboxRow(source.type, source.id))!
			const later = row.nextAttemptAt + 1000
			const db = await getTenantDb(ORG)
			await db
				.update(loyaltyOutbox)
				.set({ claimedUntil: later + LOYALTY_OUTBOX_LEASE_MS })
				.where(eq(loyaltyOutbox.sourceId, source.id))
			await settleLoyaltySources(ORG, [source], { now: later })
			expect(await outboxRow(source.type, source.id)).toMatchObject({
				attempts: 1,
				claimedUntil: later + LOYALTY_OUTBOX_LEASE_MS,
			})
		} finally {
			errorSpy.mockRestore()
		}
	})

	it('reconciling a parked source does not close its row', async () => {
		await activateProgram(ORG)
		await boundTillRedemption('sale_parked_row', NOW)
		await insertPosSale(ORG, { id: 'sale_parked_row' })
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyOutbox).values({
			sourceType: LOYALTY_TILL_SOURCE,
			sourceId: 'sale_parked_row',
			status: 'failed',
			attempts: LOYALTY_OUTBOX_MAX_ATTEMPTS,
			nextAttemptAt: NOW,
			lastError: 'loyalty_unavailable',
			createdAt: NOW,
			updatedAt: NOW,
		})
		const result = await settleLoyaltySources(
			ORG,
			[{ type: LOYALTY_TILL_SOURCE, id: 'sale_parked_row' }],
			{ now: NOW + 1000 },
		)
		expect(result.settled).toBe(1)
		// Only an operator's answer or a new queueing ends a parked row.
		expect(
			await outboxRow(LOYALTY_TILL_SOURCE, 'sale_parked_row'),
		).toMatchObject({ status: 'failed', doneAt: null })
	})

	it('a source that fails right after its sale reports when it is due again', async () => {
		await activateProgram(ORG)
		breakTillSales()
		await queuedTillSale('sale_deferred')
		const at = NOW + 1000
		const armed: number[] = []
		const stop = onLoyaltyDeferred(ORG, (dueAt) => {
			armed.push(dueAt)
		})
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const result = await settleLoyaltySources(
				ORG,
				[{ type: LOYALTY_TILL_SOURCE, id: 'sale_deferred' }],
				{ now: at },
			)
			const row = (await outboxRow(LOYALTY_TILL_SOURCE, 'sale_deferred'))!
			expect(row).toMatchObject({ status: 'pending', attempts: 1 })
			expect(result).toEqual({
				settled: 0,
				deferred: 1,
				nextAttemptAt: row.nextAttemptAt,
			})
			expect(row.nextAttemptAt).toBeGreaterThan(at)
			expect(armed).toEqual([row.nextAttemptAt])
		} finally {
			errorSpy.mockRestore()
			stop()
		}
		// Settling what succeeds reports nothing deferred and arms nothing.
		registerLoyaltySourceAdapter(posOrderLoyaltySource)
		const ok = await settleLoyaltySources(
			ORG,
			[{ type: LOYALTY_TILL_SOURCE, id: 'sale_deferred' }],
			{ now: at + 1000 },
		)
		expect(ok).toEqual({ settled: 1, deferred: 0, nextAttemptAt: null })
		expect(armed).toHaveLength(1)
	})
})
describe('fanOutLoyaltyTick', () => {
	it('aggregates across organizations and survives one failing', async () => {
		await activateProgram(ORG)
		const other = 'org_ll_tick_two'
		await provisionTenantDb(other)
		try {
			const aggregate = await fanOutLoyaltyTick({
				orgIds: [ORG, other, 'org_ll_tick_ghost'],
				run: async (orgId) => {
					if (orgId === 'org_ll_tick_ghost') return null
					return runLoyaltyTickForOrg(orgId, { now: NOW })
				},
			})
			expect(aggregate).toMatchObject({ orgs: 2, errors: 1, orgsDeferred: 0 })
		} finally {
			await destroyTenantDb(other).catch(() => {})
		}
	})

	it('defers the rest when the time budget runs out', async () => {
		const aggregate = await fanOutLoyaltyTick({
			orgIds: ['a', 'b', 'c'],
			budgetMs: 0,
			concurrency: 1,
			now: () => NOW,
			run: async () => {
				// Spend the whole budget on the first org.
				await new Promise((resolve) => setTimeout(resolve, 5))
				return null
			},
		})
		expect(aggregate.orgs + aggregate.errors + aggregate.orgsDeferred).toBe(3)
		expect(aggregate.orgsDeferred).toBeGreaterThan(0)
	})
})

describe('fanOutLoyaltyTick rotation', () => {
	it('starts at a different organization each run, so the tail is reached', async () => {
		const orgIds = ['a', 'b', 'c', 'd']
		const reached = new Set<string>()
		for (let bucket = 0; bucket < orgIds.length; bucket++) {
			let clock = 0
			const ran: string[] = []
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const aggregate = await fanOutLoyaltyTick({
				orgIds,
				rotateBucket: bucket,
				budgetMs: 50,
				concurrency: 1,
				now: () => clock,
				run: async (orgId) => {
					ran.push(orgId)
					// Spend the whole budget on one organization.
					clock += 100
					return null
				},
			})
			warn.mockRestore()
			expect(ran).toEqual([orgIds[bucket]])
			expect(aggregate).toMatchObject({ errors: 1, orgsDeferred: 3 })
			reached.add(ran[0]!)
		}
		expect([...reached].sort()).toEqual(orgIds)
	})

	it('rotates by the hour when no bucket is given, and keeps every organization', async () => {
		const orgIds = ['a', 'b', 'c']
		const HOUR = 60 * 60 * 1000
		const firstAt = async (hour: number) => {
			const ran: string[] = []
			await fanOutLoyaltyTick({
				orgIds,
				now: () => hour * HOUR,
				run: async (orgId) => {
					ran.push(orgId)
					return null
				},
			})
			return ran
		}
		expect((await firstAt(3))[0]).toBe('a')
		expect((await firstAt(4))[0]).toBe('b')
		expect((await firstAt(5))[0]).toBe('c')
		expect((await firstAt(4)).sort()).toEqual(orgIds)
		expect(rotateOrgIds([], 7)).toEqual([])
		expect(rotateOrgIds(['x'], 7)).toEqual(['x'])
		expect(rotateOrgIds(orgIds, -1)).toEqual(['c', 'a', 'b'])
	})
})

describe('runLoyaltyTickLogged', () => {
	it('logs the organization when its tick throws, and returns null', async () => {
		// No database was provisioned for this id: the tick throws inside.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const result = await runLoyaltyTickLogged('org_ll_tick_ghost')
			expect(result).toBeNull()
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty tick failed for organization',
				'org_ll_tick_ghost',
				expect.any(String),
			)
		} finally {
			errorSpy.mockRestore()
		}
	})

	it('returns the result for a healthy organization', async () => {
		await activateProgram(ORG)
		const result = await runLoyaltyTickLogged(ORG)
		expect(result).toMatchObject({ needsFollowUp: false, outboxParked: 0 })
	})
})
