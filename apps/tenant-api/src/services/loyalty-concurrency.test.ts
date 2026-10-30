import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LoyaltyDomainError } from '@repo/loyalty'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	hashLoyaltyRequest,
	LOYALTY_IDEMPOTENCY_TTL_MS,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import {
	claimPurchaseInTx,
	purchaseForSourceInTx,
} from './loyalty-purchase-service.ts'
import {
	activateProgram,
	balanceOf,
	givePoints,
	insertCustomer,
	loyaltyCart,
	makeMember,
	makeReward,
	memberRow,
	NOW,
	reserveReward,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_race'
const PARALLEL = 10

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-race-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

async function memberWithPoints(points: number, tag: string): Promise<string> {
	await insertCustomer(ORG, { id: `cus_${tag}` })
	const memberId = await makeMember(ORG, { customerId: `cus_${tag}` })
	if (points > 0) await givePoints(ORG, memberId, points)
	return memberId
}

describe('concurrent redemption on one balance', () => {
	it('ten parallel reservations for a balance that covers exactly one: one wins', async () => {
		const memberId = await memberWithPoints(10, 'race')
		const reward = await makeReward(ORG) // 10 points, 500 off the order
		const outcomes = await Promise.all(
			Array.from({ length: PARALLEL }, (_, i) =>
				reserveReward(ORG, {
					memberId,
					rewardId: reward.id,
					source: { type: 'restaurant_order', id: `ord_race_${i}` },
					at: NOW,
				}).then(
					(row) => ({ ok: true as const, state: row.state }),
					(error: unknown) => ({
						ok: false as const,
						code:
							error instanceof LoyaltyDomainError ? error.code : 'unexpected',
					}),
				),
			),
		)
		const won = outcomes.filter((o) => o.ok)
		const lost = outcomes.filter((o) => !o.ok)
		expect(won).toHaveLength(1)
		expect(won[0]).toMatchObject({ state: 'bound' })
		expect(lost).toHaveLength(PARALLEL - 1)
		for (const outcome of lost) {
			expect(outcome).toMatchObject({ code: 'insufficient_points' })
		}
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 10,
			available: 0,
		})
	})
})

describe('concurrent claims on one source', () => {
	it('ten members claiming one order: one purchase, the rest already_claimed', async () => {
		const memberIds = await Promise.all(
			Array.from({ length: PARALLEL }, (_, i) =>
				memberWithPoints(0, `claim_${i}`),
			),
		)
		const source = { type: 'restaurant_order' as const, id: 'ord_contested' }
		const outcomes = await Promise.all(
			memberIds.map((memberId) =>
				withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx, ctx) => {
					const member = (await memberRow(ORG, memberId))!
					return claimPurchaseInTx(tx, {
						member,
						source,
						locationId: 'loc_1',
						currency: 'USD',
						at: ctx.now,
					})
				}).then(
					(purchase) => ({ ok: true as const, memberId: purchase.memberId }),
					(error: unknown) => ({
						ok: false as const,
						code:
							error instanceof LoyaltyDomainError ? error.code : 'unexpected',
					}),
				),
			),
		)
		const won = outcomes.filter((o) => o.ok)
		expect(won).toHaveLength(1)
		const lost = outcomes.filter((o) => !o.ok)
		expect(lost).toHaveLength(PARALLEL - 1)
		for (const outcome of lost) {
			expect(outcome).toMatchObject({ code: 'already_claimed' })
		}
		const db = await import('@repo/tenant-db').then((m) => m.getTenantDb(ORG))
		const purchase = await purchaseForSourceInTx(db, source)
		expect(purchase!.memberId).toBe(won[0]!.memberId)
	})
})

describe('durable idempotency of the write gate', () => {
	it('replays the first result for the same key and payload without re-running', async () => {
		let runs = 0
		const options = {
			orgId: ORG,
			now: NOW,
			idempotency: {
				scope: 'test-scope',
				key: 'key-1',
				requestHash: hashLoyaltyRequest({ attempt: 1 }),
			},
		}
		const fn = async () => {
			runs += 1
			return { value: 42, runs }
		}
		const first = await withLoyaltyWrite(options, fn)
		const second = await withLoyaltyWrite(options, fn)
		expect(first).toEqual({ value: 42, runs: 1 })
		expect(second).toEqual({ value: 42, runs: 1 })
		expect(runs).toBe(1)
	})

	it('refuses the same key with a different payload', async () => {
		const scope = { scope: 'test-scope', key: 'key-2' }
		await withLoyaltyWrite(
			{
				orgId: ORG,
				now: NOW,
				idempotency: { ...scope, requestHash: hashLoyaltyRequest({ a: 1 }) },
			},
			async () => ({ ok: true }),
		)
		let runs = 0
		const error = await withLoyaltyWrite(
			{
				orgId: ORG,
				now: NOW,
				idempotency: { ...scope, requestHash: hashLoyaltyRequest({ a: 2 }) },
			},
			async () => {
				runs += 1
				return { ok: true }
			},
		).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LoyaltyDomainError)
		expect((error as LoyaltyDomainError).code).toBe('idempotency_conflict')
		expect(runs).toBe(0)
	})

	it('treats an expired idempotency record as new work', async () => {
		const scope = { scope: 'test-scope', key: 'key-3' }
		const requestHash = hashLoyaltyRequest({ a: 1 })
		let runs = 0
		const fn = async () => {
			runs += 1
			return { runs }
		}
		await withLoyaltyWrite(
			{
				orgId: ORG,
				now: NOW,
				idempotency: { ...scope, requestHash },
			},
			fn,
		)
		const again = await withLoyaltyWrite(
			{
				orgId: ORG,
				now: NOW + LOYALTY_IDEMPOTENCY_TTL_MS + 1,
				idempotency: { ...scope, requestHash },
			},
			fn,
		)
		expect(again).toEqual({ runs: 2 })
	})
})
