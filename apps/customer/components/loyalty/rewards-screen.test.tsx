import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import * as Linking from 'expo-linking'
import { AccessibilityInfo } from 'react-native'
import { RewardsScreen } from './rewards-screen'
import { i18n } from '@/lib/i18n/lingui'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	type Route,
	SIGNED_IN,
} from '@/test/app-harness'
import { fixtureJson } from '@/test/loyalty/fixtures'

const iso = (value: string) => `\u2068${value}\u2069`
const ltr = (value: string) => `\u2066${value}\u2069`
const APPROVAL_ID = '00000000-0000-4000-8000-000000000008'
const DECIDE = `/loyalty/approvals/${APPROVAL_ID}/decide`

async function renderWallet(
	extra: Record<string, Route | Route[]> = {},
	props: { focused?: boolean } = {},
) {
	const app = makeApp(
		{
			'/resources/sites': { json: ORGANIZATION },
			'/auth/me': { json: PROFILE },
			'/loyalty/wallet': { json: fixtureJson('wallet-member') },
			'/loyalty/history': { json: fixtureJson('history-last-page') },
			'/loyalty/approvals': { json: fixtureJson('approvals-empty') },
			...extra,
		},
		{ tokens: SIGNED_IN },
	)
	await app.store.start()
	await waitFor(() => {
		const status = app.store.getSnapshot().profileStatus
		expect(status === 'loaded' || status === 'failed').toBe(true)
	})
	renderWithStore(app.store, <RewardsScreen {...props} />)
	return app
}

