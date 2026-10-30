import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyAuditLog,
	loyaltyIdempotencyKeys,
	loyaltyLedger,
	loyaltyRefunds,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq, inArray, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashLoyaltyRequest } from '../lib/loyalty-write.ts'
import {
	adjustMemberPoints,
	ensureMemberForCustomer,
	setMemberStatus,
} from './loyalty-member-service.ts'
import {
	reconcileLoyaltySource,
	resolvePurchase,
} from './loyalty-purchase-service.ts'
import { resolveRedemption } from './loyalty-redemption-service.ts'
import { recordLoyaltyRefund } from './loyalty-refund-service.ts'
import {
	activateProgram,
	balanceOf,
	claimAndQueue,
	insertCustomer,
	insertOrder,
	makeReward,
	NOW,
	reserveReward,
} from './loyalty-test-fixture.ts'
import { erasePerson } from './person-erasure-service.ts'

const ORG = 'org_ll_erasure'
const NAME = 'Zainab Al-Farsi'
const PHONE = '+966501234567'
/** Strings that identify the person; none may survive the erasure. */
const NEEDLES = ['Zainab', 'allergy', 'cold soup']
const OTHER_NOTE = 'Omar keeps this note'

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-erasure-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

function idempotency(scope: string, payload: unknown) {
	return {
		scope,
		key: `key-${scope}`,
		requestHash: hashLoyaltyRequest(payload),
	}
}

/** Names of the tables whose rows still contain one of the strings. */
async function tablesContaining(db: TenantDatabase, needles: string[]) {
	const tables = (await db.all(
		sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
	)) as Array<{ name: string }>
	const found: string[] = []
	for (const { name } of tables) {
		const rows = JSON.stringify(
			await db.all(sql.raw(`select * from "${name}"`)),
		).toLowerCase()
		if (needles.some((needle) => rows.includes(needle.toLowerCase()))) {
			found.push(name)
		}
	}
	return found.sort()
}

async function enroll(customerId: string) {
	const member = await ensureMemberForCustomer(ORG, {
		customerId,
		now: NOW,
	})
	return member!.id
}

async function adjust(memberId: string, delta: number, note: string) {
	const body = { delta, reason: 'goodwill' as const, note }
	const idem = idempotency(`adjust:${memberId}`, body)
	await adjustMemberPoints(ORG, {
		memberId,
		...body,
		actorId: 'op_test',
		idempotencyKey: idem.key,
		now: NOW,
		idempotency: idem,
	})
}

async function suspend(memberId: string) {
	const body = { status: 'suspended' as const }
	return setMemberStatus(ORG, {
		memberId,
		...body,
		actorId: 'op_test',
		now: NOW + 4000,
		idempotency: idempotency(`member-status:${memberId}`, body),
	})
}

/**
 * One member with every kind of loyalty row an operator can annotate: an
 * adjustment note, refunds with notes (with and without a purchase), review
 * decisions with notes, and stored responses carrying the name and phone.
 */
async function seedMemberWithHistory(memberId: string) {
	await adjust(memberId, 50, 'Birthday gift for Zainab, allergy to nuts')
	const reward = await makeReward(ORG) // 10 points, 5.00 off

	// A finished order and a partial refund of it.
	const earned = {
		type: 'restaurant_order' as const,
		id: await insertOrder(ORG, { subtotalCents: 2000 }),
	}
	await claimAndQueue(ORG, { memberId, source: earned })
	await reconcileLoyaltySource(ORG, earned, { now: NOW })
	await recordLoyaltyRefund(ORG, {
		source: earned,
		amountMinor: 500,
		note: 'Zainab found cold soup',
		actorId: 'op_test',
		locationIds: null,
		idempotencyKey: 'refund-1',
		now: NOW + 1000,
	})

	// The till gave another discount than the reward: both go to review.
	const mismatched = {
		type: 'restaurant_order' as const,
		id: await insertOrder(ORG, {
			subtotalCents: 2000,
			loyaltyDiscountCents: 300,
		}),
	}
	await reserveReward(ORG, {
		memberId,
		rewardId: reward.id,
		source: mismatched,
	})
	await claimAndQueue(ORG, { memberId, source: mismatched })
	const review = await reconcileLoyaltySource(ORG, mismatched, { now: NOW })
	const redemptionBody = { action: 'release' as const, note: 'Zainab called' }
	await resolveRedemption(ORG, {
		redemptionId: review.redemption!.id,
		...redemptionBody,
		actorId: 'op_test',
		locationIds: null,
		now: NOW + 2000,
		idempotency: idempotency(
			`resolve-redemption:${review.redemption!.id}`,
			redemptionBody,
		),
	})
	const purchaseBody = { action: 'exclude' as const, note: 'Zainab, mismatch' }
	await resolvePurchase(ORG, {
		purchaseId: review.purchase!.id,
		...purchaseBody,
		actorId: 'op_test',
		locationIds: null,
		now: NOW + 2000,
		idempotency: idempotency(
			`resolve-purchase:${review.purchase!.id}`,
			purchaseBody,
		),
	})

	// A refund of an order the member only spent on: no purchase row.
	const spentOnly = {
		type: 'restaurant_order' as const,
		id: await insertOrder(ORG, {
			subtotalCents: 2000,
			loyaltyDiscountCents: 500,
		}),
	}
	await reserveReward(ORG, { memberId, rewardId: reward.id, source: spentOnly })
	const refund = await recordLoyaltyRefund(ORG, {
		source: spentOnly,
		amountMinor: 200,
		note: 'Refund after the allergy reaction',
		actorId: 'op_test',
		locationIds: null,
		idempotencyKey: 'refund-2',
		now: NOW + 3000,
	})
	expect(refund.purchaseId).toBeNull()

	return suspend(memberId)
}

