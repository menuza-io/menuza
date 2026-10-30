import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { fixtureJson } from '@/test/reservations/fixtures'
import {
	renderReservations,
	sentTo,
	settle,
	startReservationsApp,
} from '@/test/reservations/screens'

const ltr = (value: string) => `\u2066${value}\u2069`

const HOME_ROUTES = {
	'/reservations/config': { json: fixtureJson('config') },
	'/reservations/mine': { json: fixtureJson('mine') },
	'/reservations/availability': { json: fixtureJson('availability') },
}

describe('ReservationsHomeScreen', () => {
	it('lists the upcoming reservations and opens one', async () => {
		const app = await startReservationsApp({
			...HOME_ROUTES,
			'/reservations/manage': { json: fixtureJson('manage') },
		})
		const { navigation } = renderReservations(app)
		const row = await screen.findByRole('button', {
			name: `Acme Downtown, Mon, Jun 24 \u00B7 ${ltr('19:00')} \u00B7 2 guests, Booked`,
		})
		expect(screen.getByText('My reservations')).toBeTruthy()
		expect(screen.queryByText('Past')).toBeNull()
		fireEvent.press(row)
		expect(navigation.names).toEqual(['detail:rsv_fixture_0001'])
		await screen.findByText(ltr('FIXT0001'))
		await settle()
	})

	it('says when there is nothing upcoming, and shows only the last five past bookings', async () => {
		const mine = fixtureJson('mine')
		const entry = mine.upcoming[0]!
		const past = Array.from({ length: 7 }, (_, index) => ({
			...entry,
			id: `rsv_past_${index}`,
			status: 'finished',
		}))
		const app = await startReservationsApp({
			...HOME_ROUTES,
			'/reservations/mine': { json: { ...mine, upcoming: [], past } },
		})
		renderReservations(app)
		await screen.findByText('Past')
		expect(screen.getByText('No upcoming reservations.')).toBeTruthy()
		expect(screen.getAllByText('Finished')).toHaveLength(5)
	})

	it('goes straight to the times with a single location', async () => {
		const app = await startReservationsApp(HOME_ROUTES)
		const { navigation } = renderReservations(app)
		fireEvent.press(await screen.findByRole('button', { name: 'Book a table' }))
		expect(navigation.names).toEqual(['search'])
		await screen.findByRole('button', { name: '19:00' })
		expect(
			sentTo(app, '/reservations/availability')[0]?.url.searchParams.get(
				'partySize',
			),
		).toBe('2')
	})

	it('asks for the location first when there are several', async () => {
		const config = fixtureJson('config')
		const second = {
			...config.locations[0]!,
			id: 'loc_pub_uptown',
			name: 'Acme Uptown',
			address: { formattedAddress: '200 High St, New York', city: 'New York' },
		}
		const app = await startReservationsApp({
			...HOME_ROUTES,
			'/reservations/config': {
				json: { ...config, locations: [...config.locations, second] },
			},
		})
		const { navigation } = renderReservations(app)
		fireEvent.press(await screen.findByRole('button', { name: 'Book a table' }))
		expect(navigation.names).toEqual(['location'])
		await screen.findByText('Choose a location')
		fireEvent.press(
			screen.getByRole('button', {
				name: 'Acme Uptown, 200 High St, New York',
			}),
		)
		expect(navigation.names).toEqual(['search'])
		await screen.findByRole('button', { name: '19:00' })
		expect(
			sentTo(app, '/reservations/availability')[0]?.url.searchParams.get(
				'locationId',
			),
		).toBe('loc_pub_uptown')
	})

	it('opens the waitlist', async () => {
		const app = await startReservationsApp(HOME_ROUTES)
		const { navigation } = renderReservations(app)
		fireEvent.press(
			await screen.findByRole('button', { name: 'Join the waitlist' }),
		)
		expect(navigation.names).toEqual(['waitlist'])
		await screen.findByText('Waitlist')
	})

	it('explains when online booking is off', async () => {
		const app = await startReservationsApp({
			...HOME_ROUTES,
			'/reservations/config': { status: 404, json: { error: 'not_found' } },
		})
		renderReservations(app)
		await screen.findByText("Online reservations aren't available right now.")
		expect(screen.queryByRole('button', { name: 'Book a table' })).toBeNull()
	})

	it('retries a configuration that failed to load', async () => {
		const app = await startReservationsApp({
			...HOME_ROUTES,
			'/reservations/config': [
				{ status: 500, json: { error: 'internal' } },
				{ json: fixtureJson('config') },
			],
		})
		renderReservations(app)
		await screen.findByText('Something went wrong. Please try again.')
		fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
		await screen.findByRole('button', { name: 'Book a table' })
		await waitFor(() => {
			expect(sentTo(app, '/reservations/config')).toHaveLength(2)
		})
	})
})
