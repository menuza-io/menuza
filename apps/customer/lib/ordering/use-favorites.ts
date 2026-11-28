import {
	favoritesRow,
	type FavoriteMenuItem,
} from '@repo/common/guest-favorites'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/api-error'
import { CustomerAccountClient } from '../api/customer-account'
import { useAppSnapshot } from '../app/use-app'
import { type MenuSectionView } from './catalog'

export type FavoriteOutcome = 'ok' | 'limit' | 'failed'

/**
 * The signed-in guest's favorite dishes (#158): the dish ids from the region, a
 * toggle that answers at once and puts the heart back when the region refuses,
 * and the row of favorites that are still on the menu.
 */
export function useFavorites() {
	const { session, isSignedIn } = useAppSnapshot()
	const client = useMemo(
		() => (session && isSignedIn ? new CustomerAccountClient(session) : null),
		[session, isSignedIn],
	)
	const [favorites, setFavorites] = useState<
		Array<{ itemId: string; createdAt: number }>
	>([])
	const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
		'loading',
	)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	const refresh = useCallback(async () => {
		if (!client) return
		try {
			const list = await client.listFavorites()
			if (!mounted.current) return
			setFavorites(list.favorites)
			setStatus('ready')
		} catch {
			if (mounted.current) setStatus('failed')
		}
	}, [client])
	useEffect(() => {
		void refresh()
	}, [refresh])

	const ids = useMemo(
		() => new Set(favorites.map((favorite) => favorite.itemId)),
		[favorites],
	)

	const toggle = useCallback(
		async (itemId: string): Promise<FavoriteOutcome> => {
			if (!client) return 'failed'
			const wasFavorite = ids.has(itemId)
			setFavorites((current) =>
				wasFavorite
					? current.filter((favorite) => favorite.itemId !== itemId)
					: [{ itemId, createdAt: Date.now() }, ...current],
			)
			try {
				if (wasFavorite) await client.removeFavorite(itemId)
				else await client.addFavorite(itemId)
				return 'ok'
			} catch (error) {
				await refresh()
				return error instanceof ApiError &&
					error.code === 'favorites_limit_reached'
					? 'limit'
					: 'failed'
			}
		},
		[client, ids, refresh],
	)

	return { favorites, ids, status, toggle, refresh, signedIn: client !== null }
}

/** The favorites that are still on the menu, newest first; sold out ones flagged. */
export function favoriteMenuItems(
	sections: readonly MenuSectionView[],
	favorites: readonly { itemId: string; createdAt: number }[],
) {
	const byId = new Map<
		string,
		FavoriteMenuItem & MenuSectionView['items'][number]
	>()
	for (const section of sections) {
		for (const item of section.items) {
			if (!byId.has(item.id))
				byId.set(item.id, { ...item, available: !item.soldOut })
		}
	}
	return favoritesRow(favorites, byId)
}
