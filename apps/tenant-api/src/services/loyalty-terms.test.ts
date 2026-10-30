import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getPublicProgram,
	readProgramInTx,
	saveProgram,
} from './loyalty-program-service.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import {
	activateProgram,
	balanceOf,
	claimAndQueue,
	givePoints,
	insertCustomer,
	insertOrder,
	makeMember,
	makeReward,
	NOW,
	programConfig,
	reserveReward,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_terms'

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-terms-'))
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

/**
 * Program terms are display text for the wallet. There is no version to
 * accept: editing the text never stops anyone from earning or spending.
 */
describe('program terms are display text only', () => {
	it('a terms edit never stops a member earning, before or after it', async () => {
		const active = await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_terms' })
		const memberId = await makeMember(ORG, { customerId: 'cus_terms' })

		const before = {
			type: 'restaurant_order' as const,
			id: await insertOrder(ORG, {}),
		}
		await claimAndQueue(ORG, { memberId, source: before })
		await reconcileLoyaltySource(ORG, before, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		// The operator edits the terms between the claim and the finish of a
		// later sale: the member accepted nothing, and nothing is asked.
		const during = {
			type: 'restaurant_order' as const,
			id: await insertOrder(ORG, {}),
		}
		await claimAndQueue(ORG, { memberId, source: during, at: NOW + 1000 })
		await saveProgram(ORG, {
			expectedVersion: active.version,
			config: programConfig({ terms: 'NEW TERMS: points expire in 30 days.' }),
			actorId: 'op_test',
			now: NOW + 2000,
		})
		const result = await reconcileLoyaltySource(ORG, during, {
			now: NOW + 3000,
		})
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 10,
			excludedReason: null,
		})

		const after = {
			type: 'restaurant_order' as const,
			id: await insertOrder(ORG, {}),
		}
		await claimAndQueue(ORG, { memberId, source: after, at: NOW + 4000 })
		await reconcileLoyaltySource(ORG, after, { now: NOW + 5000 })
		expect((await balanceOf(ORG, memberId)).points).toBe(30)
	})

	it('a terms edit never stops a member spending a reward', async () => {
		const active = await activateProgram(ORG)
		const reward = await makeReward(ORG)
		await insertCustomer(ORG, { id: 'cus_terms' })
		const memberId = await makeMember(ORG, { customerId: 'cus_terms' })
		await givePoints(ORG, memberId, 50)
		await saveProgram(ORG, {
			expectedVersion: active.version,
			config: programConfig({ terms: 'Different terms.' }),
			actorId: 'op_test',
			now: NOW + 1000,
		})
		const hold = await reserveReward(ORG, { memberId, rewardId: reward.id })
		expect(hold.state).toBe('reserved')
		expect((await balanceOf(ORG, memberId)).reserved).toBe(10)
	})

	it('shows the terms text, and null when the operator left it blank', async () => {
		const active = await activateProgram(ORG)
		const features = { enabled: true, redemption: true }
		const db = await getTenantDb(ORG)
		expect((await getPublicProgram(db, features))?.terms).toBe('The terms.')
		const saved = await saveProgram(ORG, {
			expectedVersion: active.version,
			config: programConfig({ terms: '   ' }),
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(saved.current.config.terms).toBe('')
		expect((await getPublicProgram(db, features))?.terms).toBeNull()
		// A program version carries no terms version any more.
		const current = await readProgramInTx(db)
		expect(current!.current).not.toHaveProperty('termsVersion')
	})
})
