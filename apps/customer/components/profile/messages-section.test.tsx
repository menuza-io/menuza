import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { ProfileScreen } from './profile-screen'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'
import { type StubReply } from '@/test/stub-transport'

async function signedInProfile(
	subscriptions: StubReply,
	put: StubReply | StubReply[] = { json: { subscribed: true } },
) {
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/subscriptions': subscriptions,
			'/subscriptions/marketing/email': put,
			'/subscriptions/marketing/sms': put,
		},
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	await waitFor(() =>
		expect(app.store.getSnapshot().profileStatus).toBe('loaded'),
	)
	renderWithStore(app.store, <ProfileScreen />)
	return app
}

const rows = (subscriptions: unknown[]): StubReply => ({
	json: { drops: { sms: false }, subscriptions },
})

describe('MessagesSection', () => {
	it('shows the restaurant name, the switches and the receipts note', async () => {
		await signedInProfile(rows([]))
		expect(await screen.findByText('Messages from Acme Coffee')).toBeTruthy()
		expect(
			screen.getByRole('switch', { name: 'Offers and news: Email' }),
		).toBeTruthy()
		expect(
			screen.getByRole('switch', { name: 'Offers and news: Text' }),
		).not.toBeChecked()
		expect(
			screen.getByText(
				'Turning a switch off never affects receipts or booking confirmations.',
			),
		).toBeTruthy()
		// Reservation news and drops are not offered until they exist for the site.
		expect(screen.queryByText('Reservation news')).toBeNull()
		expect(screen.queryByText(/drop/i)).toBeNull()
	})

	it('turns a switch on with the profile source and says when the email is pending', async () => {
		const { transport } = await signedInProfile(rows([]), {
			json: { pending: true },
		})
		fireEvent.press(
			await screen.findByRole('switch', { name: 'Offers and news: Email' }),
		)
		expect(await screen.findByText('Check your inbox to confirm')).toBeTruthy()
		const put = transport.recorded.find((r) => r.request.method === 'PUT')!
		expect(put.body).toMatchObject({ subscribed: true, source: 'profile' })
		expect(typeof put.body.textVersion).toBe('string')
	})

	it('shows an unconfirmed email subscription as pending on load', async () => {
		await signedInProfile(
			rows([
				{
					topic: 'marketing',
					channel: 'email',
					subscribed: true,
					confirmed: false,
				},
				{ topic: 'reservations', channel: 'sms', subscribed: true },
			]),
		)
		expect(await screen.findByText('Check your inbox to confirm')).toBeTruthy()
		// A subscribed reservations row brings its topic back so it can be turned off.
		expect(screen.getByText('Reservation news')).toBeTruthy()
	})

	it('rolls back and explains a 409', async () => {
		await signedInProfile(rows([]), {
			status: 409,
			json: { error: 'A verified phone number is required' },
		})
		const sms = await screen.findByRole('switch', {
			name: 'Offers and news: Text',
		})
		fireEvent.press(sms)
		expect(await screen.findByText('Verify your phone first')).toBeTruthy()
		await waitFor(() =>
			expect(
				screen.getByRole('switch', { name: 'Offers and news: Text' }),
			).not.toBeChecked(),
		)
	})
})
