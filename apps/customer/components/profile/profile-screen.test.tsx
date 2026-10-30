import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { ProfileScreen } from './profile-screen'
import { i18n } from '@/lib/i18n/lingui'
import { makeSiteAddress } from '@/lib/support/site-address'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'
import { makeAccessToken, makeConfiguration } from '@/test/support'

async function signedInProfile(extra: Parameters<typeof makeApp>[0] = {}) {
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			...extra,
		},
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	// The profile request the restored session starts settles before the first render.
	await waitFor(() => {
		const status = app.store.getSnapshot().profileStatus
		expect(status === 'loaded' || status === 'failed').toBe(true)
	})
	renderWithStore(app.store, <ProfileScreen />)
	return app
}

describe('ProfileScreen', () => {
	afterEach(() => {
		act(() => {
			i18n.activate('en')
		})
	})

	it('fills the form from the profile and keeps the phone read-only', async () => {
		await signedInProfile()
		const name = await screen.findByLabelText('Name')
		expect(name.props.value).toBe('Ada Lovelace')
		expect(screen.getByLabelText('Email').props.value).toBe('ada@example.com')
		const phone = screen.getByLabelText('Phone number')
		expect(phone.props.value).toBe('+1 555 000 1111')
		expect(phone.props.editable).toBe(false)
		expect(
			screen.getByText("Your phone number can't be changed here."),
		).toBeTruthy()
	})

	it('saves the name and email and says so', async () => {
		const { transport } = await signedInProfile({
			'/auth/profile': {
				json: {
					success: true,
					accessToken: makeAccessToken({ name: 'Ada King' }),
					refreshToken: 'refresh-2',
				},
			},
		})
		await screen.findByLabelText('Name')
		fireEvent.changeText(screen.getByLabelText('Name'), 'Ada King')
		fireEvent.changeText(screen.getByLabelText('Email'), 'ada.king@example.com')
		fireEvent.press(screen.getByRole('button', { name: 'Save changes' }))

		await screen.findByText('Profile saved.')
		const update = transport.recorded.find(
			(entry) => entry.url.pathname === '/auth/profile',
		)
		expect(update?.body).toMatchObject({
			name: 'Ada King',
			email: 'ada.king@example.com',
		})

		// Typing again means the message no longer describes the fields.
		fireEvent.changeText(screen.getByLabelText('Name'), 'Ada K')
		expect(screen.queryByText('Profile saved.')).toBeNull()
	})

	it('refuses an invalid email before calling the server', async () => {
		const { transport } = await signedInProfile()
		await screen.findByLabelText('Email')
		fireEvent.changeText(screen.getByLabelText('Email'), 'not-an-email')
		fireEvent.press(screen.getByRole('button', { name: 'Save changes' }))

		await screen.findByText('Enter a valid email address.')
		expect(transport.paths).not.toContain('/auth/profile')
	})

	it('offers a retry when the profile does not load', async () => {
		await signedInProfile({
			'/auth/me': [
				{ status: 500, raw: '{"error":"Internal Server Error"}' },
				{ json: PROFILE },
			],
		})
		fireEvent.press(await screen.findByRole('button', { name: 'Try again' }))
		await waitFor(() =>
			expect(screen.getByLabelText('Name').props.value).toBe('Ada Lovelace'),
		)
	})

	it('switches the language and can follow the device again', async () => {
		const { store, preferences } = await signedInProfile()
		await screen.findByLabelText('Name')
		const system = screen.getByRole('radio', { name: 'System default' })
		expect(system).toBeChecked()

		fireEvent.press(screen.getByRole('radio', { name: 'Arabic' }))
		await waitFor(() => expect(store.getSnapshot().languageOverride).toBe('ar'))
		expect(store.getSnapshot().language.isRtl).toBe(true)
		expect(preferences.language).toBe('ar')

		fireEvent.press(screen.getByRole('radio', { name: 'System default' }))
		await waitFor(() => expect(store.getSnapshot().languageOverride).toBeNull())
	})

	it('signs out on the device at once', async () => {
		const { store } = await signedInProfile({
			'/auth/logout': { json: { success: true } },
		})
		fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }))
		await waitFor(() => expect(store.getSnapshot().isSignedIn).toBe(false))
	})

	it('leaves the site in an un-branded build: signs out and asks for a site', async () => {
		const app = makeApp(
			{
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': { json: PROFILE },
				'/auth/logout': { json: { success: true } },
			},
			{
				tokens: SIGNED_IN,
				configuration: makeConfiguration({ slug: null, host: null }),
				site: makeSiteAddress({ slug: 'acme' }),
			},
		)
		await app.store.start()
		renderWithStore(app.store, <ProfileScreen />)

		fireEvent.press(
			await screen.findByRole('button', { name: 'Use a different site' }),
		)

		await waitFor(() =>
			expect(app.store.getSnapshot().phase).toEqual({ kind: 'needsSite' }),
		)
		expect(app.store.getSnapshot().isSignedIn).toBe(false)
		expect(app.preferences.site).toBeNull()
		await waitFor(() => expect(app.transport.paths).toContain('/auth/logout'))
	})

	it('has no way to leave the site a white-label build is bound to', async () => {
		await signedInProfile()
		await screen.findByLabelText('Name')
		expect(
			screen.queryByRole('button', { name: 'Use a different site' }),
		).toBeNull()
	})
})
