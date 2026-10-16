import { invalidateUserCache } from '@repo/cache'
import type * as cacheModule from '@repo/cache'
import { db, eq, User } from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestUser } from '#tests/test-utils.ts'
import { profileUpdateAction } from './profile.actions.ts'

vi.mock('@repo/cache', async (importOriginal) => ({
	...(await importOriginal<typeof cacheModule>()),
	invalidateUserCache: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => {
	vi.mocked(invalidateUserCache).mockClear()
})

async function getName(userId: string) {
	const [row] = await db
		.select({ name: User.name })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	return row?.name
}

function profileForm(name: string, username: string) {
	const formData = new FormData()
	formData.set('name', name)
	formData.set('username', username)
	return formData
}

describe('profileUpdateAction', () => {
	// The root loader caches the user (`user:${id}`) for the sidebar user card.
	it('invalidates the cached root user after saving a new name', async () => {
		const user = await createTestUser({ name: 'Old Name' })

		const response = await profileUpdateAction({
			userId: user.id,
			formData: profileForm('New Name', user.username),
		})

		expect(response.status).toBe(200)
		expect(await getName(user.id)).toBe('New Name')
		expect(invalidateUserCache).toHaveBeenCalledWith(user.id)
	})

	it('invalidates the cached root user after clearing the name', async () => {
		const user = await createTestUser({ name: 'Old Name' })

		const response = await profileUpdateAction({
			userId: user.id,
			formData: profileForm('', user.username),
		})

		expect(response.status).toBe(200)
		expect(await getName(user.id)).toBeNull()
		expect(invalidateUserCache).toHaveBeenCalledWith(user.id)
	})

	it('leaves the cache alone when validation fails', async () => {
		const user = await createTestUser({ name: 'Old Name' })

		const response = await profileUpdateAction({
			userId: user.id,
			formData: profileForm('New Name', ''),
		})

		expect(response.status).toBe(400)
		expect(invalidateUserCache).not.toHaveBeenCalled()
	})
})