describe('RewardsScreen', () => {
	afterEach(() => {
		act(() => {
			i18n.activate('en')
		})
	})

	it('shows the balance, progress to the next reward, rewards and history', async () => {
		const { transport } = await renderWallet({
			'/loyalty/history': [
				{ json: fixtureJson('history') },
				{ json: fixtureJson('history-last-page') },
			],
		})

		await screen.findByText('332 points')
		expect(
			screen.getByText(`68 points more to unlock ${iso('20% off pastries')}`),
		).toBeTruthy()
		const bar = screen.getByRole('progressbar')
		expect(bar.props.accessibilityLabel).toBe(
			`Progress to ${iso('20% off pastries')}`,
		)
		expect(bar.props.accessibilityValue).toMatchObject({
			min: 0,
			max: 100,
			now: 83,
			text: '83%',
		})
		expect(screen.getByText('Your points')).toBeTruthy()
		expect(screen.queryByText(/^Member since /)).toBeNull()

		// Rewards with the member's standing against each.
		expect(screen.getByText('Five off your order')).toBeTruthy()
		expect(screen.getByText('$5.00 off')).toBeTruthy()
		expect(screen.getByText('Free Latte')).toBeTruthy()
		expect(screen.getAllByText('You have enough for this reward')).toHaveLength(
			2,
		)
		expect(screen.getByText('68 points more needed')).toBeTruthy()
		expect(screen.getByText('One reward per order.')).toBeTruthy()

		// Earning rule in words.
		expect(screen.getByText('1 point for every $1.00 you spend')).toBeTruthy()

		// History, newest first, with a signed delta kept left to right.
		await screen.findByText('Adjusted by staff')
		expect(screen.getByText(ltr('+20 points'))).toBeTruthy()
		expect(screen.getByText(ltr('+300 points'))).toBeTruthy()
		expect(screen.getByText(/^Online · /)).toBeTruthy()

		fireEvent.press(screen.getByRole('button', { name: 'Show more' }))
		await screen.findByText(ltr('+12 points'))
		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
		const pages = transport.recorded.filter(
			(entry) => entry.url.pathname === '/loyalty/history',
		)
		expect(pages).toHaveLength(2)
		expect(pages[1]?.url.searchParams.get('cursor')).toBe(
			fixtureJson('history').nextCursor,
		)
	})

	it('says when there is no activity yet, and retries a failed history', async () => {
		await renderWallet({
			'/loyalty/history': [
				{ status: 503, json: fixtureJson('error-unavailable') },
				{ json: { entries: [], nextCursor: null } },
			],
		})
		await screen.findByText(
			'Rewards are temporarily unavailable. Please try again later.',
		)
		fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
		await screen.findByText(
			'No activity yet. Your purchases will show up here.',
		)
	})

	it('approves a till request and announces it', async () => {
		const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
		const { transport } = await renderWallet({
			'/loyalty/wallet': [
				{ json: fixtureJson('wallet-member') },
				{ json: fixtureJson('wallet-after-approval') },
			],
			'/loyalty/approvals': [
				{ json: fixtureJson('approvals') },
				{ json: fixtureJson('approvals-empty') },
			],
			[DECIDE]: { json: fixtureJson('approval-approved') },
		})

		await screen.findByText(`Use ${iso('Five off your order')}?`)
		expect(screen.getByText('Spends 100 points for $5.00 off')).toBeTruthy()
		expect(screen.getByText(/^Expires in /)).toBeTruthy()

		fireEvent.press(
			screen.getByRole('button', {
				name: `Approve ${iso('Five off your order')}`,
			}),
		)

		const message = `Approved: ${iso('Five off your order')}.`
		await screen.findByText(message)
		const decide = transport.recorded.find(
			(entry) => entry.url.pathname === DECIDE,
		)
		// The site binding rides along, as on every native loyalty call.
		expect(decide?.body).toEqual({ decision: 'approve', slug: 'acme' })
		expect(decide?.request.method).toBe('POST')
		expect(announce).toHaveBeenCalledWith(message)
		expect(screen.queryByText(`Use ${iso('Five off your order')}?`)).toBeNull()

		fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }))
		expect(screen.queryByText(message)).toBeNull()
		announce.mockRestore()
	})

	it('declines a till request', async () => {
		const { transport } = await renderWallet({
			'/loyalty/approvals': [
				{ json: fixtureJson('approvals') },
				{ json: fixtureJson('approvals-empty') },
			],
			[DECIDE]: { json: fixtureJson('approval-declined') },
		})
		fireEvent.press(
			await screen.findByRole('button', {
				name: `Decline ${iso('Five off your order')}`,
			}),
		)
		await screen.findByText(`Declined: ${iso('Five off your order')}.`)
		const decide = transport.recorded.find(
			(entry) => entry.url.pathname === DECIDE,
		)
		expect(decide?.body).toEqual({ decision: 'decline', slug: 'acme' })
	})

	it('shows a member code with a countdown, spelled out for screen readers', async () => {
		const { transport } = await renderWallet({
			'/loyalty/member-code': { json: fixtureJson('member-code') },
		})
		fireEvent.press(await screen.findByRole('button', { name: 'Show my code' }))

		await screen.findByText('K7QM-4XPR')
		expect(
			screen.getByLabelText('Your code at the counter: K 7 Q M, 4 X P R'),
		).toBeTruthy()
		expect(screen.getByText(/^Expires in \u2066\d+:\d\d\u2069$/)).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Get a new code' })).toBeTruthy()
		expect(
			screen.getByText(
				'Showing your code does not spend any points. You approve every reward yourself.',
			),
		).toBeTruthy()
		expect(transport.paths).toContain('/loyalty/member-code')
	})

	it('opens straight to the points: nothing to join or accept', async () => {
		const { transport } = await renderWallet()

		await screen.findByText('332 points')
		expect(screen.getByText('Your points')).toBeTruthy()
		expect(screen.getByText('Rewards')).toBeTruthy()
		expect(screen.queryByText(/^Join /)).toBeNull()
		expect(
			screen.queryByRole('button', { name: /join|enroll|accept/i }),
		).toBeNull()
		expect(screen.queryByRole('checkbox')).toBeNull()
		expect(transport.paths).not.toContain('/loyalty/enroll')
		expect(transport.paths).toContain('/loyalty/wallet')
	})

	it('shows no terms section when the program has none', async () => {
		const wallet = fixtureJson('wallet-member')
		await renderWallet({
			'/loyalty/wallet': {
				json: {
					wallet: {
						...wallet.wallet,
						program: { ...wallet.wallet.program, terms: null },
					},
				},
			},
		})
		await screen.findByText('332 points')
		expect(screen.queryByRole('button', { name: 'Program terms' })).toBeNull()
	})

	it('hides the wallet for an erased account', async () => {
		const wallet = fixtureJson('wallet-member')
		await renderWallet({
			'/loyalty/wallet': {
				json: { wallet: { ...wallet.wallet, member: null, balance: null } },
			},
		})
		await screen.findByText('Rewards are not available right now')
		expect(screen.queryByText('Your points')).toBeNull()
	})

	it('explains a paused program and hides the code and requests', async () => {
		await renderWallet({
			'/loyalty/wallet': { json: fixtureJson('wallet-paused') },
		})
		await screen.findByText(
			'The rewards program is paused. Your balance is safe, but you cannot earn or redeem right now.',
		)
		expect(screen.queryByText('Your code')).toBeNull()
		expect(screen.queryByText('Requests to use your rewards')).toBeNull()
		expect(screen.queryByText('One reward per order.')).toBeNull()
	})

	it('explains an account on hold, calmly, without a code or requests', async () => {
		await renderWallet({
			'/loyalty/wallet': { json: fixtureJson('wallet-suspended') },
		})
		await screen.findByText(
			'Your rewards account is on hold. Please contact the business for help.',
		)
		expect(screen.queryByRole('button', { name: 'Show my code' })).toBeNull()
		expect(screen.queryByText('Requests to use your rewards')).toBeNull()
		// The points are still shown.
		expect(screen.getByText('Your points')).toBeTruthy()
	})

	it('says when the site runs no rewards program', async () => {
		await renderWallet({
			'/loyalty/wallet': { json: fixtureJson('wallet-none') },
		})
		await screen.findByText('Rewards are not available right now')
		expect(
			screen.getByText(
				'This business is not running a rewards program at the moment.',
			),
		).toBeTruthy()
	})

	it('offers a retry when the wallet does not load', async () => {
		await renderWallet({
			'/loyalty/wallet': [
				{ status: 503, json: fixtureJson('error-unavailable') },
				{ json: fixtureJson('wallet-member') },
			],
		})
		await screen.findByText(
			'Rewards are temporarily unavailable. Please try again later.',
		)
		fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
		await screen.findByText('332 points')
	})

	it('opens the website to order, with nothing private in the link', async () => {
		const openURL = jest.mocked(Linking.openURL)
		openURL.mockClear()
		await renderWallet()
		fireEvent.press(
			await screen.findByRole('link', { name: 'Order on the website' }),
		)
		expect(openURL).toHaveBeenCalledWith('https://acme.epic-startup.com/menu')
	})

	it('folds the program terms away, read-only, until asked', async () => {
		await renderWallet()
		const toggle = await screen.findByRole('button', { name: 'Program terms' })
		const terms =
			'Earn 1 point for every $1 you spend. Points have no cash value.'
		expect(screen.queryByText(terms)).toBeNull()
		fireEvent.press(toggle)
		expect(screen.getByText(terms)).toBeTruthy()
		expect(toggle.props.accessibilityState).toMatchObject({ expanded: true })
	})

	it('stays inactive while its tab is not focused', async () => {
		const { store } = await renderWallet({}, { focused: false })
		await screen.findByText('332 points')
		expect(store.getSnapshot().features?.loyalty.getSnapshot().active).toBe(
			false,
		)
	})
})
