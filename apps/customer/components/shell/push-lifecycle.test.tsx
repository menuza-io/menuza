import { buildLink } from '@repo/common/links'
import { waitFor } from '@testing-library/react-native'
import { PushLifecycle } from './push-lifecycle'
import { setNotificationsAdapter } from '@/lib/push/notifications'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'
import { fakeNotifications } from '@/test/push-fake'
import { makeConfiguration } from '@/test/support'

const HEX = 'e'.repeat(64)
const ORIGIN = 'https://acme.menuza.io'

async function mount(
	notifications = fakeNotifications({ permission: 'granted' }),
) {
	setNotificationsAdapter(notifications.adapter)
	const navigate = jest.fn()
	const openUrl = jest.fn()
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/push/preferences': {
				json: {
					orders: true,
					bookings: true,
					rewards: true,
					marketing: false,
					hasDevice: true,
					marketingAvailable: false,
				},
			},
			'/push/devices': { status: 201, json: { id: 'dev_1' } },
			'/push/opened': { status: 204, raw: '' },
		},
		{
			tokens: SIGNED_IN,
			configuration: makeConfiguration({
				slug: 'acme',
				host: 'acme.menuza.io',
				origin: ORIGIN,
			}),
		},
	)
	await app.store.start()
	await waitFor(() => expect(app.store.getSnapshot().isSignedIn).toBe(true))
	renderWithStore(
		app.store,
		<PushLifecycle navigate={navigate} openUrl={openUrl} />,
	)
	await waitFor(() => expect(notifications.listening).toBe(true))
	return { ...app, notifications, navigate, openUrl }
}

afterEach(() => setNotificationsAdapter(null))

describe('PushLifecycle (#105)', () => {
	it('registers the device again on launch when the system already allows notifications', async () => {
		const { transport } = await mount()
		await waitFor(() =>
			expect(
				transport.recorded.some((r) => r.url.pathname === '/push/devices'),
			).toBe(true),
		)
	})

	it('a tapped order push opens the order screen and reports the tap by message id only', async () => {
		const { notifications, navigate, transport } = await mount()
		const url = buildLink(
			'order',
			{ order: 'ord_7', link: HEX },
			{ origin: ORIGIN },
		)!
		notifications.tap({ url, messageId: 'msg_1', kind: 'order_status' })
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({
				pathname: '/orders/ord_7',
				params: { link: HEX },
			}),
		)
		await waitFor(() => {
			const opened = transport.recorded.find(
				(r) => r.url.pathname === '/push/opened',
			)
			expect(opened?.body).toEqual({ messageId: 'msg_1' })
		})
	})

	it('handles one tap once even when it arrives twice', async () => {
		const { notifications, navigate } = await mount()
		const url = buildLink('loyalty', {}, { origin: ORIGIN })!
		notifications.tap({ url, messageId: 'msg_2' })
		notifications.tap({ url, messageId: 'msg_2' })
		await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
	})

	it('opens a push that launched the app from a cold start', async () => {
		const url = buildLink('reserve', {}, { origin: ORIGIN })!
		const { navigate } = await mount(
			fakeNotifications({
				permission: 'granted',
				initial: { url, messageId: 'msg_3' },
			}),
		)
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(
				expect.objectContaining({ pathname: '/reservations' }),
			),
		)
	})

	it('opens the website for a link the app does not claim', async () => {
		const { notifications, navigate, openUrl } = await mount()
		const other = buildLink(
			'order',
			{ order: 'o1' },
			{ origin: 'https://other.menuza.io' },
		)!
		notifications.tap({ url: other, messageId: 'msg_4' })
		await waitFor(() => expect(openUrl).toHaveBeenCalledWith(other))
		expect(navigate).not.toHaveBeenCalled()
	})
})
