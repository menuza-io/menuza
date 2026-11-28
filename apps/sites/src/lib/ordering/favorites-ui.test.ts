/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isSignedIn = vi.fn()
const listFavorites = vi.fn()
const addFavorite = vi.fn()
const removeFavorite = vi.fn()
const signInAndReturn = vi.fn()

vi.mock('~/lib/guest-account-client', () => ({
	isSignedIn: () => isSignedIn(),
	listFavorites: () => listFavorites(),
	addFavorite: (id: string) => addFavorite(id),
	removeFavorite: (id: string) => removeFavorite(id),
}))
vi.mock('~/lib/return-after-login', () => ({
	signInAndReturn: () => signInAndReturn(),
}))

import { ITEM_MODAL_OPEN_EVENT, mountMenuFavorites } from './favorites-ui'

const labels = {
	title: 'Favorites',
	description: '',
	row: 'Your favorites',
	add: 'Add to favorites',
	remove: 'Remove from favorites',
	signInToSave: '',
	soldOut: 'Sold out',
	empty: '',
	emptyHint: '',
	browseMenu: '',
	limitReached: 'You have 100 favorites.',
	failed: 'failed',
	loadError: '',
	retry: '',
	signIn: '',
	signInLink: '',
	previous: '',
	next: '',
}

function page() {
	document.body.innerHTML = `
		<section data-popular-rail data-favorites-rail hidden>
			<div data-rail></div><div data-favorites-notice-slot></div>
		</section>
		<ul>
			<li class="js-item-card" data-item-id="burger" data-sold-out="false">
				<h3><button class="js-item-open">Burger</button></h3>
				<span class="js-price-block"><span class="js-price-now">$10.00</span></span>
				<img src="https://cdn.test/burger.jpg" alt="" />
			</li>
			<li class="js-item-card" data-item-id="soup" data-sold-out="true">
				<h3><button class="js-item-open">Soup</button></h3>
				<span class="badge">Sold out</span>
			</li>
			<li class="js-item-card" data-item-id="pizza" data-sold-out="false">
				<h3><button class="js-item-open">Pizza</button></h3>
				<span class="js-price-block"><span class="js-price-now">$12.00</span></span>
			</li>
		</ul>
		<button id="modal-favorite-btn" hidden></button>`
	return {
		rail: document.querySelector<HTMLElement>('[data-favorites-rail]')!,
		modalHeart: document.getElementById(
			'modal-favorite-btn',
		) as HTMLButtonElement,
	}
}

const heart = (id: string) =>
	document.querySelector<HTMLButtonElement>(`[data-favorite-toggle="${id}"]`)!
const railIds = () =>
	[
		...document.querySelectorAll<HTMLElement>('[data-rail] .js-popular-card'),
	].map((card) => card.dataset.itemId)

beforeEach(() => {
	isSignedIn.mockReset()
	listFavorites.mockReset()
	addFavorite.mockReset()
	removeFavorite.mockReset()
	signInAndReturn.mockReset()
})

