import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GiftCardDomainError } from '@repo/common/gift-cards'
import {
	destroyTenantDb,
	getTenantDb,
	giftCardAttempts,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	chargeGiftCardGuess,
	enforceGiftCardPurchaseLimit,
	GIFT_CARD_RATE_LIMITS,
	purgeGiftCardAttempts,
	settleGiftCardGuess,
} from './gift-card-rate-limit.ts'
import { syncEnvFromProcess } from './secrets.ts'

const ORG = 'org_gift_rate_limit'
let dir = ''

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-rate-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.AUTH_HMAC_SECRET = 'gift-rate-hmac-secret-0123456789abcdef'
	syncEnvFromProcess()
	await provisionTenantDb(ORG)
})

afterAll(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(dir, { recursive: true, force: true })
})

async function rejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		return error
	}
	return null
}

describe('purchase limits', () => {
	it('stops one signed-in customer across addresses, which the address limit cannot', async () => {
		const db = await getTenantDb(ORG)
		const max = GIFT_CARD_RATE_LIMITS.purchaseCustomer.max
		const now = Date.now()
		for (let i = 0; i < max; i += 1) {
			await enforceGiftCardPurchaseLimit(
				db,
				ORG,
				{ address: `10.0.${i}.0`, customerId: 'cust_flood' },
				now,
			)
		}
		const error = await rejection(
			enforceGiftCardPurchaseLimit(
				db,
				ORG,
				{ address: '10.9.9.0', customerId: 'cust_flood' },
				now,
			),
		)
		expect(error).toBeInstanceOf(GiftCardDomainError)
		expect((error as GiftCardDomainError).code).toBe('rate_limited')
		// Another customer from yet another address is untouched.
		await expect(
			enforceGiftCardPurchaseLimit(
				db,
				ORG,
				{ address: '10.8.8.0', customerId: 'cust_other' },
				now,
			),
		).resolves.toBeUndefined()
	})

	it('still limits a guest by address alone', async () => {
		const db = await getTenantDb(ORG)
		const max = GIFT_CARD_RATE_LIMITS.purchaseIp.max
		const now = Date.now()
		for (let i = 0; i < max; i += 1) {
			await enforceGiftCardPurchaseLimit(
				db,
				ORG,
				{ address: '172.16.0.0' },
				now,
			)
		}
		const error = await rejection(
			enforceGiftCardPurchaseLimit(db, ORG, { address: '172.16.0.0' }, now),
		)
		expect((error as GiftCardDomainError).code).toBe('rate_limited')
	})
})

describe('guess limits', () => {
	it('gives a right guess back and keeps a wrong one', async () => {
		const db = await getTenantDb(ORG)
		const subject = { kind: 'device', deviceId: 'dev_guess' } as const
		const max = GIFT_CARD_RATE_LIMITS.guessDevice.max
		const now = Date.now()
		// Rights never use the budget.
		for (let i = 0; i < max + 5; i += 1) {
			const charge = await chargeGiftCardGuess(db, { orgId: ORG, subject }, now)
			await settleGiftCardGuess(db, charge, 'right')
		}
		// Wrongs do.
		for (let i = 0; i < max; i += 1) {
			const charge = await chargeGiftCardGuess(db, { orgId: ORG, subject }, now)
			await settleGiftCardGuess(db, charge, 'wrong')
		}
		const error = await rejection(
			chargeGiftCardGuess(db, { orgId: ORG, subject }, now),
		)
		expect((error as GiftCardDomainError).code).toBe('rate_limited')
	})

	it('does not purge on the guess path', async () => {
		const db = await getTenantDb(ORG)
		const old = Date.now() - 5 * 60 * 60_000
		await db.insert(giftCardAttempts).values({
			bucket: 'guessIp',
			subjectHash: 'stale-row-for-the-purge-test',
			windowStart: old,
			count: 3,
		})
		await chargeGiftCardGuess(db, {
			orgId: ORG,
			subject: { kind: 'guest', address: '192.0.2.0' },
		})
		const rows = await db.select().from(giftCardAttempts)
		expect(
			rows.some((row) => row.subjectHash === 'stale-row-for-the-purge-test'),
		).toBe(true)
	})
})

describe('purgeGiftCardAttempts', () => {
	it('removes windows that ended long ago and keeps the current ones', async () => {
		const db = await getTenantDb(ORG)
		const now = Date.now()
		await db.insert(giftCardAttempts).values([
			{
				bucket: 'guessIp',
				subjectHash: 'purge-old',
				windowStart: now - 5 * 60 * 60_000,
				count: 1,
			},
			{
				bucket: 'guessIp',
				subjectHash: 'purge-fresh',
				windowStart: now,
				count: 1,
			},
		])
		await purgeGiftCardAttempts(db, now)
		const hashes = (await db.select().from(giftCardAttempts)).map(
			(row) => row.subjectHash,
		)
		expect(hashes).not.toContain('purge-old')
		expect(hashes).not.toContain('stale-row-for-the-purge-test')
		expect(hashes).toContain('purge-fresh')
	})
})
