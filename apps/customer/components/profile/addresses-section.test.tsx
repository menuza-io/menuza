import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { Alert, type AlertButton } from 'react-native'
import { AddressesSection } from './addresses-section'
import { type HttpRequest } from '@/lib/api/http'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'

const address = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	label: id === 'a1' ? 'Home' : 'Work',
	formatted: `${id} Main St, Chicago`,
	line1: `${id} Main St`,
	unit: null,
	city: 'Chicago',
	state: 'IL',
	postalCode: '60601',
	country: 'US',
	notes: null,
	isDefault: id === 'a1',
	createdAt: id === 'a1' ? 2 : 1,
	...over,
})

type Calls = Array<{ method: string; path: string; body: unknown }>

async function mount(initial: unknown[], extra: Record<string, unknown> = {}) {
	const calls: Calls = []
	let list = initial
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/customer/addresses': (request: HttpRequest) => {
				calls.push({
					method: request.method,
					path: new URL(request.url).pathname,
					body: request.body ? JSON.parse(request.body) : null,
				})
				if (request.method === 'POST') {
					list = [...list, address('a3', { label: 'New', isDefault: false })]
					return { status: 201, json: { address: list[list.length - 1] } }
				}
				return { json: { addresses: list, limit: 10 } }
			},
			'/customer/addresses/a2': (request: HttpRequest) => {
				calls.push({
					method: request.method,
					path: new URL(request.url).pathname,
					body: request.body ? JSON.parse(request.body) : null,
				})
				if (request.method === 'DELETE') {
					list = list.filter((entry) => (entry as { id: string }).id !== 'a2')
					return { json: { ok: true } }
				}
				return { json: { address: address('a2', { isDefault: true }) } }
			},
			'/delivery/locations': {
				json: {
					status: 'ok',
					locations: [{ locationId: 'loc_1', quote: { token: 'dq1.a.b' } }],
				},
			},
			...extra,
		} as never,
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	await waitFor(() =>
		expect(app.store.getSnapshot().profileStatus).toBe('loaded'),
	)
	renderWithStore(app.store, <AddressesSection />)
	return { app, calls }
}

describe('Profile, Addresses (#113)', () => {
	it('lists the saved addresses, the default marked', async () => {
		await mount([address('a1'), address('a2')])
		expect(await screen.findByText('Home')).toBeTruthy()
		expect(screen.getByText('Work')).toBeTruthy()
		expect(screen.getByText('Default')).toBeTruthy()
		expect(screen.getByText('a1 Main St, Chicago')).toBeTruthy()
	})

	it('shows an empty state', async () => {
		await mount([])
		expect(await screen.findByText(/No saved addresses yet/)).toBeTruthy()
	})

	it('makes an address the default and removes one', async () => {
		const { calls } = await mount([address('a1'), address('a2')])
		await screen.findByText('Work')
		fireEvent.press(screen.getByText('Make default'))
		await waitFor(() =>
			expect(calls).toContainEqual({
				method: 'PATCH',
				path: '/customer/addresses/a2',
				body: { isDefault: true },
			}),
		)
	})

	it('removes an address, but only after the guest confirms', async () => {
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
		const { calls } = await mount([address('a1'), address('a2')])
		await screen.findByText('Work')
		fireEvent.press(screen.getAllByText('Remove')[1]!)
		expect(alert).toHaveBeenCalledTimes(1)
		expect(alert.mock.calls[0]![0]).toBe('Remove this address?')
		// Nothing is deleted until the destructive button is pressed.
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
		const buttons = alert.mock.calls[0]![2] as AlertButton[]
		buttons.find((button) => button.style === 'destructive')!.onPress!()
		await waitFor(() =>
			expect(calls).toContainEqual({
				method: 'DELETE',
				path: '/customer/addresses/a2',
				body: null,
			}),
		)
		await waitFor(() => expect(screen.queryByText('Work')).toBeNull())
	})

	it('adds an address only after a store delivers there, saving the signed quote', async () => {
		const { calls } = await mount([address('a1')])
		await screen.findByText('Home')
		fireEvent.press(screen.getByText('Add an address'))
		fireEvent.changeText(
			screen.getByLabelText('Street address'),
			'233 S Wacker Dr',
		)
		fireEvent.changeText(screen.getByLabelText('Name this address'), 'New')
		fireEvent.press(screen.getByText('Save address'))
		await waitFor(() =>
			expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
				locationId: 'loc_1',
				quoteToken: 'dq1.a.b',
				label: 'New',
			}),
		)
		expect(await screen.findByText('New')).toBeTruthy()
	})

	it('does not save an address no store delivers to', async () => {
		const { calls } = await mount([address('a1')], {
			'/delivery/locations': {
				json: {
					status: 'ok',
					locations: [{ locationId: 'loc_1', quote: null }],
				},
			},
		})
		await screen.findByText('Home')
		fireEvent.press(screen.getByText('Add an address'))
		fireEvent.changeText(
			screen.getByLabelText('Street address'),
			'1 Far Away Rd',
		)
		fireEvent.changeText(screen.getByLabelText('Name this address'), 'Far')
		fireEvent.press(screen.getByText('Save address'))
		expect(
			await screen.findByText(/We don't deliver to this address yet/),
		).toBeTruthy()
		expect(calls.some((call) => call.method === 'POST')).toBe(false)
	})
})
