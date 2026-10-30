import crypto from 'node:crypto'
import { createCookie } from 'react-router'
import { ENV } from 'varlock/env'
import { canvaEnv } from './env.server.ts'

/**
 * The OAuth hand-off to Canva and back: a signed, HttpOnly cookie holds the
 * state, the PKCE verifier and who started it, for ten minutes and only for
 * the callback path. The callback accepts it once, for the same signed-in
 * user, and the state in the URL must match.
 */

export type CanvaOAuthState = {
	state: string
	verifier: string
	userId: string
	orgSlug: string
}

function stateCookie() {
	const secrets = (ENV.SESSION_SECRET ?? '')
		.split(',')
		.map((secret) => secret.trim())
		.filter(Boolean)
	if (secrets.length === 0) throw new Error('SESSION_SECRET is required.')
	return createCookie('print_canva_oauth', {
		httpOnly: true,
		sameSite: 'lax',
		secure: canvaEnv('BASE_URL').startsWith('https:'),
		path: '/resources/print/canva',
		maxAge: 600,
		secrets,
	})
}

export function newOAuthState(): string {
	return crypto.randomBytes(24).toString('base64url')
}

export async function setCanvaOAuthState(value: CanvaOAuthState) {
	return stateCookie().serialize(value)
}

export async function readCanvaOAuthState(
	request: Request,
): Promise<CanvaOAuthState | null> {
	const value = (await stateCookie().parse(
		request.headers.get('Cookie'),
	)) as CanvaOAuthState | null
	if (
		!value ||
		typeof value.state !== 'string' ||
		typeof value.verifier !== 'string' ||
		typeof value.userId !== 'string' ||
		typeof value.orgSlug !== 'string'
	) {
		return null
	}
	return value
}

export async function clearCanvaOAuthState() {
	return stateCookie().serialize('', { maxAge: 0 })
}

/**
 * Constant-time comparison of the state echoed by Canva. The state is random
 * and of fixed length, so a length mismatch reveals nothing.
 */
export function sameState(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8')
	const right = Buffer.from(b, 'utf8')
	return left.length === right.length && crypto.timingSafeEqual(left, right)
}
