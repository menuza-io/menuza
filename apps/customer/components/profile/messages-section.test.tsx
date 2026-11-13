import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { AccessibilityInfo } from 'react-native'
import { rowClass } from './messages-section'
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
	organization: Record<string, unknown> = ORGANIZATION,
) {
	const app = makeApp(
		{
			'/resources/sites': { json: organization },
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

	it('puts a space between the row classes and dims a busy row', () => {
		expect(rowClass(false)).toBe('min-h-11 flex-row items-center gap-3 py-2')
		expect(rowClass(true)).toBe(
			'min-h-11 flex-row items-center gap-3 py-2 opacity-50',
		)
	})

	it('announces a note when it appears', async () => {
		const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
		await signedInProfile(rows([]), {
			status: 409,
			json: { error: 'A verified phone number is required' },
		})
		fireEvent.press(
			await screen.findByRole('switch', { name: 'Offers and news: Text' }),
		)
		await screen.findByText('Verify your phone first')
		expect(announce).toHaveBeenCalledWith('Verify your phone first')
		announce.mockRestore()
	})

	it('shows the frequency and rates disclosure and sends the profile wording id outside KSA', async () => {
		const { transport } = await signedInProfile(rows([]))
		expect(
			await screen.findByText(
				/A few messages a month\. You can opt out anytime\. Msg and data rates may apply\. Reply STOP to opt out\./,
			),
		).toBeTruthy()
		fireEvent.press(
			screen.getByRole('switch', { name: 'Offers and news: Text' }),
		)
		await waitFor(() =>
			expect(transport.recorded.some((r) => r.request.method === 'PUT')).toBe(
				true,
			),
		)
		const put = transport.recorded.find((r) => r.request.method === 'PUT')!
		expect(put.body.textVersion).toBe('guest-profile-us-2026-11')
	})

	it('in KSA hides the offers Text switch and the rates line', async () => {
		await signedInProfile(rows([]), undefined, {
			...ORGANIZATION,
			dataRegion: 'ksa',
		})
		await screen.findByRole('switch', { name: 'Offers and news: Email' })
		expect(
			screen.queryByRole('switch', { name: 'Offers and news: Text' }),
		).toBeNull()
		expect(screen.queryByText(/Reply STOP/)).toBeNull()
	})

	it('in KSA still shows the Text switch for an active text subscription', async () => {
		await signedInProfile(
			rows([{ topic: 'marketing', channel: 'sms', subscribed: true }]),
			undefined,
			{ ...ORGANIZATION, dataRegion: 'ksa' },
		)
		expect(
			await screen.findByRole('switch', { name: 'Offers and news: Text' }),
		).toBeChecked()
	})
})
