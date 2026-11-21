import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { openWebsitePage } from '../../lib/ordering/open-site'
import { OrdersSection } from './orders-section'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'

jest.mock('../../lib/ordering/open-site', () => ({
	openWebsitePage: jest.fn(),
}))

const order = (overrides: Record<string, unknown> = {}) => ({
	id: 'ord_1',
	number: 'A12',
	status: 'completed',
	paymentStatus: 'paid',
	paymentMethod: 'online',
	fulfillment: 'pickup',
	currency: 'USD',
	totalCents: 2450,
	createdAt: '2026-01-02T10:00:00.000Z',
	location: { id: 'loc_1', name: 'Downtown' },
	itemCount: 2,
	itemNames: ['Margherita'],
	isDrop: false,
	canReorder: true,
	canFinish: false,
	...overrides,
})

async function mount(orders: unknown[], reorder?: unknown) {
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/customer/orders': { json: { orders, nextCursor: null } },
			'/customer/orders/ord_1/reorder': {
				json: reorder ?? {
					locationId: 'loc_1',
					fulfillment: 'pickup',
					lines: [
						{
							itemId: 'item_1',
							variantId: null,
							quantity: 2,
							options: [],
							instructions: 'secret note',
							name: 'Margherita',
						},
					],
				},
			},
		},
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	await waitFor(() =>
		expect(app.store.getSnapshot().profileStatus).toBe('loaded'),
	)
	renderWithStore(app.store, <OrdersSection />)
	return app
}

describe('Profile, Orders (#112)', () => {
	beforeEach(() => jest.mocked(openWebsitePage).mockClear())

	it('lists the guest’s orders with status, location and total', async () => {
		await mount([
			order(),
			order({
				id: 'ord_2',
				number: 'B7',
				status: 'cancelled',
				canReorder: true,
			}),
		])
		expect(await screen.findByText('Order A12')).toBeTruthy()
		expect(screen.getByText(/Completed · Downtown/)).toBeTruthy()
		expect(screen.getByText('Order B7')).toBeTruthy()
	})

	it('shows an empty state for a guest with no orders', async () => {
		await mount([])
		expect(await screen.findByText(/No orders yet/)).toBeTruthy()
	})

	it('order again opens the website menu with ids only in the fragment', async () => {
		await mount([order()])
		fireEvent.press(await screen.findByText('Order again'))
		await waitFor(() => expect(openWebsitePage).toHaveBeenCalledTimes(1))
		const url = jest.mocked(openWebsitePage).mock.calls[0]![0]
		expect(url).toContain('/menu')
		expect(new URL(url).hash).toContain('reorderlines=')
		expect(url).not.toContain('secret')
		expect(new URL(url).search).not.toContain('item_1')
	})

	it('offers "Finish this order" for a lapsed unpaid order and no reorder for a drop', async () => {
		await mount([
			order({ status: 'expired', paymentStatus: 'unpaid', canFinish: true }),
			order({ id: 'ord_3', number: 'D1', isDrop: true, canReorder: false }),
		])
		expect(await screen.findByText('Finish this order')).toBeTruthy()
		expect(screen.getAllByText(/Order again|Finish this order/)).toHaveLength(1)
	})
})
