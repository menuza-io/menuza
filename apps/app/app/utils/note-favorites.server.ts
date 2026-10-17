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
	await Promise.all(
		[...new Set(userIds)].map((userId) => invalidateUserFavoritesCache(userId)),
	)
}

export async function invalidateNoteFavoritesCaches(noteId: string) {
	await invalidateFavoritesCaches(await getNoteFavoriteUserIds(noteId))
}
