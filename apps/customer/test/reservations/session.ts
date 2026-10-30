import { makeAccessToken, makeConfiguration } from '../support'
import { type HttpTransport } from '@/lib/api/http'
import { TenantApiClient } from '@/lib/api/tenant-api-client'
import { type TenantConfiguration } from '@/lib/config/configuration'
import {
	ReservationsClient,
	type ReservationsClientPlatform,
} from '@/lib/reservations/reservations-client'
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

export async function makeReservationsClient(
	transport: HttpTransport,
	options: {
		configuration?: TenantConfiguration
		platform?: ReservationsClientPlatform
	} = {},
): Promise<ReservationsClient> {
	const session = await makeSignedInSession(transport, options.configuration)
	return new ReservationsClient(session, {
		platform: options.platform ?? 'ios',
	})
}
