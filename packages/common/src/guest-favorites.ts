import { z } from 'zod'

/**
 * Favorite dishes on the guest account (#158). Regional rows hold only the
 * dish id; Sites and the customer app join them with the public menu they
 * already hold, so a dish that left the menu simply disappears.
 */

/** Per customer, per organization (one regional database per organization). */
export const FAVORITES_LIMIT = 100

export const FAVORITE_ERROR_CODES = ['favorites_limit_reached'] as const
export type FavoriteErrorCode = (typeof FAVORITE_ERROR_CODES)[number]

export const favoriteItemIdSchema = z.string().trim().min(1).max(100)

export const favoriteListSchema = z.object({
	favorites: z.array(z.object({ itemId: z.string(), createdAt: z.number() })),
	limit: z.number(),
})
export type FavoriteList = z.infer<typeof favoriteListSchema>

export type FavoriteMenuItem = {
	id: string
	/** The dish can be ordered now (not sold out, not hidden by hours). */
	available: boolean
}

export type FavoriteRowItem<T> = {
	item: T
	soldOut: boolean
}

/**
 * The favorites row, newest favorite first: only dishes still on this menu
 * (a deleted or hidden one drops out), each flagged sold out when it cannot be
 * ordered right now so the card says "Sold out" instead of vanishing.
 */
export function favoritesRow<T extends FavoriteMenuItem>(
	favorites: readonly { itemId: string; createdAt: number }[],
	menuItems: ReadonlyMap<string, T> | readonly T[],
): FavoriteRowItem<T>[] {
	const byId =
		menuItems instanceof Map
			? (menuItems as ReadonlyMap<string, T>)
			: new Map((menuItems as readonly T[]).map((item) => [item.id, item]))
	return [...favorites]
		.sort((a, b) => b.createdAt - a.createdAt)
		.flatMap(({ itemId }) => {
			const item = byId.get(itemId)
			return item ? [{ item, soldOut: !item.available }] : []
		})
}
