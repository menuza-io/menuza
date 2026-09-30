import { describe, expect, it } from 'vitest'
import { SquareProvider } from '../../src/pos/providers/square.ts'

describe('Square OAuth', () => {
	it('always uses the connect.* host for sandbox authorize', async () => {
		process.env.SQUARE_APP_ID = 'sandbox-sq0idb-test'
		process.env.SQUARE_APP_SECRET = 'secret'
		process.env.SQUARE_AUTHORIZE_URL = 'https://squareupsandbox.com'

		const url = await new SquareProvider().getAuthUrl(
			'org-1',
			'https://app.menuza.test:2999/api/integrations/oauth/callback',
			{ state: 'signed-state' },
		)

		expect(new URL(url).origin).toBe('https://connect.squareupsandbox.com')
		expect(url).toContain('/oauth2/authorize?')

		delete process.env.SQUARE_APP_ID
		delete process.env.SQUARE_APP_SECRET
		delete process.env.SQUARE_AUTHORIZE_URL
	})
})
