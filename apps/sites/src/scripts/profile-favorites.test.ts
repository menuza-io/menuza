/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/client-auth', () => ({ getAccessToken: () => 'token' }))
vi.mock('~/lib/guest-account-client', () => ({
	listFavorites: vi.fn(),
	removeFavorite: vi.fn(),
}))

import { favoriteCards } from './profile-favorites'

const catalog = [
	{
		id: 'burger',
		name: 'Burger',
		imageUrl: null,
		priceLabel: '$10',
		soldOut: false,
	},
	{
		id: 'soup',
		name: 'Soup',
		imageUrl: null,
		priceLabel: 'Sold out',
		soldOut: true,
	},
]

describe('profile favorites list (#158)', () => {
	it('lists favorites newest first, sold out ones flagged, deleted dishes dropped', () => {
		const cards = favoriteCards(
			[
				{ itemId: 'burger', createdAt: 1 },
				{ itemId: 'gone', createdAt: 9 },
				{ itemId: 'soup', createdAt: 5 },
			],
			catalog,
		)
		expect(cards.map(({ item, soldOut }) => [item.id, soldOut])).toEqual([
			['soup', true],
			['burger', false],
		])
	})
})
