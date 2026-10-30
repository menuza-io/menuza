import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { Alert, type AlertButton } from 'react-native'
import { detailRoute } from './navigation'
import { fixtureJson } from '@/test/reservations/fixtures'
import {
	renderReservations,
	sentTo,
	settle,
	startReservationsApp,
} from '@/test/reservations/screens'
import { header } from '@/test/stub-transport'

const ltr = (value: string) => `\u2066${value}\u2069`
const ID = 'rsv_fixture_0001'
const TOKEN = 'manage-token-1'

const MANAGE_ROUTES = {
	'/reservations/config': { json: fixtureJson('config') },
	'/reservations/mine': { json: fixtureJson('mine') },
	'/reservations/manage': { json: fixtureJson('manage') },
}

async function openDetail(
	routes: Record<string, unknown> = {},
	withToken = true,
) {
	const app = await startReservationsApp(
		{ ...MANAGE_ROUTES, ...routes },
		withToken ? { tokens: { manage: { [ID]: TOKEN }, waitlist: {} } } : {},
	)
	const view = renderReservations(app, [detailRoute(ID)])
	await screen.findByText(ltr('FIXT0001'))
	await settle()
	return { app, ...view }
}

describe('ReservationDetailScreen', () => {
	it('shows the booking with its change deadline', async () => {
		const { app } = await openDetail()
		expect(screen.getByText('Reservation')).toBeTruthy()
		expect(screen.getByText('Acme Downtown')).toBeTruthy()
		expect(screen.getByText('Booked')).toBeTruthy()
		expect(screen.getByText(`Mon, Jun 24 \u00B7 ${ltr('19:00')}`)).toBeTruthy()
		expect(screen.getByText('2 guests')).toBeTruthy()
		expect(screen.getByText('100 Main St, New York')).toBeTruthy()
		expect(
			screen.getByText(`Free to change until ${ltr('5:00 PM')}`),
		).toBeTruthy()
		expect(
			header(sentTo(app, '/reservations/manage')[0], 'X-Reservation-Token'),
		).toBe(TOKEN)
	})

	it('recovers the manage token through the list after a reinstall', async () => {
		const { app } = await openDetail({}, false)
		const token = fixtureJson('mine').upcoming[0]!.manageToken
		expect(
			header(sentTo(app, '/reservations/manage')[0], 'X-Reservation-Token'),
		).toBe(token)
	})

	it('tells the restaurant the guest is running late', async () => {
		const { app } = await openDetail({
			'/reservations/manage/running-late': { json: fixtureJson('manage') },
		})
		expect(screen.getByText('Running late')).toBeTruthy()
		for (const label of ['5 min', '10 min', '15 min', '30 min']) {
			expect(screen.getByRole('button', { name: label })).toBeTruthy()
		}
		fireEvent.press(screen.getByRole('button', { name: '15 min' }))
		await screen.findByText('We told the restaurant.')
		expect(
			sentTo(app, '/reservations/manage/running-late')[0]?.body,
		).toMatchObject({ minutes: 15 })
	})

	it('calls the restaurant', async () => {
		const { app } = await openDetail()
		fireEvent.press(screen.getByRole('button', { name: 'Call the restaurant' }))
		await waitFor(() => {
			expect(app.openUrl).toHaveBeenCalledWith('tel:+12125550100')
		})
	})

	it('cancels after a confirmation, or keeps the booking', async () => {
		const cancelled = {
			...fixtureJson('manage'),
			status: 'cancelled',
			canCancel: false,
			canModify: false,
		}
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
		const { app } = await openDetail({
			'/reservations/manage/cancel': { json: cancelled },
		})

		fireEvent.press(screen.getByRole('button', { name: 'Cancel reservation' }))
		expect(alert).toHaveBeenCalledTimes(1)
		const [title, , buttons] = alert.mock.calls[0]!
		expect(title).toBe('Cancel this reservation?')
		const [keep, cancel] = buttons as AlertButton[]
		expect(keep).toMatchObject({ text: 'Keep it', style: 'cancel' })
		expect(cancel).toMatchObject({
			text: 'Cancel reservation',
			style: 'destructive',
		})
		expect(sentTo(app, '/reservations/manage/cancel')).toHaveLength(0)

		const listsBefore = sentTo(app, '/reservations/mine').length
		act(() => {
			cancel!.onPress?.()
		})
		await screen.findByText('Cancelled')
		expect(sentTo(app, '/reservations/manage/cancel')).toHaveLength(1)
		expect(
			screen.queryByRole('button', { name: 'Cancel reservation' }),
		).toBeNull()
		expect(screen.queryByRole('button', { name: 'Change time' })).toBeNull()
		expect(screen.queryByText(/^Free to change until/)).toBeNull()
		await waitFor(() => {
			expect(sentTo(app, '/reservations/mine').length).toBeGreaterThan(
				listsBefore,
			)
		})
		await settle()
		alert.mockRestore()
	})

	it('moves the booking to another time', async () => {
		const moved = {
			...fixtureJson('manage'),
			reservation: {
				...fixtureJson('manage').reservation,
				localMin: 1200,
				time: '20:00',
			},
		}
		const { app } = await openDetail({
			'/reservations/manage/availability': {
				json: fixtureJson('availability'),
			},
			'/reservations/manage/modify': { json: moved },
		})
		fireEvent.press(screen.getByRole('button', { name: 'Change time' }))
		const chip = await screen.findByRole('button', { name: '20:00' })
		const request = sentTo(app, '/reservations/manage/availability')[0]
		expect(request?.url.searchParams.get('date')).toBe('2030-06-24')
		expect(request?.url.searchParams.get('partySize')).toBe('2')
		expect(
			screen.getByRole('radio', { name: 'Mon, Jun 24' }).props
				.accessibilityState,
		).toMatchObject({
			checked: true,
		})

		fireEvent.press(screen.getByRole('button', { name: 'More guests' }))
		await waitFor(() => {
			expect(sentTo(app, '/reservations/manage/availability')).toHaveLength(2)
		})
		expect(
			sentTo(app, '/reservations/manage/availability')[1]?.url.searchParams.get(
				'partySize',
			),
		).toBe('3')

		fireEvent.press(chip)
		await screen.findByText(`Mon, Jun 24 \u00B7 ${ltr('20:00')}`)
		expect(sentTo(app, '/reservations/manage/modify')[0]?.body).toMatchObject({
			date: '2030-06-24',
			localMin: 1200,
			partySize: 3,
		})
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'OK' })).toBeNull()
		})
		await settle()
	})

	it('says when the booking cannot be found', async () => {
		const app = await startReservationsApp(
			{
				...MANAGE_ROUTES,
				'/reservations/manage': { status: 404, json: { error: 'not_found' } },
			},
			{ tokens: { manage: { [ID]: TOKEN }, waitlist: {} } },
		)
		renderReservations(app, [detailRoute(ID)])
		await screen.findByText("We couldn't find that.")
		await settle()
	})

	it('follows the payment of a booking still waiting for it, until it is paid', async () => {
		const manage = fixtureJson('manage')
		const unpaid = {
			...manage,
			status: 'pending_payment',
			reservation: { ...manage.reservation, status: 'pending_payment' },
		}
		let paid = false
		const { app } = await openDetail({
			'/reservations/manage': () => ({ json: paid ? manage : unpaid }),
			'/reservations/manage/payment': () => ({
				json: {
					...fixtureJson('payment-status-pending'),
					...(paid
						? { paymentStatus: 'paid', reservationStatus: 'booked' }
						: {}),
				},
			}),
		})
		expect(screen.getByText('Awaiting payment')).toBeTruthy()
		expect(screen.getByText('Checking your payment…')).toBeTruthy()
		await waitFor(() => {
			expect(sentTo(app, '/reservations/manage/payment')).toHaveLength(1)
		})
		expect(
			header(
				sentTo(app, '/reservations/manage/payment')[0],
				'X-Reservation-Token',
			),
		).toBe(TOKEN)
		expect((await app.tokens.load()).payment).toBe(ID)

		paid = true
		await act(async () => {
			await app.clock.advance(60_000)
		})
		await screen.findByText('Booked')
		expect(screen.queryByText('Checking your payment…')).toBeNull()
		expect(app.reservations.getSnapshot().pendingPayment).toMatchObject({
			reservationId: ID,
			outcome: 'paid',
			isPolling: false,
		})
		expect((await app.tokens.load()).payment).toBeUndefined()
		await settle()
	})
})
