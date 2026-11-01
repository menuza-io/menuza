import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { type ReactElement } from 'react'
import { DropsScreen } from './drops-screen'
import { MenuScreen } from './menu-screen'
import { i18n } from '@/lib/i18n/lingui'
import { makeApp, ORGANIZATION, renderWithStore } from '@/test/app-harness'

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
							description: 'With cheese',
							price: 10,
							availabilityStatus: 'available',
						},
					],
				},
			],
		},
	],
	promotions: [
		{
			id: 'disc_1',
			name: 'Ten off',
			valueType: 'percent',
			percentBp: 1000,
			scope: 'order',
			itemIds: [],
			categoryIds: [],
		},
	],
}

const dropsPayload = {
	drops: [
		{
			title: 'Friday lunch',
			slug: 'friday-lunch',
			description: 'A short menu',
			status: 'live',
			ordersOpenAt: '2020-01-01T00:00:00.000Z',
			ordersCloseAt: '2099-01-01T00:00:00.000Z',
			pickupDates: ['2026-11-06'],
			pickupLocationNames: ['Main'],
			pickupTimezone: 'UTC',
		},
	],
}

async function renderOrdering(element: ReactElement) {
	const app = makeApp({ '/resources/sites': { json: ORGANIZATION } })
	await app.store.start()
	await waitFor(() => {
		expect(app.store.getSnapshot().organization?.slug).toBe('acme')
	})
	renderWithStore(app.store, element)
}

describe('MenuScreen', () => {
	afterEach(() => {
		i18n.activate('en')
	})

	it('lists the menu and opens the website menu and checkout', async () => {
		const openPage = jest.fn()
		await renderOrdering(
			<MenuScreen loadMenu={async () => menuPayload} openPage={openPage} />,
		)
		expect(await screen.findByText('Burger')).toBeTruthy()
		expect(screen.getAllByText('10% off').length).toBeGreaterThan(0)
		fireEvent.press(screen.getByRole('link', { name: 'Checkout' }))
		fireEvent.press(screen.getByRole('link', { name: 'Order on the menu' }))
		// The row is read out with its price, offer and description, and says
		// that it opens the website.
		const row = screen.getByRole('link', {
			name: /^Burger, .*10.*, 10% off, With cheese$/,
		})
		expect(row.props.accessibilityHint).toBe('Opens the website')
		fireEvent.press(row)
		expect(openPage).toHaveBeenNthCalledWith(
			1,
			'https://acme.epic-startup.com/menu/checkout',
		)
		expect(openPage).toHaveBeenNthCalledWith(
			2,
			'https://acme.epic-startup.com/menu',
		)
		expect(openPage).toHaveBeenNthCalledWith(
			3,
			'https://acme.epic-startup.com/menu',
		)
	})
})

