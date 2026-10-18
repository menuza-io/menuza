import { and, ConfigFlag, db, eq } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	PLATFORM_FEE_FLAG_KEY,
	parsePlatformFeeBp,
	resolveReservationPlatformFeeBp,
} from './platform-fee.server.ts'

describe('parsePlatformFeeBp', () => {
	it('accepts integers 0..10000 as numbers or numeric strings', () => {
		expect(parsePlatformFeeBp(0)).toBe(0)
		expect(parsePlatformFeeBp(250)).toBe(250)
		expect(parsePlatformFeeBp(10000)).toBe(10000)
		expect(parsePlatformFeeBp('250')).toBe(250)
	})

	it('rejects fractions, out of range and non-numeric values', () => {
		for (const bad of [
			12.5,
			-1,
			10001,
			'abc',
			'12.5',
			'',
			null,
			undefined,
			true,
			{},
			NaN,
		]) {
			expect(parsePlatformFeeBp(bad)).toBeNull()
		}
	})
})

async function setFlag(
	level: 'system' | 'organization',
	value: unknown,
	organizationId?: string,
) {
	await db.insert(ConfigFlag).values({
		key: PLATFORM_FEE_FLAG_KEY,
		value: value as never,
		level,
		organizationId: organizationId ?? null,
	})
}

describe('resolveReservationPlatformFeeBp', () => {
	let orgId: string

	beforeEach(async () => {
		await db.delete(ConfigFlag).where(eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY))
		const user = await createTestUser()
		orgId = (await createTestOrganization(user.id)).id
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await db
			.delete(ConfigFlag)
			.where(and(eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY)))
	})

	it('returns 0 when nothing is set', async () => {
		expect(await resolveReservationPlatformFeeBp(orgId)).toBe(0)
	})

	it('uses the system value when there is no override', async () => {
		await setFlag('system', 250)
		expect(await resolveReservationPlatformFeeBp(orgId)).toBe(250)
	})

	it('organization beats system', async () => {
		await setFlag('system', 250)
		await setFlag('organization', 100, orgId)
		expect(await resolveReservationPlatformFeeBp(orgId)).toBe(100)
	})

	it('an organization override of 0 is honored', async () => {
		await setFlag('system', 250)
		await setFlag('organization', 0, orgId)
		expect(await resolveReservationPlatformFeeBp(orgId)).toBe(0)
	})

	it('invalid organization value falls back to system and warns without the value', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		await setFlag('system', 250)
		await setFlag('organization', 12.5, orgId)
		expect(await resolveReservationPlatformFeeBp(orgId)).toBe(250)
		expect(warn).toHaveBeenCalledTimes(1)
		const message = String(warn.mock.calls[0]?.[0])
		expect(message).toContain(PLATFORM_FEE_FLAG_KEY)
		expect(message).not.toContain('12.5')
		expect(message).not.toContain(orgId)
	})

	it('invalid system value falls back to 0', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await setFlag('system', 10001)
		expect(await resolveReservationPlatformFeeBp(orgId)).toBe(0)
	})
})
