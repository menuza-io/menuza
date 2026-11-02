import crypto from 'node:crypto'
import { createCookie } from 'react-router'
import { ENV } from 'varlock/env'
import { type z } from 'zod'
import { readLiveEnv } from '#app/utils/env.server.ts'

/**
 * The browser half of an OAuth sign-in with another service (Meta, Canva,
 * the note integrations). Before sending the member to the provider, the App
 * keeps the state and who started the sign-in in a signed, HttpOnly cookie
 * that lives ten minutes and is sent only to the callback path. The callback
 * accepts the provider's answer only in that browser, for the same signed-in
 * member, when the state the provider echoes matches, and then clears the
 * cookie. A sign-in started in one browser cannot be finished in another, so
 * a link cannot make a member complete someone else's sign-in.
 */

const MAX_AGE_SECONDS = 600

export function createOAuthHandoff<
	T extends { state: string; userId: string },
>(options: {
	/** Cookie name, one per flow. */
	name: string
	/** The callback's path prefix: the browser sends the cookie nowhere else. */
	path: string
	/** What the cookie holds. Anything else reads as no hand-off. */
	schema: z.ZodType<T>
}) {
	function cookie() {
		const secrets = (ENV.SESSION_SECRET ?? '')
			.split(',')
			.map((secret) => secret.trim())
			.filter(Boolean)
		if (secrets.length === 0) throw new Error('SESSION_SECRET is required.')
		return createCookie(options.name, {
			httpOnly: true,
			sameSite: 'lax',
			secure: readLiveEnv('BASE_URL').startsWith('https:'),
			path: options.path,
			maxAge: MAX_AGE_SECONDS,
			secrets,
		})
	}

	return {
		/** The `Set-Cookie` value that starts the hand-off. */
		set(value: T): Promise<string> {
			return cookie().serialize(value)
		},
		/** The hand-off this browser started, or `null`. */
		async read(request: Request): Promise<T | null> {
			const value: unknown = await cookie().parse(request.headers.get('Cookie'))
			const parsed = options.schema.safeParse(value)
			return parsed.success ? parsed.data : null
		},
		/** The `Set-Cookie` value that ends it. */
		clear(): Promise<string> {
			return cookie().serialize('', { maxAge: 0 })
		},
	}
}

/** A fresh random state for one sign-in. */
export function newOAuthState(): string {
	return crypto.randomBytes(24).toString('base64url')
}

/**
 * Constant-time comparison of the state the provider echoed with the one kept
 * for this browser. The kept state is unguessable and travels in the
 * provider's URL anyway, so a length mismatch reveals nothing.
 */
export function sameState(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8')
	const right = Buffer.from(b, 'utf8')
	return left.length === right.length && crypto.timingSafeEqual(left, right)
}