describe('erasing a person who is a loyalty member', () => {
	it('removes their name, phone digits and operator notes from every loyalty table', async () => {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_z', name: NAME, phone: PHONE })
		await insertCustomer(ORG, {
			id: 'cus_o',
			name: 'Omar Other',
			phone: '+966500000001',
		})
		const memberId = await enroll('cus_z')
		const otherId = await enroll('cus_o')
		const summary = await seedMemberWithHistory(memberId)
		expect(summary).toMatchObject({ name: NAME, phoneLast4: '4567' })
		await adjust(otherId, 5, OTHER_NOTE)
		await suspend(otherId)

		const db = await getTenantDb(ORG)
		const linked = await db
			.select({ scope: loyaltyIdempotencyKeys.scope })
			.from(loyaltyIdempotencyKeys)
			.where(eq(loyaltyIdempotencyKeys.memberId, memberId))
			.all()
		expect(linked.map((row) => row.scope).sort()).toEqual(
			[
				'adjust',
				'member-status',
				'refund',
				'refund',
				'resolve-purchase',
				'resolve-redemption',
			].map((prefix) => expect.stringMatching(new RegExp(`^${prefix}:`))),
		)
		// The test would prove nothing if the person were not in these rows.
		expect(await tablesContaining(db, NEEDLES)).toEqual([
			'customers',
			'loyalty_audit_log',
			'loyalty_idempotency_keys',
			'loyalty_ledger',
			'loyalty_refunds',
		])
		const balanceBefore = await balanceOf(ORG, memberId)

		await erasePerson(
			db,
			{ customerId: 'cus_z' },
			{ actorId: 'op_test', now: NOW + 5000 },
		)

		expect(await tablesContaining(db, NEEDLES)).toEqual([])
		const keys = await db.select().from(loyaltyIdempotencyKeys).all()
		expect(keys.filter((row) => row.memberId === memberId)).toEqual([])
		expect(
			keys.some((row) =>
				JSON.stringify(JSON.parse(row.responseJson)).includes(
					'"phoneLast4":"4567"',
				),
			),
		).toBe(false)
		const refunds = await db.select().from(loyaltyRefunds).all()
		expect(refunds).toHaveLength(2)
		expect(refunds.every((row) => row.note === null)).toBe(true)

		// The books stay: amounts and the balance are untouched.
		expect(refunds.map((row) => row.amountMinor).sort()).toEqual([200, 500])
		expect(await balanceOf(ORG, memberId)).toEqual(balanceBefore)

		// The other member keeps everything.
		expect(
			keys.filter((row) => row.memberId === otherId).map((row) => row.scope),
		).toEqual(
			expect.arrayContaining([
				`adjust:${otherId}`,
				`member-status:${otherId}`,
			]),
		)
		const otherLedger = await db
			.select({ note: loyaltyLedger.note })
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, otherId))
			.all()
		expect(otherLedger.map((row) => row.note)).toContain(OTHER_NOTE)
		const otherAudit = await db
			.select({ changes: loyaltyAuditLog.changes })
			.from(loyaltyAuditLog)
			.where(inArray(loyaltyAuditLog.entityId, [otherId]))
			.all()
		expect(otherAudit.length).toBeGreaterThan(0)
		expect(otherAudit.some((row) => row.changes?.redacted === true)).toBe(false)
	})
})
