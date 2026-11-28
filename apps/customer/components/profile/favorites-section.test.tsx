import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { FavoritesSection } from './favorites-section'
import { type HttpRequest } from '@/lib/api/http'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'

const menuPayload = {
	organization: { currency: 'USD' },
	menus: [
		{
			id: 'menu_1',
			displayName: 'All day',
			categories: [
				{
					id: 'cat_1',
					displayName: 'Mains',
					items: [
						{
							id: 'item_1',
							displayName: 'Burger',
							price: 10,
							availabilityStatus: 'available',
						},
						{
							id: 'item_2',
							displayName: 'Soup',
							price: 6,
							availabilityStatus: 'unavailable',
						},
					],
				},
			],
		},
	],
	promotions: [],
}

async function mount(favorites: unknown[]) {
	const calls: Array<{ method: string; path: string }> = []
	let list = favorites
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/customer/favorites': { json: { favorites: list, limit: 100 } },
			'/customer/favorites/item_1': (request: HttpRequest) => {
				calls.push({
					method: request.method,
					path: new URL(request.url).pathname,
				})
				return { json: { ok: true } }
			},
		} as never,
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	await waitFor(() =>
		expect(app.store.getSnapshot().profileStatus).toBe('loaded'),
	)
	renderWithStore(
		app.store,
		<FavoritesSection loadMenu={async () => menuPayload} />,
	)
	return {
		app,
		calls,
		setList: (next: unknown[]) => void (list = next),
	}
}

describe('Profile, Favorites (#158)', () => {
	it('lists favorites that are on the menu, sold out ones marked, deleted dishes gone', async () => {
		await mount([
			{ itemId: 'item_1', createdAt: 1 },
			{ itemId: 'item_2', createdAt: 2 },
			{ itemId: 'deleted', createdAt: 3 },
		])
		expect(await screen.findByText('Burger')).toBeTruthy()
		expect(screen.getByText('Soup')).toBeTruthy()
		expect(screen.getByText('Sold out')).toBeTruthy()
		expect(screen.queryByText('deleted')).toBeNull()
	})

	it('does not show the previous guest’s favorites after signing out', async () => {
		const { app } = await mount([{ itemId: 'item_1', createdAt: 1 }])
		await screen.findByText('Burger')
		await act(async () => {
			await app.store.signOut()
		})
		expect(screen.queryByText('Burger')).toBeNull()
	})

	it('shows an empty state and removes a favorite with the region', async () => {
		const { calls } = await mount([{ itemId: 'item_1', createdAt: 1 }])
		await screen.findByText('Burger')
		fireEvent.press(screen.getByText('Remove'))
		await waitFor(() =>
			expect(calls).toContainEqual({
				method: 'DELETE',
				path: '/customer/favorites/item_1',
			}),
		)
		await waitFor(() => expect(screen.queryByText('Burger')).toBeNull())
		expect(await screen.findByText(/No favorites yet/)).toBeTruthy()
	})
})
