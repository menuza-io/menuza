import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { fixtureJson, fixtureText } from '@/test/reservations/fixtures'
import {
	renderReservations,
	sentTo,
	startReservationsApp,
} from '@/test/reservations/screens'

const ltr = (value: string) => `\u2066${value}\u2069`

const BOOKING_ROUTES = {
	'/reservations/config': { json: fixtureJson('config') },
	'/reservations/mine': { json: fixtureJson('mine') },
	'/reservations/availability': { json: fixtureJson('availability') },
	'/reservations/holds': { json: fixtureJson('hold') },
	'/reservations/holds/release': { json: { released: true } },
	'/reservations': { json: fixtureJson('booking') },
}

function isDisabled(name: string): boolean {
	return (
		screen.getByRole('button', { name }).props.accessibilityState?.disabled ===
		true
	)
}

/** Home, "Book a table", then a time: the details form is in front. */
async function holdSevenPm(routes: Record<string, unknown> = {}) {
	const app = await startReservationsApp({ ...BOOKING_ROUTES, ...routes })
	const view = renderReservations(app)
	fireEvent.press(await screen.findByRole('button', { name: 'Book a table' }))
	fireEvent.press(await screen.findByRole('button', { name: '19:00' }))
	await screen.findByText('Your details')
	return { app, ...view }
}

describe('booking a table', () => {
	it('goes from the home screen through details and review to the confirmation', async () => {
		const { app, navigation } = await holdSevenPm()
		expect(navigation.names).toEqual(['search', 'details'])

		// The hold counts down; the form is filled from the profile.
		expect(
			screen.getByText(`We're holding your table for ${ltr('7:00')}`),
		).toBeTruthy()
		expect(
			screen.getByText(`Mon, Jun 24 \u00B7 ${ltr('19:00')} \u00B7 2 guests`),
		).toBeTruthy()
		expect(screen.getByLabelText('First name').props.value).toBe('Ada')
		expect(screen.getByLabelText('Last name').props.value).toBe('Lovelace')
		expect(screen.getByLabelText('Email (optional)').props.value).toBe(
			'ada@example.com',
		)
		expect(
			screen.getByText(
				`We'll use ${ltr('+1 555 000 1111')} from your account.`,
			),
		).toBeTruthy()
		expect(screen.getByLabelText('Dietary needs').props.placeholder).toBe(
			'Nut allergy',
		)
		// One seating area: nothing to choose.
		expect(screen.queryByText('Seating area')).toBeNull()

		fireEvent.press(screen.getByRole('radio', { name: 'Birthday' }))
		fireEvent.changeText(
			screen.getByLabelText('Special requests'),
			'Window seat',
		)
		fireEvent.press(screen.getByRole('checkbox', { name: 'Text me reminders' }))
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))

		await screen.findByText('Review your booking')
		expect(navigation.names).toEqual(['search', 'details', 'review'])
		expect(screen.getByText('Ada Lovelace')).toBeTruthy()
		expect(screen.getByText(ltr('+1 555 000 1111'))).toBeTruthy()
		expect(screen.queryByText('Amount due')).toBeNull()

		fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }))
		await screen.findByText("You're booked")
		expect(navigation.names).toEqual(['search', 'confirmed'])
		expect(screen.getByText(ltr('FIXT0001'))).toBeTruthy()
		expect(screen.getByText('Acme Downtown')).toBeTruthy()

		const [book] = sentTo(app, '/reservations')
		expect(book?.request.method).toBe('POST')
		expect(book?.body).toMatchObject({
			holdToken: 'hold_fixture_token_0001',
			guest: {
				firstName: 'Ada',
				lastName: 'Lovelace',
				phone: '+15550001111',
				email: 'ada@example.com',
			},
			occasionTagId: 'tag_pub_birthday',
			requests: 'Window seat',
			smsOptIn: true,
			locale: 'en',
		})

		const listsBefore = sentTo(app, '/reservations/mine').length
		fireEvent.press(screen.getByRole('button', { name: 'Done' }))
		await screen.findByRole('button', { name: 'Book a table' })
		expect(navigation.names).toEqual([])
		await waitFor(() => {
			expect(sentTo(app, '/reservations/mine').length).toBeGreaterThan(
				listsBefore,
			)
		})
		expect(app.reservations.getSnapshot().flow.phase.kind).toBe('idle')
	})

	it('opens the reservation from the confirmation', async () => {
		const { navigation } = await holdSevenPm({
			'/reservations/manage': { json: fixtureJson('manage') },
		})
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(
			await screen.findByRole('button', { name: 'Confirm booking' }),
		)
		fireEvent.press(
			await screen.findByRole('button', { name: 'View reservation' }),
		)
		expect(navigation.names).toEqual(['detail:rsv_fixture_0001'])
		await screen.findByText('Reservation')
		await screen.findByText(ltr('FIXT0001'))
	})

	it('edits the details from the review with the hold still running', async () => {
		const { app, navigation } = await holdSevenPm()
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(await screen.findByRole('button', { name: 'Edit details' }))
		await screen.findByText('Your details')
		expect(navigation.names).toEqual(['search', 'details'])
		expect(app.reservations.getSnapshot().flow.phase.kind).toBe('details')
		expect(app.reservations.getSnapshot().flow.hold).not.toBeNull()
	})

	it('needs a name before the review', async () => {
		await holdSevenPm()
		expect(isDisabled('Review')).toBe(false)
		fireEvent.changeText(screen.getByLabelText('First name'), ' ')
		expect(isDisabled('Review')).toBe(true)
	})

	it('releases the held table when the guest goes back home', async () => {
		const { app, navigation } = await holdSevenPm()
		fireEvent.press(screen.getByRole('button', { name: 'Back' }))
		await screen.findByText('Find a table')
		expect(navigation.names).toEqual(['search'])
		// Back on the times, the hold is kept for a quick change of mind.
		expect(sentTo(app, '/reservations/holds/release')).toHaveLength(0)
		fireEvent.press(screen.getByRole('button', { name: 'Back' }))
		await screen.findByRole('button', { name: 'Book a table' })
		await waitFor(() => {
			expect(sentTo(app, '/reservations/holds/release')).toHaveLength(1)
		})
		expect(sentTo(app, '/reservations/holds/release')[0]?.body).toMatchObject({
			holdToken: 'hold_fixture_token_0001',
		})
	})
})

