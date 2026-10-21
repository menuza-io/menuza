import { invalidateUserFavoritesCache } from '@repo/cache'
import type * as cacheModule from '@repo/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockDb, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import {
	invalidateFavoritesCaches,
	invalidateNoteFavoritesCaches,
} from './note-favorites.server.ts'

vi.mock('@repo/cache', async (importOriginal) => ({
	...(await importOriginal<typeof cacheModule>()),
	invalidateUserFavoritesCache: vi.fn(),
}))

vi.mock('@repo/database', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: (await import('#tests/setup/drizzle-mock.ts')).mockDb,
}))

beforeEach(() => {
	resetMockDb()
	vi.mocked(invalidateUserFavoritesCache).mockReset()
})

describe('note favorites cache cleanup', () => {
	it('attempts every distinct user even when one invalidation fails', async () => {
		consoleError.mockImplementation(() => {})
		vi.mocked(invalidateUserFavoritesCache)
			.mockRejectedValueOnce(new Error('Cache unavailable'))
			.mockResolvedValueOnce(undefined)

		await expect(
			invalidateFavoritesCaches(['first-user', 'second-user', 'first-user']),
		).resolves.toBeUndefined()

		expect(invalidateUserFavoritesCache).toHaveBeenCalledTimes(2)
		expect(invalidateUserFavoritesCache).toHaveBeenCalledWith('first-user')
		expect(invalidateUserFavoritesCache).toHaveBeenCalledWith('second-user')
		expect(consoleError).toHaveBeenCalledWith(
			'Failed to invalidate note favorites cache',
		)
	})

	it('contains a failed post-save favorites lookup', async () => {
		consoleError.mockImplementation(() => {})
		mockDb.select.mockImplementationOnce(() => {
			throw new Error('Database unavailable')
		})

		await expect(
			invalidateNoteFavoritesCaches('note-1'),
		).resolves.toBeUndefined()
		expect(consoleError).toHaveBeenCalledWith(
			'Failed to look up note favorites for cache invalidation',
		)
	})
})
