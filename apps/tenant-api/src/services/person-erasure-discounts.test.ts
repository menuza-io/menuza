import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	discountRedemptions,
	getTenantDb,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { erasePerson } from './person-erasure-service.ts'

const ORG = 'org_erase_discounts'

let tempDir: string
let db: TenantDatabase

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'erase-discounts-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	db = await getTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

async function redemption(id: string, customerId: string) {
	await db.insert(discountRedemptions).values({
		id,
		discountId: 'disc_1',
		discountVersion: 1,
		sourceType: 'order',
		sourceId: `order_${id}`,
		customerId,
		state: 'reserved',
		amountMinor: 500,
		allocation: [],
		snapshot: {},
		localDay: '2026-10-30',
		localWeek: '2026-W44',
	})
}

describe('erasing a person and their discount history', () => {
	it('unlinks the erased customer from their redemptions and leaves others alone', async () => {
		await db.insert(customers).values([
			{
				id: 'cus_gone',
				name: 'Gone',
				phone: '+14155550101',
				phoneVerified: true,
			},
			{
				id: 'cus_kept',
				name: 'Kept',
				phone: '+14155550102',
				phoneVerified: true,
			},
		])
		await redemption('r_gone', 'cus_gone')
		await redemption('r_kept', 'cus_kept')

		await erasePerson(db, { customerId: 'cus_gone' }, { actorId: 'sys' })

		const gone = await db
			.select()
			.from(discountRedemptions)
			.where(eq(discountRedemptions.id, 'r_gone'))
			.get()
		const kept = await db
			.select()
			.from(discountRedemptions)
			.where(eq(discountRedemptions.id, 'r_kept'))
			.get()
		// The use still counts toward the discount's limits, without a person.
		expect(gone).toMatchObject({ customerId: null, amountMinor: 500 })
		expect(kept?.customerId).toBe('cus_kept')
	})
})
