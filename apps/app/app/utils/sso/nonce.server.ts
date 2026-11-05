/**
 * SSO Nonce Management
 *
 * Handles generation and validation of nonces for OIDC authentication.
 * Nonces prevent replay attacks by ensuring the ID token was issued for this specific request.
 */

import { createCookieSessionStorage } from 'react-router'

// Session storage for SSO nonces (short-lived, 10 minutes max). Built on first
// use so SESSION_SECRET is read after the Worker bindings are applied, not when
// the server build loads.
function getSsoNonceStorage() {
	const secret = process.env.SESSION_SECRET
	if (!secret) {
		throw new Error(
			'SESSION_SECRET environment variable is required for SSO nonce storage. ' +
				'Please add SESSION_SECRET to your .env file.',
		)
	}
	return createCookieSessionStorage({
		cookie: {
			name: '__sso_nonce',
			httpOnly: true,
			path: '/',
			sameSite: 'lax',
			secrets: [secret],
			secure: process.env.NODE_ENV === 'production',
			maxAge: 60 * 10, // 10 minutes - nonces should be short-lived
		},
	})
}

const NONCE_KEY = 'sso_nonce'
const NONCE_TIMESTAMP_KEY = 'sso_nonce_ts'

/**
 * Generate a cryptographically secure nonce
 */
export function generateNonce(): string {
	const array = new Uint8Array(32)
	crypto.getRandomValues(array)
	return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

/**
 * Store a nonce in the session for later validation
 * Returns the Set-Cookie header to include in the response
 */
export async function storeNonce(
	request: Request,
	nonce: string,
): Promise<string> {
	const session = await getSsoNonceStorage().getSession(
		request.headers.get('Cookie'),
	)
	session.set(NONCE_KEY, nonce)
	session.set(NONCE_TIMESTAMP_KEY, Date.now())
	return getSsoNonceStorage().commitSession(session)
}

/**
 * Retrieve and consume the stored nonce
 * The nonce is deleted after retrieval to prevent reuse
 */
export async function consumeNonce(request: Request): Promise<{
	nonce: string | null
	cookieHeader: string
}> {
	const session = await getSsoNonceStorage().getSession(
		request.headers.get('Cookie'),
	)
	const nonce = session.get(NONCE_KEY) as string | null
	const timestamp = session.get(NONCE_TIMESTAMP_KEY) as number | null

	// Check if nonce is expired (10 minutes)
	if (nonce && timestamp) {
		const age = Date.now() - timestamp
		if (age > 10 * 60 * 1000) {
			// Nonce expired, destroy session
			return {
				nonce: null,
				cookieHeader: await getSsoNonceStorage().destroySession(session),
			}
		}
	}

	// Destroy the session to consume the nonce
	const cookieHeader = await getSsoNonceStorage().destroySession(session)

	return { nonce, cookieHeader }
}

/**
 * Get the stored nonce without consuming it (for validation purposes)
 */
export async function getNonce(request: Request): Promise<string | null> {
	const session = await getSsoNonceStorage().getSession(
		request.headers.get('Cookie'),
	)
	return session.get(NONCE_KEY) as string | null
}

/**
 * Create headers with the nonce cookie
 */
export async function createNonceHeaders(
	request: Request,
	nonce: string,
): Promise<Headers> {
	const cookieHeader = await storeNonce(request, nonce)
	const headers = new Headers()
	headers.set('Set-Cookie', cookieHeader)
	return headers
}

/**
 * Validate a nonce from an ID token against the stored nonce
 */
export async function validateNonce(
	request: Request,
	idTokenNonce: string | undefined,
): Promise<{
	valid: boolean
	error?: string
	cookieHeader: string
}> {
	const { nonce: storedNonce, cookieHeader } = await consumeNonce(request)

	if (!storedNonce) {
		return {
			valid: false,
			error:
				'No nonce found in session. The authentication request may have expired.',
			cookieHeader,
		}
	}

	if (!idTokenNonce) {
		return {
			valid: false,
			error:
				'No nonce found in ID token. The identity provider may not support nonce validation.',
			cookieHeader,
		}
	}

	if (storedNonce !== idTokenNonce) {
		return {
			valid: false,
			error:
				'Nonce mismatch. This may indicate a replay attack or session issue.',
			cookieHeader,
		}
	}

	return {
		valid: true,
		cookieHeader,
	}
}