describe('favorite dishes on the menu (#158)', () => {
	it('puts a heart on every dish card', () => {
		isSignedIn.mockReturnValue(false)
		const { rail, modalHeart } = page()
		mountMenuFavorites({ labels, rail, modalHeart })
		expect(document.querySelectorAll('[data-favorite-toggle]')).toHaveLength(3)
		expect(heart('burger').getAttribute('aria-pressed')).toBe('false')
		expect(heart('burger').getAttribute('aria-label')).toBe('Add to favorites')
	})

	it('shows a favorited dish in the row on the next visit, sold out ones marked, deleted ones gone', async () => {
		isSignedIn.mockReturnValue(true)
		listFavorites.mockResolvedValue({
			ok: true,
			data: {
				limit: 100,
				favorites: [
					{ itemId: 'burger', createdAt: 1 },
					{ itemId: 'soup', createdAt: 3 },
					{ itemId: 'deleted_dish', createdAt: 2 },
				],
			},
		})
		const { rail, modalHeart } = page()
		mountMenuFavorites({ labels, rail, modalHeart })
		await vi.waitFor(() => expect(rail.hidden).toBe(false))
		// Newest first, the deleted dish never appears.
		expect(railIds()).toEqual(['soup', 'burger'])
		const soup = document.querySelector<HTMLButtonElement>(
			'[data-rail] [data-item-id="soup"]',
		)!
		expect(soup.disabled).toBe(true)
		expect(soup.textContent).toContain('Sold out')
		const burger = document.querySelector(
			'[data-rail] [data-item-id="burger"]',
		)!
		expect(burger.textContent).toContain('Burger')
		expect(burger.textContent).toContain('$10.00')
		expect(burger.querySelector('img')?.getAttribute('src')).toBe(
			'https://cdn.test/burger.jpg',
		)
		expect(heart('burger').getAttribute('aria-pressed')).toBe('true')
		expect(heart('pizza').getAttribute('aria-pressed')).toBe('false')
	})

	it('hides the row while there is nothing to show', async () => {
		isSignedIn.mockReturnValue(true)
		listFavorites.mockResolvedValue({
			ok: true,
			data: { favorites: [], limit: 100 },
		})
		const { rail, modalHeart } = page()
		mountMenuFavorites({ labels, rail, modalHeart })
		await vi.waitFor(() => expect(listFavorites).toHaveBeenCalled())
		expect(rail.hidden).toBe(true)
	})

	it('favorites a dish with one tap, without opening the dish, and adds it to the row', async () => {
		isSignedIn.mockReturnValue(true)
		listFavorites.mockResolvedValue({
			ok: true,
			data: { favorites: [], limit: 100 },
		})
		addFavorite.mockResolvedValue({ ok: true, data: { ok: true } })
		const { rail, modalHeart } = page()
		const opened = vi.fn()
		document.querySelector('.js-item-card')!.addEventListener('click', opened)
		mountMenuFavorites({ labels, rail, modalHeart })
		await vi.waitFor(() => expect(listFavorites).toHaveBeenCalled())
		const click = new MouseEvent('click', { bubbles: true })
		heart('pizza').dispatchEvent(click)
		await vi.waitFor(() => expect(addFavorite).toHaveBeenCalledWith('pizza'))
		expect(heart('pizza').getAttribute('aria-pressed')).toBe('true')
		expect(railIds()).toEqual(['pizza'])
		expect(opened).not.toHaveBeenCalled()
		// And back off again.
		removeFavorite.mockResolvedValue({ ok: true, data: { ok: true } })
		heart('pizza').click()
		await vi.waitFor(() => expect(removeFavorite).toHaveBeenCalledWith('pizza'))
		expect(railIds()).toEqual([])
	})

	it('asks a signed-out guest to sign in instead of saving', async () => {
		isSignedIn.mockReturnValue(false)
		const { rail, modalHeart } = page()
		mountMenuFavorites({ labels, rail, modalHeart })
		heart('burger').click()
		expect(signInAndReturn).toHaveBeenCalledTimes(1)
		expect(addFavorite).not.toHaveBeenCalled()
		expect(heart('burger').getAttribute('aria-pressed')).toBe('false')
	})

	it('puts the heart back and says why when the region refuses', async () => {
		isSignedIn.mockReturnValue(true)
		listFavorites.mockResolvedValue({
			ok: true,
			data: { favorites: [], limit: 100 },
		})
		addFavorite.mockResolvedValue({
			ok: false,
			status: 409,
			code: 'favorites_limit_reached',
			session: 'ok',
		})
		const { rail, modalHeart } = page()
		mountMenuFavorites({ labels, rail, modalHeart })
		await vi.waitFor(() => expect(listFavorites).toHaveBeenCalled())
		heart('burger').click()
		await vi.waitFor(() =>
			expect(rail.textContent).toContain('You have 100 favorites.'),
		)
		expect(heart('burger').getAttribute('aria-pressed')).toBe('false')
	})

	it('keeps the heart in the item modal in step with the open dish', async () => {
		isSignedIn.mockReturnValue(true)
		listFavorites.mockResolvedValue({
			ok: true,
			data: { favorites: [{ itemId: 'burger', createdAt: 1 }], limit: 100 },
		})
		addFavorite.mockResolvedValue({ ok: true, data: { ok: true } })
		const { rail, modalHeart } = page()
		mountMenuFavorites({ labels, rail, modalHeart })
		await vi.waitFor(() => expect(rail.hidden).toBe(false))
		expect(modalHeart.hidden).toBe(true)
		document.dispatchEvent(
			new CustomEvent(ITEM_MODAL_OPEN_EVENT, { detail: { itemId: 'burger' } }),
		)
		expect(modalHeart.hidden).toBe(false)
		expect(modalHeart.getAttribute('aria-pressed')).toBe('true')
		document.dispatchEvent(
			new CustomEvent(ITEM_MODAL_OPEN_EVENT, { detail: { itemId: 'pizza' } }),
		)
		expect(modalHeart.getAttribute('aria-pressed')).toBe('false')
		modalHeart.click()
		await vi.waitFor(() => expect(addFavorite).toHaveBeenCalledWith('pizza'))
		expect(heart('pizza').getAttribute('aria-pressed')).toBe('true')
	})
})