describe('a booking with a deposit', () => {
	const DEPOSIT_ROUTES = {
		'/reservations/holds': { json: fixtureJson('hold-requires-payment') },
		'/reservations': { json: fixtureJson('booking-pending-payment') },
		'/reservations/manage/payment': {
			json: fixtureJson('payment-status-pending'),
		},
	}

	it('asks for consent, then opens the payment page and checks the payment', async () => {
		const { app, navigation } = await holdSevenPm(DEPOSIT_ROUTES)

		expect(
			screen.getByText(
				`A deposit of ${ltr('$100.00')} is due to confirm this booking.`,
			),
		).toBeTruthy()
		expect(
			screen.getByText('Free cancellation until 24 hours before.'),
		).toBeTruthy()
		expect(
			screen.getByText(`Late cancellation fee: ${ltr('$50.00')}`),
		).toBeTruthy()
		expect(screen.getByText(`No-show fee: ${ltr('$25.00')}`)).toBeTruthy()
		expect(screen.getByText('Deposit terms')).toBeTruthy()

		expect(isDisabled('Review')).toBe(true)
		fireEvent.press(
			screen.getByRole('checkbox', { name: 'I accept the booking terms.' }),
		)
		expect(isDisabled('Review')).toBe(false)
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))

		await screen.findByText('Review your booking')
		expect(screen.getByText('Amount due')).toBeTruthy()
		expect(screen.getByText(ltr('$100.00'))).toBeTruthy()
		fireEvent.press(screen.getByRole('button', { name: 'Continue to payment' }))

		await screen.findByText('Complete your payment')
		expect(navigation.names).toEqual(['search', 'details', 'review', 'payment'])
		expect(screen.getByText(`Amount due: ${ltr('$100.00')}`)).toBeTruthy()
		expect(
			screen.getByText(
				/^Pay within \u2066\d+:\d\d\u2069 to keep your table\.$/,
			),
		).toBeTruthy()
		expect(screen.getByText('Checking your payment…')).toBeTruthy()
		// No way back: the table is booked and only the payment is missing.
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

		const [book] = sentTo(app, '/reservations')
		expect(book?.body).toMatchObject({
			holdToken: 'hold_fixture_token_0002',
			policyAccepted: { termsVersion: expect.anything() },
		})

		fireEvent.press(screen.getByRole('button', { name: 'Pay now' }))
		expect(app.openBrowser).toHaveBeenCalledWith(
			'https://acme.menuza.test/reserve/pay#r=rsv_fixture_0001&t=rsv_p_fixture_0001',
		)
		const polls = () => sentTo(app, '/reservations/manage/payment').length
		await waitFor(() => {
			expect(polls()).toBeGreaterThan(0)
		})
		const before = polls()
		fireEvent.press(
			screen.getByRole('button', { name: "I've paid, check again" }),
		)
		await waitFor(() => {
			expect(polls()).toBe(before + 1)
		})
		expect(screen.getByText('Checking your payment…')).toBeTruthy()
		expect(app.reservations.getSnapshot().flow.paymentOutcome).toBe('pending')
	})

	it('confirms once the status poll says paid', async () => {
		const paid = {
			...fixtureJson('payment-status-pending'),
			paymentStatus: 'paid',
			reservationStatus: 'booked',
		}
		const { navigation } = await holdSevenPm({
			...DEPOSIT_ROUTES,
			'/reservations/manage/payment': { json: paid },
		})
		fireEvent.press(
			screen.getByRole('checkbox', { name: 'I accept the booking terms.' }),
		)
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(
			await screen.findByRole('button', { name: 'Continue to payment' }),
		)
		await screen.findByText("You're booked")
		expect(navigation.names).toEqual(['search', 'confirmed'])
		expect(screen.getByText(ltr('FIXT0003'))).toBeTruthy()
	})

	it('ends a payment under review with Done and no way to pay again', async () => {
		const review = {
			...fixtureJson('payment-status-pending'),
			paymentStatus: 'review',
			reservationStatus: 'pending_payment',
		}
		const { app, navigation } = await holdSevenPm({
			...DEPOSIT_ROUTES,
			'/reservations/manage/payment': { json: review },
		})
		fireEvent.press(
			screen.getByRole('checkbox', { name: 'I accept the booking terms.' }),
		)
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(
			await screen.findByRole('button', { name: 'Continue to payment' }),
		)
		await screen.findByText('Complete your payment')
		await waitFor(() => {
			expect(app.reservations.getSnapshot().flow.paymentOutcome).toBe('review')
		})
		expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull()
		expect(
			screen.queryByRole('button', { name: "I've paid, check again" }),
		).toBeNull()
		fireEvent.press(screen.getByRole('button', { name: 'Done' }))
		await screen.findByRole('button', { name: 'Book a table' })
		expect(navigation.names).toEqual([])
		expect(app.reservations.getSnapshot().flow.phase.kind).toBe('idle')
	})

	it('ends a refunded payment with Done and no way to pay again', async () => {
		const refunded = {
			...fixtureJson('payment-status-pending'),
			paymentStatus: 'refunded',
			reservationStatus: 'cancelled',
		}
		let settled = false
		const { app, navigation } = await holdSevenPm({
			...DEPOSIT_ROUTES,
			'/reservations/manage/payment': () => ({
				json: settled ? refunded : fixtureJson('payment-status-pending'),
			}),
		})
		fireEvent.press(
			screen.getByRole('checkbox', { name: 'I accept the booking terms.' }),
		)
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(
			await screen.findByRole('button', { name: 'Continue to payment' }),
		)
		await screen.findByRole('button', { name: 'Pay now' })
		settled = true
		await act(async () => {
			await app.clock.advance(5_000)
		})
		await waitFor(() => {
			expect(app.reservations.getSnapshot().flow.paymentOutcome).toBe(
				'refunded',
			)
		})
		await screen.findByRole('button', { name: 'Done' })
		expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull()
		fireEvent.press(screen.getByRole('button', { name: 'Done' }))
		await screen.findByRole('button', { name: 'Book a table' })
		expect(navigation.names).toEqual([])
	})

	it('sends the guest back to the times when the payment window closes', async () => {
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
		let closed = false
		const expired = {
			...fixtureJson('payment-status-pending'),
			paymentStatus: 'pending',
			reservationStatus: 'expired',
		}
		const { app, navigation } = await holdSevenPm({
			...DEPOSIT_ROUTES,
			'/reservations/manage/payment': () => ({
				json: closed ? expired : fixtureJson('payment-status-pending'),
			}),
		})
		fireEvent.press(
			screen.getByRole('checkbox', { name: 'I accept the booking terms.' }),
		)
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(
			await screen.findByRole('button', { name: 'Continue to payment' }),
		)
		await screen.findByText('Complete your payment')
		await waitFor(() => {
			expect(
				sentTo(app, '/reservations/manage/payment').length,
			).toBeGreaterThan(0)
		})

		// The next poll hears that the server let the unpaid booking go.
		closed = true
		await act(async () => {
			await app.clock.advance(5_000)
		})
		await screen.findByText('Find a table')
		expect(navigation.names).toEqual(['search'])
		expect(alert).toHaveBeenCalledWith(
			'The payment window ended and the table was released.',
			undefined,
			[{ text: 'OK' }],
		)
		alert.mockRestore()
	})
})

