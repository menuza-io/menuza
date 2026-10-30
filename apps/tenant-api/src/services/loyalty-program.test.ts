import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOYALTY_FEATURES_OFF, type LoyaltyFeatures } from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyRewards,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	activeRewardsInTx,
	createReward,
	getOperatorProgram,
	getPublicProgram,
	LOYALTY_MAX_REWARDS,
	listOperatorRewards,
	saveProgram,
	setProgramStatus,
	setRewardStatus,
	updateReward,
} from './loyalty-program-service.ts'
import {
	activateProgram,
	expectLoyaltyError,
	makeReward,
	NOW,
	programConfig,
	rewardDefinition,
	saveDraftProgram,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_program'

const FEATURES_ON: LoyaltyFeatures = {
	enabled: true,
	redemption: true,
}

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-program-'))
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

describe('saveProgram', () => {
	it('creates a draft program on the first save, requiring a null expected version', async () => {
		await expectLoyaltyError(
			saveProgram(ORG, {
				expectedVersion: 0,
				config: programConfig(),
				actorId: 'op_test',
				now: NOW,
			}),
			'stale_version',
		)
		const saved = await saveDraftProgram(ORG)
		expect(saved).toMatchObject({
			id: 'default',
			status: 'draft',
			version: 1,
			currencyLocked: false,
		})
		expect(saved.current).toMatchObject({ version: 1, status: 'draft' })
		expect(saved.history).toHaveLength(1)
	})

	it('appends a version per save and refuses stale expected versions', async () => {
		await saveDraftProgram(ORG)
		const saved = await saveProgram(ORG, {
			expectedVersion: 1,
			config: programConfig({ name: 'Renamed Club' }),
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(saved.version).toBe(2)
		expect(saved.current).toMatchObject({ version: 2 })
		expect(saved.current.config.name).toBe('Renamed Club')
		expect(saved.history.map((h) => h.version)).toEqual([2, 1])
		const error = await expectLoyaltyError(
			saveProgram(ORG, {
				expectedVersion: 1,
				config: programConfig(),
				actorId: 'op_test',
				now: NOW,
			}),
			'stale_version',
		)
		expect(error.details).toMatchObject({ currentVersion: 2 })
	})

	it('keeps the terms as plain text on the version, with no terms version', async () => {
		await saveDraftProgram(ORG)
		const edited = await saveProgram(ORG, {
			expectedVersion: 1,
			config: programConfig({ terms: 'New terms.' }),
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(edited.current.config.terms).toBe('New terms.')
		expect(edited.current).not.toHaveProperty('termsVersion')
		expect(edited.version).toBe(2)
	})

	it('rejects an invalid configuration', async () => {
		await expect(
			saveProgram(ORG, {
				expectedVersion: null,
				config: programConfig({ currency: 'usd' }),
				actorId: 'op_test',
				now: NOW,
			}),
		).rejects.toThrow()
	})
})

describe('the currency lock', () => {
	it('lets the currency change while the program was never active and reissues rewards', async () => {
		await saveDraftProgram(ORG)
		const reward = await makeReward(ORG)
		expect(reward.currency).toBe('USD')
		const saved = await saveProgram(ORG, {
			expectedVersion: 1,
			config: programConfig({ currency: 'EUR' }),
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(saved.currencyLocked).toBe(false)
		const db = await getTenantDb(ORG)
		const rewards = await activeRewardsInTx(db)
		expect(rewards).toHaveLength(1)
		expect(rewards[0]!.currency).toBe('EUR')
		expect(rewards[0]!.version).toBe(2)
	})

	it('locks the currency once the program has been active', async () => {
		await activateProgram(ORG)
		const error = await expectLoyaltyError(
			saveProgram(ORG, {
				expectedVersion: 2,
				config: programConfig({ currency: 'EUR' }),
				actorId: 'op_test',
				now: NOW + 1000,
			}),
			'config_invalid',
		)
		expect(error.details).toMatchObject({ field: 'currency', reason: 'locked' })
		// Even pausing does not unlock it.
		await setProgramStatus(ORG, {
			expectedVersion: 2,
			status: 'paused',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		await expectLoyaltyError(
			saveProgram(ORG, {
				expectedVersion: 3,
				config: programConfig({ currency: 'EUR' }),
				actorId: 'op_test',
				now: NOW + 2000,
			}),
			'config_invalid',
		)
	})

	it('is also enforced by the database trigger', async () => {
		await activateProgram(ORG)
		const db = await getTenantDb(ORG)
		const { loyaltyPrograms } = await import('@repo/tenant-db')
		const { eq } = await import('drizzle-orm')
		let triggerError = ''
		try {
			await db
				.update(loyaltyPrograms)
				.set({ currency: 'EUR' })
				.where(eq(loyaltyPrograms.id, 'default'))
		} catch (error) {
			triggerError = String((error as { cause?: unknown }).cause ?? error)
		}
		expect(triggerError).toContain('loyalty program currency is locked')
	})
})

describe('setProgramStatus', () => {
	it('activates and pauses with a new version each time', async () => {
		await saveDraftProgram(ORG)
		await expectLoyaltyError(
			setProgramStatus(ORG, {
				expectedVersion: 2,
				status: 'active',
				actorId: 'op_test',
				now: NOW,
			}),
			'stale_version',
		)
		const active = await setProgramStatus(ORG, {
			expectedVersion: 1,
			status: 'active',
			actorId: 'op_test',
			now: NOW,
		})
		expect(active).toMatchObject({
			status: 'active',
			version: 2,
			currencyLocked: true,
		})
		expect(active.current).toMatchObject({ version: 2, status: 'active' })

		// A no-op change appends nothing.
		const again = await setProgramStatus(ORG, {
			expectedVersion: 2,
			status: 'active',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(again.version).toBe(2)
		expect(again.history).toHaveLength(2)

		const paused = await setProgramStatus(ORG, {
			expectedVersion: 2,
			status: 'paused',
			actorId: 'op_test',
			now: NOW + 2000,
		})
		expect(paused).toMatchObject({ status: 'paused', version: 3 })
		expect(paused.current).toMatchObject({ version: 3, status: 'paused' })
	})

	it('fails for a missing program', async () => {
		await expectLoyaltyError(
			setProgramStatus(ORG, {
				expectedVersion: 1,
				status: 'active',
				actorId: 'op_test',
				now: NOW,
			}),
			'program_not_found',
		)
	})
})

describe('rewards', () => {
	it('needs a program first', async () => {
		await expectLoyaltyError(
			createReward(ORG, {
				definition: rewardDefinition(),
				actorId: 'op_test',
				now: NOW,
			}),
			'program_not_found',
		)
	})

	it('creates, updates and archives with optimistic versions', async () => {
		await activateProgram(ORG)
		const reward = await makeReward(ORG)
		expect(reward).toMatchObject({ status: 'active', version: 1 })

		const updated = await updateReward(ORG, {
			rewardId: reward.id,
			expectedVersion: 1,
			definition: rewardDefinition({ name: 'Ten off', pointsCost: 20 }),
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(updated).toMatchObject({ version: 2 })
		expect(updated.definition.name).toBe('Ten off')

		await expectLoyaltyError(
			updateReward(ORG, {
				rewardId: reward.id,
				expectedVersion: 1,
				definition: rewardDefinition(),
				actorId: 'op_test',
				now: NOW,
			}),
			'stale_version',
		)

		const archived = await setRewardStatus(ORG, {
			rewardId: reward.id,
			expectedVersion: 2,
			status: 'archived',
			actorId: 'op_test',
			now: NOW + 2000,
		})
		expect(archived).toMatchObject({ version: 3, status: 'archived' })

		const db = await getTenantDb(ORG)
		expect(await activeRewardsInTx(db)).toHaveLength(0)
		const listed = await listOperatorRewards(db)
		expect(listed).toHaveLength(1)
		expect(listed[0]!.status).toBe('archived')

		// Restoring works and appends yet another version.
		const restored = await setRewardStatus(ORG, {
			rewardId: reward.id,
			expectedVersion: 3,
			status: 'active',
			actorId: 'op_test',
			now: NOW + 3000,
		})
		expect(restored).toMatchObject({ version: 4, status: 'active' })

		// A missing reward reads as such.
		await expectLoyaltyError(
			updateReward(ORG, {
				rewardId: 'reward_missing',
				expectedVersion: 1,
				definition: rewardDefinition(),
				actorId: 'op_test',
				now: NOW,
			}),
			'reward_not_found',
		)
	})

	it('refuses a reward definition that does not parse', async () => {
		await activateProgram(ORG)
		await expect(
			createReward(ORG, {
				definition: rewardDefinition({ pointsCost: 0 }),
				actorId: 'op_test',
				now: NOW,
			}),
		).rejects.toThrow()
	})

	it(`caps the catalog at ${LOYALTY_MAX_REWARDS} rewards`, async () => {
		await activateProgram(ORG)
		const db = await getTenantDb(ORG)
		// Fill the catalog directly; one more create must refuse.
		for (let i = 0; i < LOYALTY_MAX_REWARDS; i++) {
			await db.insert(loyaltyRewards).values({
				id: `reward_fill_${i}`,
				status: 'active',
				version: 1,
				kind: 'order',
				name: `Reward ${i}`,
				pointsCost: 1,
				currency: 'USD',
				createdAt: NOW,
				updatedAt: NOW,
			})
		}
		const error = await expectLoyaltyError(
			createReward(ORG, {
				definition: rewardDefinition(),
				actorId: 'op_test',
				now: NOW,
			}),
			'config_invalid',
		)
		expect(error.details).toMatchObject({ reason: 'too_many_rewards' })
	})
})

describe('the public program view', () => {
	it('is empty while the feature is off or the program is a draft', async () => {
		const db = await getTenantDb(ORG)
		expect(await getPublicProgram(db, FEATURES_ON)).toBeNull()
		await saveDraftProgram(ORG)
		expect(await getPublicProgram(db, FEATURES_ON)).toBeNull()
		expect(await getPublicProgram(db, { ...LOYALTY_FEATURES_OFF })).toBeNull()
	})

	it('shows the program and active rewards, gated by the features', async () => {
		await activateProgram(ORG)
		await makeReward(ORG)
		const db = await getTenantDb(ORG)
		const program = await getPublicProgram(db, FEATURES_ON)
		expect(program).toMatchObject({
			name: 'Test Club',
			currency: 'USD',
			status: 'active',
			redemptionEnabled: true,
		})
		expect(program!.rewards).toHaveLength(1)
		expect(program!.rewards[0]).toMatchObject({
			name: 'Five off',
			pointsCost: 10,
			kind: 'order',
		})

		// Without the redemption flag customers see the program but cannot spend.
		const noRedemption = await getPublicProgram(db, {
			...FEATURES_ON,
			redemption: false,
		})
		expect(noRedemption!.redemptionEnabled).toBe(false)

		// A paused program still shows (members keep seeing their balance) but
		// cannot redeem.
		await setProgramStatus(ORG, {
			expectedVersion: 2,
			status: 'paused',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		const paused = await getPublicProgram(db, FEATURES_ON)
		expect(paused).toMatchObject({ status: 'paused', redemptionEnabled: false })

		const view = await getOperatorProgram(db)
		expect(view!.history.length).toBeGreaterThanOrEqual(2)
	})
})
