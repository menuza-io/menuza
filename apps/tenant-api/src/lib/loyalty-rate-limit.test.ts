import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	provisionTenantDb,
	getTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	enforceLoyaltyLimit,
	LOYALTY_RATE_LIMITS,
	purgeLoyaltyRateCounters,
} from './loyalty-rate-limit.ts'
import { expectLoyaltyError } from '../services/loyalty-test-fixture.ts'

const ORG = 'org_ll_rate'

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-rate-'))
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

// NOW sits exactly on a ten-minute window boundary.
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0)

describe('enforceLoyaltyLimit', () => {
	it('counts the attempt first, then refuses past the maximum', async () => {
		const db = await getTenantDb(ORG)
		const { max, windowMs } = LOYALTY_RATE_LIMITS.otpSend
		for (let attempt = 1; attempt <= max; attempt++) {
			await enforceLoyaltyLimit(db, 'otpSend', 'approval_1', NOW)
		}
		await expectLoyaltyError(
			enforceLoyaltyLimit(db, 'otpSend', 'approval_1', NOW),
			'rate_limited',
			{ retryAfterSeconds: windowMs / 1000 },
		)
		// A refusal counts too: the next one is refused as well.
		await expectLoyaltyError(
			enforceLoyaltyLimit(db, 'otpSend', 'approval_1', NOW),
			'rate_limited',
		)
	})

	it('reports the seconds left in the window', async () => {
		const db = await getTenantDb(ORG)
		const { max, windowMs } = LOYALTY_RATE_LIMITS.otpSend
		const late = NOW + 61_000
		for (let attempt = 1; attempt <= max; attempt++) {
			await enforceLoyaltyLimit(db, 'otpSend', 'approval_2', late)
		}
		await expectLoyaltyError(
			enforceLoyaltyLimit(db, 'otpSend', 'approval_2', late),
			'rate_limited',
			{ retryAfterSeconds: (windowMs - 61_000) / 1000 },
		)
	})

	it('subjects and buckets do not share a counter', async () => {
		const db = await getTenantDb(ORG)
		const { max } = LOYALTY_RATE_LIMITS.otpSend
		for (let attempt = 1; attempt <= max; attempt++) {
			await enforceLoyaltyLimit(db, 'otpSend', 'approval_3', NOW)
			await enforceLoyaltyLimit(db, 'otpSendMember', 'approval_3', NOW)
		}
		// Same bucket, another subject: fine.
		await enforceLoyaltyLimit(db, 'otpSend', 'approval_other', NOW)
		// Same subject, another bucket: fine (otpSendMember allows six).
		await enforceLoyaltyLimit(db, 'otpSendMember', 'approval_3', NOW)
		await expectLoyaltyError(
			enforceLoyaltyLimit(db, 'otpSend', 'approval_3', NOW),
			'rate_limited',
		)
	})

	it('a new window starts the count over', async () => {
		const db = await getTenantDb(ORG)
		const { max, windowMs } = LOYALTY_RATE_LIMITS.otpSend
		for (let attempt = 1; attempt <= max; attempt++) {
			await enforceLoyaltyLimit(db, 'otpSend', 'approval_4', NOW)
		}
		await expectLoyaltyError(
			enforceLoyaltyLimit(db, 'otpSend', 'approval_4', NOW),
			'rate_limited',
		)
		await enforceLoyaltyLimit(db, 'otpSend', 'approval_4', NOW + windowMs)
	})
})

describe('purgeLoyaltyRateCounters', () => {
	it('drops windows that can no longer matter', async () => {
		const db = await getTenantDb(ORG)
		const { windowMs } = LOYALTY_RATE_LIMITS.otpSend // the longest window
		await enforceLoyaltyLimit(db, 'otpSend', 'old', NOW - 3 * windowMs)
		await enforceLoyaltyLimit(db, 'otpSend', 'fresh', NOW)
		await purgeLoyaltyRateCounters(db, NOW)
		// The old window is gone: 'old' counts from zero again.
		for (
			let attempt = 1;
			attempt <= LOYALTY_RATE_LIMITS.otpSend.max;
			attempt++
		) {
			await enforceLoyaltyLimit(db, 'otpSend', 'old', NOW - 3 * windowMs)
		}
		// The fresh window survived.
		for (
			let attempt = 1;
			attempt < LOYALTY_RATE_LIMITS.otpSend.max;
			attempt++
		) {
			await enforceLoyaltyLimit(db, 'otpSend', 'fresh', NOW)
		}
		await expectLoyaltyError(
			enforceLoyaltyLimit(db, 'otpSend', 'fresh', NOW),
			'rate_limited',
		)
	})
})
