import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { NotificationsSection } from './notifications-section'
import { setNotificationsAdapter } from '@/lib/push/notifications'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'
import { fakeNotifications } from '@/test/push-fake'

const PREFS = {
	orders: true,
	bookings: true,
	rewards: true,
	marketing: false,
	hasDevice: false,
	marketingAvailable: true,
}

async function open(
	preferences: unknown,
	notifications = fakeNotifications(),
	put: unknown = { ...PREFS, hasDevice: true },
) {
	setNotificationsAdapter(notifications.adapter)
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/push/preferences': (request) =>
				request.method === 'PUT'
					? { json: put }
					: typeof preferences === 'number'
						? { status: preferences, json: { error: 'push_not_enabled' } }
						: { json: preferences },
			'/push/devices': { status: 201, json: { id: 'dev_1' } },
		},
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	await waitFor(() =>
		expect(app.store.getSnapshot().profileStatus).toBe('loaded'),
	)
	renderWithStore(app.store, <NotificationsSection />)
	return { ...app, notifications }
}

afterEach(() => setNotificationsAdapter(null))

describe('NotificationsSection (#105)', () => {
	it('shows nothing when push is not on for this restaurant', async () => {
		await open(409)
		await waitFor(() =>
			expect(screen.queryByText(/Notifications from/)).toBeNull(),
		)
		expect(screen.queryByText('Turn on notifications')).toBeNull()
	})

	it('explains first and asks the system only after "Turn on notifications"', async () => {
		const { notifications, transport } = await open(PREFS)
		expect(
			await screen.findByText('Notifications from Acme Coffee'),
		).toBeTruthy()
		expect(notifications.state.prompts).toBe(0)
		fireEvent.press(screen.getByText('Turn on notifications'))
		expect(
			await screen.findByText('Choose what this phone tells you about.'),
		).toBeTruthy()
		expect(notifications.state.prompts).toBe(1)
		expect(
			transport.recorded.some((r) => r.url.pathname === '/push/devices'),
		).toBe(true)
	})

	it('"Not now" hides the pre-prompt and never asks the system', async () => {
		const { notifications } = await open(PREFS)
		fireEvent.press(await screen.findByText('Not now'))
		await waitFor(() =>
			expect(screen.queryByText('Turn on notifications')).toBeNull(),
		)
		expect(notifications.state.prompts).toBe(0)
	})

	it('offers the offers opt-in off by default and sends it with the app_prompt source', async () => {
		const { transport } = await open(PREFS, fakeNotifications(), {
			...PREFS,
			hasDevice: true,
			marketing: true,
		})
		const offers = await screen.findByRole('switch', {
			name: 'Also send me offers and news',
		})
		expect(offers).not.toBeChecked()
		fireEvent.press(offers)
		fireEvent.press(screen.getByText('Turn on notifications'))
		await screen.findByText('Choose what this phone tells you about.')
		const put = transport.recorded.find((r) => r.request.method === 'PUT')!
		expect(put.body).toEqual({ marketing: true, source: 'app_prompt' })
	})

	it('hides the offers switch while marketing push is not available', async () => {
		await open({ ...PREFS, marketingAvailable: false })
		await screen.findByText('Turn on notifications')
		expect(
			screen.queryByRole('switch', { name: 'Also send me offers and news' }),
		).toBeNull()
	})

	it('shows a switch per category once on and saves a change', async () => {
		const { transport } = await open(
			{ ...PREFS, hasDevice: true },
			fakeNotifications({ permission: 'granted' }),
			{ ...PREFS, hasDevice: true, rewards: false },
		)
		const rewards = await screen.findByRole('switch', { name: 'Rewards' })
		expect(screen.getByRole('switch', { name: 'Order updates' })).toBeChecked()
		fireEvent.press(rewards)
		await waitFor(() =>
			expect(screen.getByRole('switch', { name: 'Rewards' })).not.toBeChecked(),
		)
		const put = transport.recorded.find((r) => r.request.method === 'PUT')!
		expect(put.body).toEqual({ rewards: false })
	})

	it('records the offers opt-in from the profile with the profile source', async () => {
		const { transport } = await open(
			{ ...PREFS, hasDevice: true },
			fakeNotifications({ permission: 'granted' }),
			{ ...PREFS, hasDevice: true, marketing: true },
		)
		fireEvent.press(
			await screen.findByRole('switch', { name: 'Offers and news' }),
		)
		await waitFor(() =>
			expect(
				screen.getByRole('switch', { name: 'Offers and news' }),
			).toBeChecked(),
		)
		const put = transport.recorded.find((r) => r.request.method === 'PUT')!
		expect(put.body).toEqual({ marketing: true, source: 'profile' })
	})

	it('points to the phone settings when the system said no', async () => {
		const spy = jest.spyOn(Linking, 'openSettings').mockResolvedValue()
		await open(PREFS, fakeNotifications({ permission: 'denied' }))
		fireEvent.press(await screen.findByText('Open settings'))
		expect(spy).toHaveBeenCalled()
		spy.mockRestore()
	})
})
