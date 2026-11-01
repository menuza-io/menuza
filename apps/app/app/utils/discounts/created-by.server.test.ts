import { db, eq, User } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { createTestUser } from '#tests/test-utils.ts'
import { getDiscountCreatedBy } from './discounts.server.ts'

describe('getDiscountCreatedBy', () => {
	it('returns the creator display name', async () => {
		const user = await createTestUser({ name: 'Ada Lovelace' })
		await expect(getDiscountCreatedBy(user.id)).resolves.toEqual({
			name: 'Ada Lovelace',
		})
	})

	it('falls back to username when name is empty', async () => {
		const user = await createTestUser({ username: 'ada_ops' })
		await db.update(User).set({ name: null }).where(eq(User.id, user.id))
		await expect(getDiscountCreatedBy(user.id)).resolves.toEqual({
			name: 'ada_ops',
		})
	})

	it('returns null when the id is missing or unknown', async () => {
		await expect(getDiscountCreatedBy(null)).resolves.toBeNull()
		await expect(getDiscountCreatedBy('missing-user')).resolves.toBeNull()
	})
})
