import {
	FAVORITES_LIMIT,
	favoritesRow,
	type FavoriteMenuItem,
} from '@repo/common/guest-favorites'
import {
	addFavorite,
	isSignedIn,
	listFavorites,
	removeFavorite,
} from '~/lib/guest-account-client'
import { type FavoritesLabels } from '~/lib/guest-account-labels'
import { signInAndReturn } from '~/lib/return-after-login'

/**
 * Favorite dishes on the menu (#158): a heart on every dish card and in the item
 * modal, and a "Your favorites" row above the categories (the popular row's
 * markup, filled by the browser). Favorites live in the region; the menu page is
 * rendered without them and the row is built from the cards already on the page,
 * so a dish that left the menu simply is not there and a sold-out one says so.
 */

const HEART =
	'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'

export const FAVORITES_CHANGED_EVENT = 'menuza:favorites-changed'
export const ITEM_MODAL_OPEN_EVENT = 'menuza:item-modal-open'

function heartIcon(filled: boolean) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	svg.setAttribute('viewBox', '0 0 24 24')
	svg.setAttribute('fill', filled ? 'currentColor' : 'none')
	svg.setAttribute('stroke', 'currentColor')
	svg.setAttribute('stroke-width', '2')
	svg.setAttribute('stroke-linecap', 'round')
	svg.setAttribute('stroke-linejoin', 'round')
	svg.setAttribute('aria-hidden', 'true')
	svg.setAttribute('class', 'size-5')
	svg.innerHTML = HEART
	return svg
}

/** Paints a heart button for the favorite state it is given. */
export function paintHeart(
	button: HTMLButtonElement,
	favorite: boolean,
	labels: Pick<FavoritesLabels, 'add' | 'remove'>,
) {
	button.setAttribute('aria-pressed', String(favorite))
	button.setAttribute('aria-label', favorite ? labels.remove : labels.add)
	button.title = favorite ? labels.remove : labels.add
	button.classList.toggle('text-destructive', favorite)
	button.replaceChildren(heartIcon(favorite))
}

export type FavoritesMenuOptions = {
	labels: FavoritesLabels
	/** The "Your favorites" rail (PopularRow, favorites variant). */
	rail: HTMLElement | null
	/** The heart in the item modal. */
	modalHeart: HTMLButtonElement | null
	document?: Document
}

export type FavoritesMenu = {
	/** The dish ids the signed-in guest has favorited. */
	ids(): ReadonlySet<string>
	refresh(): Promise<void>
}

type DomItem = FavoriteMenuItem & { element: HTMLElement }

function menuItemsFromDom(doc: Document): Map<string, DomItem> {
	const items = new Map<string, DomItem>()
	for (const element of doc.querySelectorAll<HTMLElement>(
		'.js-item-card[data-item-id]',
	)) {
		const id = element.dataset.itemId
		if (!id || items.has(id)) continue
		items.set(id, {
			id,
			available: element.dataset.soldOut !== 'true',
			element,
		})
	}
	return items
}

function buildCard(
	item: DomItem,
	soldOut: boolean,
	labels: FavoritesLabels,
): HTMLElement {
	const card = document.createElement('button')
	card.type = 'button'
	card.dataset.itemId = item.id
	card.setAttribute('aria-haspopup', 'dialog')
	const image = item.element.querySelector<HTMLImageElement>('img')
	card.className = [
		'js-popular-card group relative flex w-64 shrink-0 snap-start flex-col overflow-hidden text-start focus-ring disabled:cursor-default sm:w-72',
		image
			? 'surface surface-interactive'
			: 'brand-tint surface-interactive p-5',
		soldOut ? 'opacity-70' : '',
	]
		.filter(Boolean)
		.join(' ')
	if (soldOut) {
		card.disabled = true
		card.dataset.soldOut = 'true'
	}
	if (image) {
		const frame = document.createElement('span')
		frame.className =
			'relative block aspect-[4/3] overflow-hidden bg-placeholder'
		const copy = image.cloneNode(true) as HTMLImageElement
		copy.className = `size-full object-cover ${soldOut ? 'grayscale' : ''}`
		copy.removeAttribute('width')
		copy.removeAttribute('height')
		frame.append(copy)
		card.append(frame)
	}
	const body = document.createElement('span')
	body.className = `flex flex-1 flex-col ${image ? 'p-4' : ''}`
	const name = document.createElement('span')
	name.className =
		'font-heading leading-tight font-bold text-balance text-foreground line-clamp-2 text-base sm:text-lg'
	name.textContent =
		item.element.querySelector('.js-item-open')?.textContent?.trim() ??
		item.element.querySelector('h3')?.textContent?.trim() ??
		''
	const foot = document.createElement('span')
	foot.className = 'mt-auto flex items-end justify-between gap-3 pt-3'
	if (soldOut) {
		const badge = document.createElement('span')
		badge.className = 'badge tone-solid'
		badge.textContent = labels.soldOut
		foot.append(badge)
	} else {
		const price = item.element.querySelector('.js-price-block')
		if (price) foot.append(price.cloneNode(true))
	}
	body.append(name, foot)
	card.append(body)
	return card
}

