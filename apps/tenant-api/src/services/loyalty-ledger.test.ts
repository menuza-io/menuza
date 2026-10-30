import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyBalances,
	loyaltyLedger,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import {
	checkMemberBalanceInTx,
	findBalanceMismatches,
	holdPointsInTx,
	postLedgerEntryInTx,
	releaseHeldPointsInTx,
	repairMemberBalanceInTx,
} from './loyalty-ledger.ts'
import {
	activateProgram,
	balanceOf,
	expectLoyaltyError,
	givePoints,
	insertCustomer,
	makeMember,
	NOW,
	storedBalanceOf,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_ledger'

let directory: string
let memberCounter = 0

async function seedMember(points = 0): Promise<string> {
	const customerId = `cus_${++memberCounter}`
	await insertCustomer(ORG, { id: customerId })
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return memberId
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-ledger-'))
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

describe('posting ledger entries', () => {
	it('posts an entry and applies it to the balance in one transaction', async () => {
		const memberId = await seedMember()
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			const posted = await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn',
				delta: 25,
				eventKey: 'earn:test-1',
				actorKind: 'system',
				at: NOW,
			})
			expect(posted.inserted).toBe(true)
		})
		const balance = await balanceOf(ORG, memberId)
		expect(balance).toMatchObject({ points: 25, reserved: 0, available: 25 })
		const stored = await storedBalanceOf(ORG, memberId)
		expect(stored).toMatchObject({ lifetimeEarned: 25, lifetimeRedeemed: 0 })
	})

	it('is idempotent by event key: posting the same key twice changes nothing', async () => {
		const memberId = await seedMember()
		let firstId = ''
		for (let i = 0; i < 2; i++) {
			await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
				const posted = await postLedgerEntryInTx(tx, {
					memberId,
					type: 'earn',
					delta: 25,
					eventKey: 'earn:test-dup',
					actorKind: 'system',
					at: NOW,
				})
				if (i === 0) {
					expect(posted.inserted).toBe(true)
					firstId = posted.id
				} else {
					expect(posted.inserted).toBe(false)
					expect(posted.id).toBe(firstId)
				}
			})
		}
		expect((await balanceOf(ORG, memberId)).points).toBe(25)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, memberId))
		expect(rows).toHaveLength(1)
	})

	it('rejects the same event key for another member as a conflict and rolls back', async () => {
		const first = await seedMember()
		const second = await seedMember()
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			await postLedgerEntryInTx(tx, {
				memberId: first,
				type: 'earn',
				delta: 5,
				eventKey: 'earn:shared',
				actorKind: 'system',
				at: NOW,
			})
		})
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
				await postLedgerEntryInTx(tx, {
					memberId: second,
					type: 'earn',
					delta: 5,
					eventKey: 'earn:shared',
					actorKind: 'system',
					at: NOW,
				})
			}),
			'idempotency_conflict',
		)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, second))
		expect(rows).toHaveLength(0)
	})

	it('rejects a delta whose sign does not fit the entry type', async () => {
		const memberId = await seedMember()
		for (const [type, delta] of [
			['earn', -5],
			['earn', 0],
			['redeem', 5],
			['adjust', 0],
		] as const) {
			await expectLoyaltyError(
				withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
					await postLedgerEntryInTx(tx, {
						memberId,
						type,
						delta,
						eventKey: `bad:${type}:${delta}`,
						reason: type === 'adjust' ? 'correction' : null,
						actorKind: 'system',
						at: NOW,
					})
				}),
				'adjustment_invalid',
			)
		}
	})

	it('allows points debt: a reversal may take the balance below zero', async () => {
		const memberId = await seedMember()
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn',
				delta: 10,
				eventKey: 'earn:test-debt',
				actorKind: 'system',
				at: NOW,
			})
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn_reversal',
				delta: -15,
				eventKey: 'reverse:test-debt',
				actorKind: 'operator',
				actorId: 'op_test',
				at: NOW,
			})
		})
		const balance = await balanceOf(ORG, memberId)
		expect(balance.points).toBe(-5)
		expect(balance.available).toBe(-5)
		const stored = await storedBalanceOf(ORG, memberId)
		expect(stored!.lifetimeEarned).toBe(-5)
	})
})

