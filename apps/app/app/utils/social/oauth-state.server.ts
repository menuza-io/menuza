import crypto from 'node:crypto'
import { createCookie } from 'react-router'
import { ENV } from 'varlock/env'
import { socialEnv } from './env.server.ts'
import { isSocialPlatform, type SocialPlatform } from './platforms.ts'

/**
 * The OAuth hand-off to Meta and back: a signed, HttpOnly cookie holds the
 * state, the platform and who started it, for ten minutes and only for the
 * callback path. The callback accepts it once, for the same signed-in user,
 * and the state in the URL must match.
 */

export type MetaOAuthState = {
	state: string
	platform: SocialPlatform
	userId: string
	orgSlug: string
}

function stateCookie() {
	const secrets = (ENV.SESSION_SECRET ?? '')
		.split(',')
		.map((secret) => secret.trim())
		.filter(Boolean)
	if (secrets.length === 0) throw new Error('SESSION_SECRET is required.')
	return createCookie('social_meta_oauth', {
		httpOnly: true,
		sameSite: 'lax',
		secure: socialEnv('BASE_URL').startsWith('https:'),
		path: '/resources/social/meta',
		maxAge: 600,
		secrets,
	})
}

export function newOAuthState(): string {
	return crypto.randomBytes(24).toString('base64url')
}

export async function setMetaOAuthState(value: MetaOAuthState) {
	return stateCookie().serialize(value)
}

export async function readMetaOAuthState(
	request: Request,
): Promise<MetaOAuthState | null> {
	const value = (await stateCookie().parse(
		request.headers.get('Cookie'),
	)) as MetaOAuthState | null
	if (
		!value ||
		typeof value.state !== 'string' ||
		!isSocialPlatform(value.platform) ||
		typeof value.userId !== 'string' ||
		typeof value.orgSlug !== 'string'
	) {
		return null
	}
	return value
}

export async function clearMetaOAuthState() {
	return stateCookie().serialize('', { maxAge: 0 })
}

/** Constant-time comparison of the state echoed by Meta. */
export function sameState(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8')
	const right = Buffer.from(b, 'utf8')
	return left.length === right.length && crypto.timingSafeEqual(left, right)
}