export function mountMenuFavorites(
	options: FavoritesMenuOptions,
): FavoritesMenu {
	const doc = options.document ?? document
	const { labels, rail, modalHeart } = options
	let favorites: Array<{ itemId: string; createdAt: number }> = []
	const ids = new Set<string>()
	const hearts = new Map<string, HTMLButtonElement>()
	let notice: HTMLElement | null = null

	function say(text: string) {
		if (!rail) return
		if (!notice) {
			notice = doc.createElement('p')
			notice.className = 'mt-2 text-sm text-destructive'
			notice.setAttribute('role', 'alert')
			rail.querySelector('[data-favorites-notice-slot]')?.append(notice)
		}
		notice.textContent = text
	}

	function syncIds() {
		ids.clear()
		for (const favorite of favorites) ids.add(favorite.itemId)
	}

	function paintAll() {
		for (const [id, button] of hearts) paintHeart(button, ids.has(id), labels)
		if (modalHeart?.dataset.itemId) {
			paintHeart(modalHeart, ids.has(modalHeart.dataset.itemId), labels)
		}
		renderRail()
	}

	function renderRail() {
		if (!rail) return
		const list = rail.querySelector<HTMLElement>('[data-rail]')
		if (!list) return
		const row = favoritesRow(favorites, menuItemsFromDom(doc))
		list.replaceChildren(
			...row.map(({ item, soldOut }) =>
				buildCard(item as DomItem, soldOut, labels),
			),
		)
		rail.hidden = row.length === 0
		// The arrows read the rail's width: ask them to measure again.
		window.dispatchEvent(new Event('resize'))
	}

	async function toggle(itemId: string) {
		if (!isSignedIn()) {
			signInAndReturn()
			return
		}
		const wasFavorite = ids.has(itemId)
		// Optimistic: the heart answers at once, a refused change puts it back.
		if (wasFavorite) {
			favorites = favorites.filter((favorite) => favorite.itemId !== itemId)
		} else {
			favorites = [{ itemId, createdAt: Date.now() }, ...favorites]
		}
		syncIds()
		paintAll()
		const result = wasFavorite
			? await removeFavorite(itemId)
			: await addFavorite(itemId)
		if (result.ok) {
			doc.dispatchEvent(
				new CustomEvent(FAVORITES_CHANGED_EVENT, {
					detail: { itemId, favorite: !wasFavorite },
				}),
			)
			return
		}
		await refresh()
		if (result.code === 'signed_out') signInAndReturn()
		else
			say(
				result.code === 'favorites_limit_reached'
					? labels.limitReached
					: labels.failed,
			)
	}

	// A heart on every dish card. The card's name button stretches over the card
	// to open the dish, so the heart sits above it.
	for (const card of doc.querySelectorAll<HTMLElement>(
		'.js-item-card[data-item-id]',
	)) {
		const itemId = card.dataset.itemId
		if (!itemId || hearts.has(itemId)) continue
		const button = doc.createElement('button')
		button.type = 'button'
		button.dataset.favoriteToggle = itemId
		button.className =
			'icon-btn absolute end-2 top-2 z-10 size-9 border-0 bg-background/85 shadow-elev-1 backdrop-blur-sm'
		paintHeart(button, false, labels)
		button.addEventListener('click', (event) => {
			// The card opens the dish on any click: this one is only the heart.
			event.stopPropagation()
			void toggle(itemId)
		})
		card.querySelector('.js-item-open')?.classList.add('pe-10')
		card.append(button)
		hearts.set(itemId, button)
	}

	modalHeart?.addEventListener('click', () => {
		const itemId = modalHeart.dataset.itemId
		if (itemId) void toggle(itemId)
	})
	doc.addEventListener(ITEM_MODAL_OPEN_EVENT, (event) => {
		const itemId = (event as CustomEvent<{ itemId?: string }>).detail?.itemId
		if (!modalHeart || !itemId) return
		modalHeart.dataset.itemId = itemId
		modalHeart.hidden = false
		paintHeart(modalHeart, ids.has(itemId), labels)
	})

	async function refresh() {
		if (!isSignedIn()) {
			favorites = []
			syncIds()
			paintAll()
			return
		}
		const result = await listFavorites()
		if (result.ok) {
			favorites = result.data.favorites
			syncIds()
			paintAll()
		} else if (result.code === 'signed_out') {
			favorites = []
			syncIds()
			paintAll()
		}
	}

	void refresh()
	return { ids: () => ids, refresh }
}

export { FAVORITES_LIMIT }
