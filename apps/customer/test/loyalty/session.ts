import { makeAccessToken, makeConfiguration } from '../support'
import { type HttpTransport } from '@/lib/api/http'
import { TenantApiClient } from '@/lib/api/tenant-api-client'
import { type TenantConfiguration } from '@/lib/config/configuration'
import {
	LoyaltyClient,
	type LoyaltyClientPlatform,
} from '@/lib/loyalty/loyalty-client'
import { CustomerSession } from '@/lib/session/customer-session'
import { createMemoryTokenStorage } from '@/lib/session/token-storage'

/** A signed-in session whose access token is valid, over the given transport. */
export async function makeSignedInSession(
	transport: HttpTransport,
	configuration: TenantConfiguration = makeConfiguration(),
): Promise<CustomerSession> {
	const session = new CustomerSession(
		new TenantApiClient(configuration, transport),
		createMemoryTokenStorage({
			accessToken: makeAccessToken(),
			refreshToken: 'refresh-1',
		}),
	)
	await session.restore()
	return session
}

export async function makeLoyaltyClient(
	transport: HttpTransport,
	options: {
		configuration?: TenantConfiguration
		platform?: LoyaltyClientPlatform
		newKey?: () => string
		signedIn?: boolean
	} = {},
): Promise<{ session: CustomerSession; client: LoyaltyClient }> {
	const session = await (options.signedIn === false
		? (() => {
				const unsigned = new CustomerSession(
					new TenantApiClient(
						options.configuration ?? makeConfiguration(),
						transport,
					),
					createMemoryTokenStorage(null),
				)
				return unsigned.restore().then(() => unsigned)
			})()
		: makeSignedInSession(transport, options.configuration))
	return {
		session,
		client: new LoyaltyClient(session, {
			platform: options.platform ?? 'ios',
			newKey: options.newKey,
		}),
	}
}
