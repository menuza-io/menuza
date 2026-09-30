/**
 * Shared OAuth helpers for POS/delivery providers (Menuza app credentials in env,
 * per-merchant tokens stored encrypted on each Integration row).
 */

import { PosError } from './errors.ts'
import { resolveAppCredentials, type PosAppCredentials } from './credentials.ts'
import { type PosProvider } from './types.ts'

export function requirePosAppCredentials(
	provider: PosProvider,
): PosAppCredentials {
	const app = resolveAppCredentials(provider)
	if (!app) {
		throw new PosError(`Set ${envHint(provider)} to connect ${provider}.`, 400)
	}
	return app
}

function envHint(provider: PosProvider): string {
	const hints: Record<PosProvider, string> = {
		clover: 'CLOVER_APP_ID and CLOVER_APP_SECRET',
		square: 'SQUARE_APP_ID and SQUARE_APP_SECRET',
		toast: 'TOAST_CLIENT_ID and TOAST_CLIENT_SECRET',
		ubereats: 'UBER_EATS_CLIENT_ID and UBER_EATS_CLIENT_SECRET',
		doordash:
			'DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID, and DOORDASH_SIGNING_SECRET',
	}
	return hints[provider]
}

export async function postJson<T = Record<string, unknown>>(
	url: string,
	body: Record<string, string>,
): Promise<T> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json',
		},
		body: JSON.stringify(body),
	})
	if (!response.ok) {
		throw new PosError(
			`Token request failed (${response.status}).`,
			response.status,
		)
	}
	return (await response.json()) as T
}

export async function postForm<T = Record<string, unknown>>(
	url: string,
	body: Record<string, string>,
): Promise<T> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		},
		body: new URLSearchParams(body).toString(),
	})
	if (!response.ok) {
		throw new PosError(
			`Token request failed (${response.status}).`,
			response.status,
		)
	}
	return (await response.json()) as T
}

export async function getJson<T>(
	url: string,
	accessToken: string,
	headers: Record<string, string> = {},
): Promise<T> {
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: 'application/json',
			...headers,
		},
	})
	if (!response.ok) {
		throw new PosError(
			`API request failed (${response.status}).`,
			response.status,
		)
	}
	return (await response.json()) as T
}