describe('when the table goes', () => {
	it('returns to the times with a notice when the hold runs out', async () => {
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
		const { app, navigation } = await holdSevenPm()
		await act(async () => {
			app.clock.jump(7 * 60_000)
			await app.clock.advance(1_000)
		})
		await screen.findByText('Find a table')
		expect(navigation.names).toEqual(['search'])
		expect(alert).toHaveBeenCalledWith(
			'Your hold ran out. Pick a time again.',
			undefined,
			[{ text: 'OK' }],
		)
		alert.mockRestore()
	})

	it('shows the countdown as urgent in the last minute', async () => {
		const { app } = await holdSevenPm()
		await act(async () => {
			app.clock.jump(6 * 60_000 + 10_000)
			await app.clock.advance(1_000)
		})
		const banner = await screen.findByText(
			`We're holding your table for ${ltr('0:49')}`,
		)
		expect(banner.props.className).toContain('text-destructive')
	})

	it('offers other times when the chosen one was just taken at booking', async () => {
		const { navigation } = await holdSevenPm({
			'/reservations': {
				status: 409,
				raw: fixtureText('error-slot-unavailable'),
			},
			'/reservations/availability': [
				{ json: fixtureJson('availability') },
				{ json: fixtureJson('availability-preferred-taken') },
			],
		})
		fireEvent.press(screen.getByRole('button', { name: 'Review' }))
		fireEvent.press(
			await screen.findByRole('button', { name: 'Confirm booking' }),
		)
		await screen.findByText('That time was just taken. Pick another.')
		expect(navigation.names).toEqual(['search'])
		expect(screen.getByText('Try one of these times instead')).toBeTruthy()
		expect(
			screen.getAllByRole('button', { name: '19:30' }).length,
		).toBeGreaterThan(0)
		expect(screen.queryByRole('button', { name: '19:00' })).toBeNull()
	})

	it('offers other times when the hold itself fails', async () => {
		const app = await startReservationsApp({
			...BOOKING_ROUTES,
			'/reservations/holds': {
				status: 409,
				raw: fixtureText('error-slot-unavailable'),
			},
		})
		const { navigation } = renderReservations(app)
		fireEvent.press(await screen.findByRole('button', { name: 'Book a table' }))
		fireEvent.press(await screen.findByRole('button', { name: '19:00' }))
		await screen.findByText('That time was just taken. Pick another.')
		expect(navigation.names).toEqual(['search'])
		expect(screen.getByText('Other days with tables')).toBeTruthy()
	})
})

