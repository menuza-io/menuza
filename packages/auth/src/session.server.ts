import { createCookieSessionStorage } from 'react-router'
import {
	operatorCookieName,
	operatorSessionCookieDomain,
} from '@repo/common/cookie-domain'
import { ENV } from './env.js'

if (!ENV.SESSION_SECRET) {
	throw new Error(
		'SESSION_SECRET environment variable is required but not set. ' +
			'Please add SESSION_SECRET to your .env file. ' +
			'Example: SESSION_SECRET=your-secret-key-here',
	)
}

const sessionSecrets = ENV.SESSION_SECRET.split(',').map((s) => s.trim())
if (sessionSecrets.length === 0 || sessionSecrets.some((s) => s.length === 0)) {
	throw new Error(
		'SESSION_SECRET must contain at least one non-empty secret. ' +
			'Example: SESSION_SECRET=your-secret-key-here',
	)
}

export const authSessionStorage = createCookieSessionStorage({
	cookie: {
		name: operatorCookieName('en_session'),
		sameSite: 'lax', // CSRF protection is advised if changing to 'none'
		path: '/',
		httpOnly: true,
		domain: operatorSessionCookieDomain(),
		secrets: sessionSecrets,
		secure: ENV.NODE_ENV === 'production',
	},
})

// we have to do this because every time you commit the session you overwrite it
// so we store the expiration time in the cookie and reset it every time we commit
const originalCommitSession = authSessionStorage.commitSession

Object.defineProperty(authSessionStorage, 'commitSession', {
	value: async function commitSession(
		...args: Parameters<typeof originalCommitSession>
	) {
		const [session, options] = args
		if (options?.maxAge) {
			session.set('expires', new Date(Date.now() + options.maxAge * 1000))
		}

		const finalExpires =
			'expires' in (options ?? {})
				? options?.expires
				: session.has('expires')
					? new Date(session.get('expires'))
					: undefined
		const setCookieHeader = await originalCommitSession(session, {
			...options,
			expires: finalExpires,
		})
		return setCookieHeader
	},
})
