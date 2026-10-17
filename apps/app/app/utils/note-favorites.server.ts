import { invalidateUserFavoritesCache } from '@repo/cache'
import { db, eq, OrganizationNoteFavorite } from '@repo/database'

/**
 * The root loader caches each user's sidebar favorites (with note titles) under
 * `user-favorites:<userId>`. Note mutations that change that list must clear it
 * for every user who starred the note, or the sidebar stays stale.
 */
export async function getNoteFavoriteUserIds(noteId: string) {
	const favorites = await db
		.select({ userId: OrganizationNoteFavorite.userId })
		.from(OrganizationNoteFavorite)
		.where(eq(OrganizationNoteFavorite.noteId, noteId))
	return favorites.map((favorite) => favorite.userId)
}

export async function invalidateFavoritesCaches(userIds: string[]) {
	const results = await Promise.allSettled(
		[...new Set(userIds)].map((userId) => invalidateUserFavoritesCache(userId)),
	)
	if (results.some((result) => result.status === 'rejected')) {
		console.error('Failed to invalidate note favorites cache')
	}
}

export async function invalidateNoteFavoritesCaches(noteId: string) {
	try {
		await invalidateFavoritesCaches(await getNoteFavoriteUserIds(noteId))
	} catch {
		console.error('Failed to look up note favorites for cache invalidation')
	}
}