describe('a large party', () => {
	it('sends a request for a preferred time', async () => {
		const largeParty = {
			...fixtureJson('availability'),
			status: 'large_party',
			partySize: 5,
			slots: [],
		}
		const app = await startReservationsApp({
			...BOOKING_ROUTES,
			'/reservations/availability': (request) =>
				new URL(request.url).searchParams.get('partySize') === '5'
					? { json: largeParty }
					: { json: fixtureJson('availability') },
			'/reservations/requests': { json: fixtureJson('request') },
		})
		const { navigation } = renderReservations(app)
		fireEvent.press(await screen.findByRole('button', { name: 'Book a table' }))
		await screen.findByRole('button', { name: '19:00' })
		for (let step = 0; step < 3; step += 1) {
			fireEvent.press(screen.getByRole('button', { name: 'More guests' }))
			await waitFor(() => {
				expect(app.reservations.getSnapshot().isBusy).toBe(false)
			})
		}
		await screen.findByText(
			'Larger groups send a request, and the restaurant confirms it.',
		)
		expect(
			screen.getByRole('radio', { name: '19:00' }).props.accessibilityState,
		).toMatchObject({
			checked: true,
		})
		fireEvent.press(screen.getByRole('radio', { name: '18:30' }))
		fireEvent.press(screen.getByRole('button', { name: 'Send a request' }))

		await screen.findByText('Your details')
		expect(navigation.names).toEqual(['search', 'details'])
		expect(screen.queryByText(/^We're holding your table/)).toBeNull()
		fireEvent.press(screen.getByRole('button', { name: 'Send a request' }))

		await screen.findByText('Request sent')
		expect(
			screen.getByText('The restaurant will confirm your request soon.'),
		).toBeTruthy()
		expect(navigation.names).toEqual(['search', 'confirmed'])
		const [sent] = sentTo(app, '/reservations/requests')
		expect(sent?.body).toMatchObject({
			locationId: 'loc_pub_main',
			slot: { localMin: 1110, partySize: 5 },
			guest: { firstName: 'Ada', phone: '+15550001111' },
		})
	})
})
