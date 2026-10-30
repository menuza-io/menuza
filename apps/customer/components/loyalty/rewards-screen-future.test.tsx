import { screen, waitFor } from '@testing-library/react-native'
import { RewardsScreen } from './rewards-screen'
import {
	makeApp,
	ORGANIZATION,
	PROFILE,
	renderWithStore,
	SIGNED_IN,
} from '@/test/app-harness'
import { futureFixtureText } from '@/test/loyalty/fixtures'

const iso = (value: string) => `\u2068${value}\u2069`
const ltr = (value: string) => `\u2066${value}\u2069`

function future(name: string): unknown {
	return JSON.parse(futureFixtureText(name))
}

describe('RewardsScreen with values from a newer region', () => {
	it('shows what it knows and hides the rest', async () => {
		const app = makeApp(
			{
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': { json: PROFILE },
				'/loyalty/wallet': { json: future('wallet') },
				'/loyalty/history': { json: future('history') },
				'/loyalty/approvals': { json: future('approvals') },
			},
			{ tokens: SIGNED_IN },
		)
		await app.store.start()
		await waitFor(() => {
			const status = app.store.getSnapshot().profileStatus
			expect(status === 'loaded' || status === 'failed').toBe(true)
		})
		renderWithStore(app.store, <RewardsScreen />)

		// An unknown unit label shows the bare number.
		await screen.findByText('332')
		// The next reward is one of the dropped ones, so there is no progress line.
		expect(screen.queryByText(/more to unlock/)).toBeNull()
		expect(screen.queryByRole('progressbar')).toBeNull()

		// Rewards of a new kind or discount type are left out.
		expect(screen.getByText('Five off your order')).toBeTruthy()
		expect(screen.getByText('Free Latte')).toBeTruthy()
		expect(screen.queryByText('Coffee bundle')).toBeNull()
		expect(screen.queryByText('Buy one get one')).toBeNull()

		// The earning rule it cannot describe is left out; the minimum stays.
		expect(
			screen.getByText('Purchases of at least $5.00 qualify.'),
		).toBeTruthy()
		expect(screen.queryByText(/for every|for each/)).toBeNull()

		await screen.findByText(`Use ${iso('Five off your order')}?`)
		expect(screen.getByText('Spends 100 for $5.00 off')).toBeTruthy()

		// A ledger type it does not know is dropped; an unknown channel is unnamed.
		await screen.findByText('Adjusted by staff')
		expect(screen.getByText(ltr('+20'))).toBeTruthy()
		expect(screen.getByText(ltr('+300'))).toBeTruthy()
		expect(screen.queryByText(ltr('+50'))).toBeNull()
		expect(screen.getAllByText(/^Online · /)).toHaveLength(1)

		expect(screen.queryByText(/unknown|gems|streak|kiosk/i)).toBeNull()
		expect(screen.queryByText(/\d (points?|stars?)\b/)).toBeNull()
	})
})
