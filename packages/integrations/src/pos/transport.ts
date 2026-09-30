/**
 * Resolves the HTTP transport for a POS connection.
 *
 * A stored OAuth access token (from an OAuth connection) wins; otherwise a
 * static token + merchant id from the environment is used; otherwise the
 * sandbox host with the mock guard. See `./credentials.ts` and `./sandbox.ts`.
 */

import { type Transport } from './adapter.ts'
import { doorDashApiHeaders, mintDoorDashJwt } from './doordash-jwt.ts'
import {
	liveApiBaseUrl,
	resolveCredentials,
	resolveDoorDashJwtCredentials,
} from './credentials.ts'
import { PosError } from './errors.ts'
import { sandboxUrls, type PosProvider } from './types.ts'

export type PosEnvironment = 'sandbox' | 'live'
export type PosConnectionConfig = {
	environment: PosEnvironment
	merchantId: string
	locationId?: string | null
}

export type TransportOptions = {
	/** Decrypted OAuth access token stored on the connection. */
	accessToken?: string | null
}

/** Header the sandbox uses to find the per-connection store. */
export const POS_STORE_HEADER = 'x-pos-store'
/** Header the sandbox uses to know the connection's store id. */
export const POS_MERCHANT_HEADER = 'x-pos-merchant'

export function parsePosConfig(config: unknown): PosConnectionConfig {
	let raw: Record<string, unknown> = {}
	if (typeof config === 'string' && config.trim()) {
		try {
			raw = JSON.parse(config) as Record<string, unknown>
		} catch {
			raw = {}
		}
	} else if (config && typeof config === 'object') {
		raw = config as Record<string, unknown>
	}
	const metadata =
		raw.metadata && typeof raw.metadata === 'object'
			? (raw.metadata as Record<string, unknown>)
			: {}
	// OAuth connections store the merchant id under `metadata` (see
	// IntegrationManager.createIntegration); direct connections store it flat.
	const merchantId =
		typeof raw.merchantId === 'string'
			? raw.merchantId
			: typeof metadata.merchantId === 'string'
				? metadata.merchantId
				: ''
	const environment =
		raw.environment === 'live' || metadata.merchantId ? 'live' : 'sandbox'
	const locationId = typeof raw.locationId === 'string' ? raw.locationId : null
	return { environment, merchantId, locationId }
}

export function resolveTransport(
	provider: PosProvider,
	integrationId: string,
	config: PosConnectionConfig,
	options: TransportOptions = {},
): Transport {
	const storedToken = options.accessToken?.trim()
	const isLiveConnection = config.environment === 'live'

	if (provider === 'doordash' && isLiveConnection && !storedToken) {
		const jwtCreds = resolveDoorDashJwtCredentials()
		if (!jwtCreds) {
			throw new PosError(
				'Set DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID, and DOORDASH_SIGNING_SECRET.',
				400,
			)
		}
		if (!config.merchantId) {
			throw new PosError(
				'This DoorDash connection has no store id. Disconnect and connect again, linking your Menuza location to your DoorDash store.',
				400,
			)
		}
		return {
			baseUrl: jwtCreds.apiBaseUrl,
			token: mintDoorDashJwt(jwtCreds),
			merchantId: config.merchantId,
			headers: doorDashApiHeaders(),
			requireMock: false,
		}
	}

	// OAuth connection: use the connection's own token.
	if (storedToken) {
		if (!config.merchantId) {
			throw new PosError(
				'This connection is missing a store id. Disconnect and connect again.',
				400,
			)
		}
		return {
			baseUrl: liveApiBaseUrl(provider),
			token: storedToken,
			merchantId: config.merchantId,
			requireMock: false,
		}
	}

	if (isLiveConnection) {
		throw new PosError('Authorization expired. Reconnect and try again.', 401)
	}

	const credentials = resolveCredentials(provider)

	const merchantId = config.merchantId || credentials.merchantId
	return {
		baseUrl: sandboxUrls[provider],
		token: credentials.token,
		merchantId,
		headers: {
			[POS_STORE_HEADER]: integrationId,
			[POS_MERCHANT_HEADER]: merchantId,
		},
		requireMock: true,
	}
}