describe('holds', () => {
	it('holds points only when the available balance covers them', async () => {
		const memberId = await seedMember(10)
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			expect(await holdPointsInTx(tx, memberId, 10, NOW)).toBe(true)
			expect(await holdPointsInTx(tx, memberId, 1, NOW)).toBe(false)
			expect(await holdPointsInTx(tx, memberId, 0, NOW)).toBe(false)
			expect(await holdPointsInTx(tx, memberId, -3, NOW)).toBe(false)
		})
		const balance = await balanceOf(ORG, memberId)
		expect(balance).toMatchObject({ points: 10, reserved: 10, available: 0 })
	})

	it('a member in debt cannot hold points', async () => {
		const memberId = await seedMember()
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn_reversal',
				delta: -4,
				eventKey: 'reverse:debt-hold',
				actorKind: 'system',
				at: NOW,
			})
			expect(await holdPointsInTx(tx, memberId, 1, NOW)).toBe(false)
		})
	})

	it('releases held points back to the available balance', async () => {
		const memberId = await seedMember(10)
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			expect(await holdPointsInTx(tx, memberId, 6, NOW)).toBe(true)
			await releaseHeldPointsInTx(tx, memberId, 6, NOW)
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
			available: 10,
		})
	})
})

describe('rebuilding balances from the ledger', () => {
	it('finds a corrupted projection and repairs it without touching the ledger', async () => {
		const memberId = await seedMember(20)
		const db = await getTenantDb(ORG)
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			expect(await holdPointsInTx(tx, memberId, 5, NOW)).toBe(true)
		})
		// Corrupt the projection directly (balances have no update trigger; the
		// ledger does, which is what makes the rebuild authoritative).
		await db
			.update(loyaltyBalances)
			.set({ points: 999, lifetimeEarned: 1 })
			.where(eq(loyaltyBalances.memberId, memberId))

		const before = await checkMemberBalanceInTx(db, memberId)
		expect(before.matches).toBe(false)
		expect(before.stored.points).toBe(999)
		// The rebuild reads reserved points from the redemptions holding them,
		// so the bare hold above (no redemption row) rebuilds as zero.
		// (`adjust` entries never count toward lifetimeEarned.)
		expect(before.rebuilt).toMatchObject({
			points: 20,
			reserved: 0,
			lifetimeEarned: 0,
		})

		const scan = await findBalanceMismatches(db)
		expect(scan.mismatches.map((m) => m.memberId)).toContain(memberId)

		const repaired = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW },
			async (tx) => repairMemberBalanceInTx(tx, memberId, NOW),
		)
		expect(repaired.matches).toBe(false)
		const after = await checkMemberBalanceInTx(db, memberId)
		expect(after.matches).toBe(true)
		const scanAfter = await findBalanceMismatches(db)
		expect(scanAfter.mismatches).toHaveLength(0)

		// The ledger itself was never rewritten.
		const rows = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, memberId))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ type: 'adjust', delta: 20 })
	})

	it('pages through balances with a cursor', async () => {
		await seedMember(3)
		await seedMember(4)
		const db = await getTenantDb(ORG)
		const page1 = await findBalanceMismatches(db, { limit: 1 })
		expect(page1.mismatches).toHaveLength(0)
		expect(page1.nextMemberId).not.toBeNull()
		const page2 = await findBalanceMismatches(db, {
			afterMemberId: page1.nextMemberId,
			limit: 10,
		})
		expect(page2.mismatches).toHaveLength(0)
		expect(page2.nextMemberId).toBeNull()
	})
})

/** Drizzle reports the failing statement; the trigger's own message is the cause. */
async function expectDbAbort(
	promise: Promise<unknown>,
	needle: RegExp,
): Promise<void> {
	try {
		await promise
	} catch (error) {
		const cause =
			error instanceof Error
				? String((error as { cause?: unknown }).cause ?? '')
				: ''
		expect(cause).toMatch(needle)
		return
	}
	throw new Error('expected the statement to fail')
}

describe('the ledger is append-only', () => {
	it('refuses updates and deletes of ledger rows, allowing only erasure of the note', async () => {
		const memberId = await seedMember(5)
		const db = await getTenantDb(ORG)
		await expectDbAbort(
			db
				.update(loyaltyLedger)
				.set({ delta: 500 })
				.where(eq(loyaltyLedger.memberId, memberId)),
			/append-only/,
		)
		await expectDbAbort(
			db.delete(loyaltyLedger).where(eq(loyaltyLedger.memberId, memberId)),
			/append-only/,
		)
		// The one allowed change: erasure clearing the note.
		await db
			.update(loyaltyLedger)
			.set({ note: null })
			.where(eq(loyaltyLedger.memberId, memberId))
		const rows = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, memberId))
		expect(rows[0]!.delta).toBe(5)
	})

	it('never lets reserved points go negative, even by hand', async () => {
		const memberId = await seedMember(5)
		const db = await getTenantDb(ORG)
		await expectDbAbort(
			db.run(
				sql`UPDATE loyalty_balances SET reserved = -1 WHERE member_id = ${memberId}`,
			),
			/chk_loyalty_balances_reserved/,
		)
	})
})
