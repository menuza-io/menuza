import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react-native'
import * as Linking from 'expo-linking'
import { Text } from 'react-native'
import { LayoutDirection } from 'uniwind'
import { announcementKind, announcementLink } from './announcement-banner'
import { AppRoot } from './app-root'
import { AppProvider } from '@/lib/app/app-provider'
import { i18n } from '@/lib/i18n/lingui'
import { makeSiteAddress } from '@/lib/support/site-address'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	type Route,
	SIGNED_IN,
} from '@/test/app-harness'
import { makeAccessToken, makeConfiguration } from '@/test/support'

function SignedInScreen() {
	return <Text>Signed-in content</Text>
}

function renderShell(
	table: Record<string, Route | Route[]>,
	options: Parameters<typeof makeApp>[1] = {},
) {
	const app = makeApp(table, options)
	render(
		<AppProvider store={app.store}>
			<AppRoot>
				<SignedInScreen />
			</AppRoot>
		</AppProvider>,
	)
	return app
}

const unbound = () => makeConfiguration({ slug: null, host: null })

describe('AppShell', () => {
	it('connects an un-branded install to the site the customer types', async () => {
		const { transport, preferences } = renderShell(
			{ '/resources/sites': { json: ORGANIZATION } },
			{ configuration: unbound() },
		)

		await screen.findByText('Connect to your site')
		const connect = screen.getByRole('button', { name: 'Connect' })
		expect(connect).toBeDisabled()

		fireEvent.changeText(screen.getByLabelText('Site address'), 'acme')
		fireEvent.press(screen.getByRole('button', { name: 'Connect' }))

		await screen.findByText('Sign in')
		expect(screen.getByText('Acme Coffee')).toBeTruthy()
		expect(transport.lastRequest?.url.searchParams.get('slug')).toBe('acme')
		expect(preferences.site?.slug).toBe('acme')
	})

	it('explains an address that does not resolve and stays on the form', async () => {
		renderShell(
			{ '/resources/sites': { status: 404, raw: '{"error":"Not found"}' } },
			{
				configuration: unbound(),
			},
		)
		await screen.findByText('Connect to your site')

		fireEvent.changeText(screen.getByLabelText('Site address'), 'nope')
		fireEvent.press(screen.getByRole('button', { name: 'Connect' }))

		await screen.findByText(
			"We couldn't find that site. Check the address and try again.",
		)
		expect(screen.getByText('Connect to your site')).toBeTruthy()
	})

	it('offers a retry when the bound site fails to load', async () => {
		renderShell({
			'/resources/sites': [
				{ status: 503, raw: '{"error":"Unavailable"}' },
				{ json: ORGANIZATION },
			],
		})

		const retry = await screen.findByRole('button', { name: 'Try again' })
		// A white-label build has only its own site.
		expect(
			screen.queryByRole('button', { name: 'Use a different site' }),
		).toBeNull()
		fireEvent.press(retry)

		await screen.findByText('Sign in')
	})

	it('lets an un-branded install leave a site that does not load', async () => {
		const { preferences, store } = renderShell(
			{ '/resources/sites': { status: 503, raw: '{"error":"Unavailable"}' } },
			{
				configuration: unbound(),
				site: makeSiteAddress({ slug: 'acme' }),
				tokens: SIGNED_IN,
			},
		)

		fireEvent.press(
			await screen.findByRole('button', { name: 'Use a different site' }),
		)

		await screen.findByText('Connect to your site')
		expect(preferences.site).toBeNull()
		expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
	})

	it('shows the first announcement with a safe link', async () => {
		const openURL = jest.mocked(Linking.openURL)
		openURL.mockClear()
		renderShell({
			'/resources/sites': {
				json: {
					...ORGANIZATION,
					announcements: [
						{
							id: 'ann_1',
							content: 'Free delivery this week',
							type: 'warning',
							linkUrl: 'https://acme.example.com/deals',
							linkLabel: 'See deals',
						},
						{ id: 'ann_2', content: 'Second one', type: 'info' },
					],
				},
			},
		})

		await screen.findByText('Free delivery this week')
		expect(screen.queryByText('Second one')).toBeNull()
		fireEvent.press(screen.getByRole('link', { name: 'See deals' }))
		expect(openURL).toHaveBeenCalledWith('https://acme.example.com/deals')
	})

	it('signs in with a phone number and a code, then shows the signed-in screens', async () => {
		const { transport } = renderShell({
			'/resources/sites': { json: ORGANIZATION },
			'/auth/send-code': { json: { success: true } },
			'/auth/verify': {
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'r',
					needsName: false,
				},
			},
			'/auth/me': { json: PROFILE },
		})
		await screen.findByText('Sign in')
		expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled()

		fireEvent.changeText(
			screen.getByLabelText('Phone number'),
			'+1 555 000 1111',
		)
		fireEvent.press(screen.getByRole('button', { name: 'Send code' }))

		await screen.findByText('Enter your code')
		expect(
			screen.getByText('We sent a 6-digit code to +1 555 000 1111.'),
		).toBeTruthy()

		fireEvent.changeText(screen.getByLabelText('Verification code'), '١٢٣٤٥٦')
		fireEvent.press(screen.getByRole('button', { name: 'Verify' }))

		await screen.findByText('Signed-in content')
		const verify = transport.recorded.find(
			(entry) => entry.url.pathname === '/auth/verify',
		)
		expect(verify?.body.code).toBe('123456')
	})

	it('resends the code and goes back to the phone step', async () => {
		const { transport } = renderShell({
			'/resources/sites': { json: ORGANIZATION },
			'/auth/send-code': { json: { success: true } },
		})
		await screen.findByText('Sign in')
		fireEvent.changeText(screen.getByLabelText('Phone number'), '+15550001111')
		fireEvent.press(screen.getByRole('button', { name: 'Send code' }))
		await screen.findByText('Enter your code')

		fireEvent.press(screen.getByRole('button', { name: 'Send a new code' }))
		await screen.findByText('We sent you a new code.')
		expect(
			transport.paths.filter((path) => path === '/auth/send-code'),
		).toHaveLength(2)

		fireEvent.press(
			screen.getByRole('button', { name: 'Use a different number' }),
		)
		await screen.findByText('Sign in')
	})

	it('shows the server error for a wrong code', async () => {
		renderShell({
			'/resources/sites': { json: ORGANIZATION },
			'/auth/send-code': { json: { success: true } },
			'/auth/verify': {
				status: 400,
				json: { error: 'Invalid or expired code' },
			},
		})
		await screen.findByText('Sign in')
		fireEvent.changeText(screen.getByLabelText('Phone number'), '+15550001111')
		fireEvent.press(screen.getByRole('button', { name: 'Send code' }))
		await screen.findByText('Enter your code')

		fireEvent.changeText(screen.getByLabelText('Verification code'), '000000')
		fireEvent.press(screen.getByRole('button', { name: 'Verify' }))

		await screen.findByText("That code isn't right or has expired. Try again.")
		expect(screen.queryByText('Signed-in content')).toBeNull()
	})

	it('asks a new customer for a name before the signed-in screens', async () => {
		const { transport } = renderShell({
			'/resources/sites': { json: ORGANIZATION },
			'/auth/send-code': { json: { success: true } },
			'/auth/verify': {
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'r',
					needsName: true,
				},
			},
			'/auth/profile': {
				json: {
					success: true,
					accessToken: makeAccessToken({ name: 'Grace Hopper' }),
					refreshToken: 'refresh-2',
				},
			},
			'/auth/me': {
				json: { customer: { id: 'cust_1', name: 'Grace Hopper' } },
			},
		})
		await screen.findByText('Sign in')
		fireEvent.changeText(screen.getByLabelText('Phone number'), '+15550001111')
		fireEvent.press(screen.getByRole('button', { name: 'Send code' }))
		await screen.findByText('Enter your code')
		fireEvent.changeText(screen.getByLabelText('Verification code'), '123456')
		fireEvent.press(screen.getByRole('button', { name: 'Verify' }))

		await screen.findByText('Your name')
		fireEvent.changeText(screen.getByLabelText('Name'), 'G')
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
		fireEvent.changeText(screen.getByLabelText('Name'), 'Grace Hopper')
		fireEvent.press(screen.getByRole('button', { name: 'Continue' }))

		await screen.findByText('Signed-in content')
		const update = transport.recorded.find(
			(entry) => entry.url.pathname === '/auth/profile',
		)
		expect(update?.body.name).toBe('Grace Hopper')
	})

	it('restores a stored session straight into the signed-in screens', async () => {
		renderShell(
			{
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': { json: PROFILE },
			},
			{ tokens: SIGNED_IN },
		)
		await screen.findByText('Signed-in content')
		expect(screen.queryByText('Sign in')).toBeNull()
	})

	it('lays the tree out right to left in Arabic and activates its catalog', async () => {
		renderShell(
			{ '/resources/sites': { json: ORGANIZATION } },
			{ language: 'ar' },
		)
		await waitFor(() => expect(i18n.locale).toBe('ar'))
		expect(screen.UNSAFE_getByType(LayoutDirection).props.rtl).toBe(true)
		await act(async () => {
			i18n.activate('en')
		})
	})
})

describe('announcement helpers', () => {
	it('maps announcement types like the Sites bar', () => {
		expect(announcementKind('warning')).toBe('warning')
		expect(announcementKind('error')).toBe('error')
		expect(announcementKind('success')).toBe('info')
		expect(announcementKind('anything')).toBe('info')
	})

	it('only follows web links', () => {
		expect(announcementLink(' https://acme.example.com/a ')).toBe(
			'https://acme.example.com/a',
		)
		expect(announcementLink('http://acme.example.com')).toBe(
			'http://acme.example.com/',
		)
		expect(announcementLink('javascript:alert(1)')).toBeNull()
		expect(announcementLink('tel:+15550001111')).toBeNull()
		expect(announcementLink('not a url')).toBeNull()
		expect(announcementLink(null)).toBeNull()
	})
})
