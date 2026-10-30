import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { fixtureJson } from '@/test/reservations/fixtures'
import {
	renderReservations,
	sentTo,
	startReservationsApp,
} from '@/test/reservations/screens'

const ltr = (value: string) => `\u2066${value}\u2069`

const WAITLIST_ROUTES = {
	'/reservations/config': { json: fixtureJson('config') },
	'/reservations/mine': { json: fixtureJson('mine') },
	'/reservations/waitlist/join': { json: fixtureJson('waitlist-join') },
	'/reservations/waitlist/status': { json: fixtureJson('waitlist-status') },
}

async function openWaitlist(routes: Record<string, unknown> = {}) {
	const app = await startReservationsApp({ ...WAITLIST_ROUTES, ...routes })
	const view = renderReservations(app)
	fireEvent.press(
		await screen.findByRole('button', { name: 'Join the waitlist' }),
	)
	await screen.findByText('Waitlist')
	return { app, ...view }
}

async function join() {
	fireEvent.press(screen.getByRole('button', { name: 'Join' }))
	await screen.findByText("You're number 1 in line")
}

describe('ReservationWaitlistScreen', () => {
	it('joins with the profile name and the verified phone, then shows the place in line', async () => {
		const { app } = await openWaitlist()
		expect(screen.getByLabelText('Name').props.value).toBe('Ada Lovelace')
		expect(
			screen.getByText(
				`We'll use ${ltr('+1 555 000 1111')} from your account.`,
			),
		).toBeTruthy()
		expect(screen.getByText('Acme Downtown')).toBeTruthy()
		fireEvent.press(screen.getByRole('button', { name: 'More guests' }))
		fireEvent.press(screen.getByRole('checkbox', { name: 'Text me reminders' }))
		await join()

		expect(screen.getByText('About 1 min')).toBeTruthy()
		expect(screen.getByRole('button', { name: "I'm on my way" })).toBeTruthy()
		expect(sentTo(app, '/reservations/waitlist/join')[0]?.body).toMatchObject({
			locationId: 'loc_pub_main',
			name: 'Ada Lovelace',
			partySize: 3,
			phone: '+15550001111',
			smsOptIn: true,
			locale: 'en',
		})
	})

	it('needs a name to join', async () => {
		await openWaitlist()
		fireEvent.changeText(screen.getByLabelText('Name'), '  ')
		expect(
			screen.getByRole('button', { name: 'Join' }).props.accessibilityState,
		).toMatchObject({ disabled: true })
	})

	it('refreshes the place in line while open, and stops once the guest leaves the screen', async () => {
		let ready = false
		const { app } = await openWaitlist({
			'/reservations/waitlist/status': () => ({
				json: ready
					? {
							...fixtureJson('waitlist-status'),
							status: 'notified',
							position: null,
						}
					: fixtureJson('waitlist-status'),
			}),
		})
		await join()
		ready = true
		const polls = () => sentTo(app, '/reservations/waitlist/status').length
		const before = polls()
		await act(async () => {
			await app.clock.advance(10_000)
		})
		await screen.findByText('Your table is ready')
		expect(polls()).toBeGreaterThan(before)

		fireEvent.press(screen.getByRole('button', { name: 'Back' }))
		await screen.findByRole('button', { name: 'Book a table' })
		const afterLeaving = polls()
		await act(async () => {
			await app.clock.advance(30_000)
		})
		expect(polls()).toBe(afterLeaving)
	})

	it('tells the restaurant the guest is on the way, then leaves the waitlist', async () => {
		const left = {
			...fixtureJson('waitlist-status'),
			status: 'left',
			canLeave: false,
			canOnMyWay: false,
		}
		const { app } = await openWaitlist({
			'/reservations/waitlist/status/on-my-way': {
				json: fixtureJson('waitlist-status'),
			},
			'/reservations/waitlist/status/leave': { json: left },
		})
		await join()
		fireEvent.press(screen.getByRole('button', { name: "I'm on my way" }))
		await waitFor(() => {
			expect(
				sentTo(app, '/reservations/waitlist/status/on-my-way'),
			).toHaveLength(1)
		})
		await waitFor(() => {
			expect(app.reservations.getSnapshot().isBusy).toBe(false)
		})
		fireEvent.press(screen.getByRole('button', { name: 'Leave the waitlist' }))
		await screen.findByText('You left the waitlist.')
		fireEvent.press(screen.getByRole('button', { name: 'Done' }))
		await screen.findByRole('button', { name: 'Join' })
	})

	it('keeps the place in line when a refresh fails, and clears the notice once one answers', async () => {
		let failing = false
		const { app } = await openWaitlist({
			'/reservations/waitlist/status': () =>
				failing
					? { status: 503, json: { error: 'unavailable' } }
					: { json: fixtureJson('waitlist-status') },
		})
		await join()

		failing = true
		await act(async () => {
			await app.clock.advance(10_000)
		})
		await screen.findByText(
			"We couldn't update your place in line. We'll keep trying.",
		)
		expect(screen.getByText("You're number 1 in line")).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Join' })).toBeNull()
		expect(screen.getByRole('button', { name: 'Leave the waitlist' })).toBeTruthy()

		failing = false
		await act(async () => {
			await app.clock.advance(20_000)
		})
		await waitFor(() => {
			expect(
				screen.queryByText(
					"We couldn't update your place in line. We'll keep trying.",
				),
			).toBeNull()
		})
		expect(screen.getByText("You're number 1 in line")).toBeTruthy()
	})

	it('explains a status link that no longer works', async () => {
		await openWaitlist({
			'/reservations/waitlist/status': {
				status: 404,
				json: { error: 'not_found' },
			},
		})
		fireEvent.press(screen.getByRole('button', { name: 'Join' }))
		await screen.findByText('This waitlist link no longer works.')
		fireEvent.press(screen.getByRole('button', { name: 'Done' }))
		await screen.findByRole('button', { name: 'Join' })
	})
})