describe('MenuScreen offers', () => {
	afterEach(() => {
		i18n.activate('en')
	})

	const item = (id: string, name: string) => ({
		id,
		displayName: name,
		price: 10,
		availabilityStatus: 'available',
	})
	const offer = (id: string, overrides: Record<string, unknown>) => ({
		id,
		name: `Offer ${id}`,
		valueType: 'percent',
		percentBp: 2000,
		scope: 'items',
		itemIds: ['item_1'],
		categoryIds: [],
		...overrides,
	})
	const payload = (promotions: unknown[]) => ({
		organization: { currency: 'USD' },
		locations: [
			{
				id: 'loc_1',
				isDefault: true,
				timezone: 'UTC',
				fulfillmentOptions: { pickup: true, delivery: false },
			},
		],
		menus: [
			{
				id: 'menu_1',
				displayName: 'Lunch',
				categories: [
					{
						id: 'cat_1',
						displayName: 'Burgers',
						items: [item('item_1', 'Burger'), item('item_2', 'Fries')],
					},
				],
			},
		],
		promotions,
	})

	it('shows was and now prices only when one plain offer covers the item', async () => {
		await renderOrdering(
			<MenuScreen
				loadMenu={async () => payload([offer('1', { itemPrice: true })])}
			/>,
		)
		expect(await screen.findByText('$8.00')).toBeTruthy()
		// The struck regular price, and Fries (not covered) at the regular price.
		expect(screen.getAllByText('$10.00')).toHaveLength(2)
	})

	it('keeps the regular price when two offers cover the item', async () => {
		await renderOrdering(
			<MenuScreen
				loadMenu={async () =>
					payload([
						offer('1', { itemPrice: true }),
						offer('2', { itemPrice: true, percentBp: 1000 }),
					])
				}
			/>,
		)
		await screen.findAllByText('20% off')
		expect(screen.queryByText('$8.00')).toBeNull()
	})

	it('shows a capped percentage by its name, never as a plain percentage', async () => {
		await renderOrdering(
			<MenuScreen
				loadMenu={async () =>
					payload([offer('1', { name: '20% off up to $5', showName: true })])
				}
			/>,
		)
		expect(await screen.findAllByText('20% off up to $5')).toHaveLength(2)
		expect(screen.queryByText('20% off')).toBeNull()
	})

	it('shows a set price and the code of a promoted code offer', async () => {
		await renderOrdering(
			<MenuScreen
				loadMenu={async () =>
					payload([
						offer('1', {
							name: 'Burger special',
							valueType: 'fixed_price',
							percentBp: null,
							amountMinor: 799,
							currency: 'USD',
							code: 'LUNCH',
						}),
					])
				}
			/>,
		)
		expect(await screen.findAllByText('Set price $7.99')).toHaveLength(2)
		expect(screen.getByText('Use code LUNCH')).toBeTruthy()
	})

	it('hides offers for another location, order type or time, and skips badges when told', async () => {
		await renderOrdering(
			<MenuScreen
				loadMenu={async () =>
					payload([
						offer('elsewhere', { locationIds: ['loc_2'] }),
						offer('delivery-only', { fulfillments: ['delivery'] }),
						offer('expired', { endsAt: '2020-01-01T00:00' }),
						offer('later', { startsAt: '2999-01-01T00:00' }),
						offer('no-badge', { itemBadges: false }),
					])
				}
			/>,
		)
		expect(await screen.findByText('Offer no-badge')).toBeTruthy()
		expect(screen.queryByText('Offer elsewhere')).toBeNull()
		expect(screen.queryByText('Offer delivery-only')).toBeNull()
		expect(screen.queryByText('Offer expired')).toBeNull()
		expect(screen.queryByText('Offer later')).toBeNull()
		// Only the banner shows it: the item rows carry no badge.
		expect(screen.getAllByText('20% off')).toHaveLength(1)
	})

	it('puts at most two offers on an item', async () => {
		await renderOrdering(
			<MenuScreen
				loadMenu={async () =>
					payload([
						offer('1', { percentBp: 1000 }),
						offer('2', { percentBp: 2000 }),
						offer('3', { percentBp: 3000 }),
					])
				}
			/>,
		)
		expect(await screen.findByText('Burger')).toBeTruthy()
		expect(screen.getAllByText('10% off')).toHaveLength(2)
		expect(screen.getAllByText('20% off')).toHaveLength(2)
		// The third offer is in the banner only.
		expect(screen.getAllByText('30% off')).toHaveLength(1)
	})
})

describe('DropsScreen', () => {
	afterEach(() => {
		i18n.activate('en')
	})

	it('opens a drop and the website checkout', async () => {
		const openPage = jest.fn()
		await renderOrdering(
			<DropsScreen
				loadDrops={async () => dropsPayload}
				openPage={openPage}
				now={() => new Date('2026-10-30T12:00:00.000Z')}
			/>,
		)
		expect(await screen.findByText('Friday lunch')).toBeTruthy()
		const drop = screen.getByRole('link', {
			name: /^Friday lunch, Ordering now, .*Main$/,
		})
		expect(drop.props.accessibilityHint).toBe('Opens the website')
		fireEvent.press(drop)
		fireEvent.press(screen.getByRole('link', { name: 'Checkout' }))
		expect(openPage).toHaveBeenNthCalledWith(
			1,
			'https://acme.epic-startup.com/drop/friday-lunch',
		)
		expect(openPage).toHaveBeenNthCalledWith(
			2,
			'https://acme.epic-startup.com/menu/checkout',
		)
	})
})
