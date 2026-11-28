import { favoritesRow } from '@repo/common/guest-favorites'
import { getAccessToken } from '~/lib/client-auth'
import { listFavorites, removeFavorite } from '~/lib/guest-account-client'
import { type FavoritesLabels } from '~/lib/guest-account-labels'
import { browserLocaleHref } from '~/lib/locale'
import { paintHeart } from '~/lib/ordering/favorites-ui'

/**
 * Profile, Favorites (#158): every dish the guest favorited that is still on
 * the menu, with Sold out where it is, newest first. The menu comes with the
 * page (public data); the favorites come from the region with the customer
 * token. Removing one asks the region and drops the card.
 */

export type FavoriteCatalogEntry = {
	id: string
	name: string
	imageUrl: string | null
	priceLabel: string
	soldOut: boolean
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = '',
	text?: string,
) {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

/** The dishes to list: only what is still on the menu, sold out ones flagged. */
export function favoriteCards(
	favorites: readonly { itemId: string; createdAt: number }[],
	catalog: readonly FavoriteCatalogEntry[],
) {
	return favoritesRow(
		favorites,
		catalog.map((entry) => ({ ...entry, available: !entry.soldOut })),
	)
}

export function mountFavoritesPage(
	root: HTMLElement,
	labels: FavoritesLabels,
	catalog: FavoriteCatalogEntry[],
	menuHref: string,
) {
	async function load() {
		if (!getAccessToken()) {
			root.replaceChildren()
			const link = el('a', 'underline', labels.signInLink)
			link.href = browserLocaleHref('/login')
			const wrap = el('div', 'flex flex-col gap-2 text-sm')
			wrap.append(el('p', '', labels.signIn), link)
			root.append(wrap)
			return
		}
		const result = await listFavorites()
		if (!result.ok) {
			if (result.code === 'signed_out') return void load()
			root.replaceChildren()
			const retry = el('button', 'btn-secondary', labels.retry)
			retry.type = 'button'
			retry.addEventListener('click', () => void load())
			root.append(el('p', 'text-sm text-destructive', labels.loadError), retry)
			return
		}
		render(result.data.favorites)
	}

	function render(favorites: Array<{ itemId: string; createdAt: number }>) {
		root.replaceChildren()
		const cards = favoriteCards(favorites, catalog)
		if (cards.length === 0) {
			const empty = el(
				'div',
				'rounded-xl border border-border bg-card p-6 text-center',
			)
			empty.append(
				el('p', 'text-sm font-medium text-foreground', labels.empty),
				el('p', 'mt-1 text-xs text-muted-foreground', labels.emptyHint),
			)
			const link = el('a', 'btn-cta mt-4 inline-flex', labels.browseMenu)
			link.href = menuHref
			empty.append(link)
			root.append(empty)
			return
		}
		const list = el('ul', 'grid gap-3 sm:grid-cols-2')
		for (const { item, soldOut } of cards) {
			const entry = item as FavoriteCatalogEntry
			const row = el(
				'li',
				`relative flex gap-3 rounded-xl border border-border bg-card p-3 ${soldOut ? 'opacity-70' : ''}`,
			)
			row.dataset.itemId = entry.id
			if (entry.imageUrl) {
				const image = el(
					'img',
					`size-16 shrink-0 rounded-lg object-cover ${soldOut ? 'grayscale' : ''}`,
				)
				image.src = entry.imageUrl
				image.alt = ''
				image.loading = 'lazy'
				row.append(image)
			}
			const body = el('div', 'min-w-0 flex-1')
			const link = el(
				'a',
				'block text-sm font-semibold text-foreground hover:underline',
				entry.name,
			)
			link.href = `${menuHref}${menuHref.includes('?') ? '&' : '?'}item=${encodeURIComponent(entry.id)}`
			body.append(link)
			body.append(
				soldOut
					? el('span', 'badge tone-solid mt-1', labels.soldOut)
					: el(
							'span',
							'price mt-1 block text-sm text-muted-foreground',
							entry.priceLabel,
						),
			)
			row.append(body)
			const heart = el('button', 'icon-btn size-9 shrink-0 border-0')
			heart.type = 'button'
			paintHeart(heart, true, labels)
			heart.addEventListener('click', async () => {
				heart.disabled = true
				const removed = await removeFavorite(entry.id)
				if (removed.ok) await load()
				else heart.disabled = false
			})
			row.append(heart)
			list.append(row)
		}
		root.append(list)
	}

	void load()
}

const root = document.getElementById('favorites-root')
if (root?.dataset.labels) {
	mountFavoritesPage(
		root,
		JSON.parse(root.dataset.labels) as FavoritesLabels,
		JSON.parse(root.dataset.catalog ?? '[]') as FavoriteCatalogEntry[],
		root.dataset.menuHref ?? '/menu',
	)
}
