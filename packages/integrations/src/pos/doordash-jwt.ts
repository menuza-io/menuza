/**
 * DoorDash Marketplace / Drive APIs authenticate with short-lived HS256 JWTs
 * minted from developer portal credentials (not OAuth client_id/secret).
 *
 * @see https://developer.doordash.com/en-US/docs/marketplace/overview/getting_started/jwts_getting_started
 */

import { createHmac } from 'node:crypto'

import {
	resolveDoorDashJwtCredentials,
	type DoorDashJwtCredentials,
} from './credentials.ts'

const JWT_TTL_SECONDS = 300

function base64UrlJson(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeSigningSecret(signingSecret: string): Buffer {
	const normalized = signingSecret.replace(/-/g, '+').replace(/_/g, '/')
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
	return Buffer.from(padded, 'base64')
}

export function mintDoorDashJwt(
	credentials: Pick<
		DoorDashJwtCredentials,
		'developerId' | 'keyId' | 'signingSecret'
	>,
	ttlSeconds: number = JWT_TTL_SECONDS,
): string {
	const header = {
		alg: 'HS256',
		typ: 'JWT',
		'dd-ver': 'DD-JWT-V1',
	}
	const now = Math.floor(Date.now() / 1000)
	const payload = {
		aud: 'doordash',
		iss: credentials.developerId,
		kid: credentials.keyId,
		iat: now,
		exp: now + ttlSeconds,
	}
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
	const signature = createHmac(
		'sha256',
		decodeSigningSecret(credentials.signingSecret),
	)
		.update(signingInput)
		.digest('base64url')
	return `${signingInput}.${signature}`
}

export function doorDashApiHeaders(): Record<string, string> {
	return {
		'auth-version': 'v2',
		'User-Agent': 'Menuza/1.0',
	}
}

export function mintDoorDashJwtFromEnv(): string | null {
	const credentials = resolveDoorDashJwtCredentials()
	if (!credentials) return null
	return mintDoorDashJwt(credentials)
}
