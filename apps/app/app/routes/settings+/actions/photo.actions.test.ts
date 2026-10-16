import { invalidateUserCache } from '@repo/cache'
import type * as cacheModule from '@repo/cache'
import { db, eq, UserImage } from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestUser } from '#tests/test-utils.ts'
import { photoAction } from './photo.actions.ts'

vi.mock('@repo/cache', async (importOriginal) => ({
	...(await importOriginal<typeof cacheModule>()),
	invalidateUserCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#app/utils/storage.server.ts', () => ({
	uploadProfileImage: vi.fn().mockResolvedValue('users/test/profile.png'),
}))

afterEach(() => {
	vi.mocked(invalidateUserCache).mockClear()
})

async function getObjectKey(userId: string) {
	const [row] = await db
		.select({ objectKey: UserImage.objectKey })
		.from(UserImage)
		.where(eq(UserImage.userId, userId))
		.limit(1)
	return row?.objectKey
}

function callPhotoAction(userId: string, formData: FormData) {
	return photoAction({
		request: new Request('http://localhost/settings/general'),
		formData,
		userId,
	})
}

// The root loader caches the image (`user:${id}`) for the sidebar avatar.
describe('photoAction', () => {
	it('invalidates the cached root user after uploading a photo', async () => {
		const user = await createTestUser()
		const formData = new FormData()
		formData.set('intent', 'upload-photo')
		formData.set(
			'photoFile',
			new File(['image'], 'profile.png', { type: 'image/png' }),
		)

		const response = await callPhotoAction(user.id, formData)

		expect(response.status).toBe(200)
		expect(await getObjectKey(user.id)).toBe('users/test/profile.png')
		expect(invalidateUserCache).toHaveBeenCalledWith(user.id)
	})

	it('invalidates the cached root user after deleting the photo', async () => {
		const user = await createTestUser()
		await db
			.insert(UserImage)
			.values({ userId: user.id, objectKey: 'users/test/old.png' })
		const formData = new FormData()
		formData.set('intent', 'delete-photo')

		const response = await callPhotoAction(user.id, formData)

		expect(response.status).toBe(200)
		expect(await getObjectKey(user.id)).toBeUndefined()
		expect(invalidateUserCache).toHaveBeenCalledWith(user.id)
	})
})
