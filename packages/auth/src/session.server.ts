import { createCookieSessionStorage, type SessionStorage } from 'react-router'
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

/**
 * Lazy factory — evaluated on first request so the Cloudflare Worker's
 * `applyWorkerEnv` has already patched `ENV.BASE_URL` from the wrangler
 * `vars` binding before `operatorSessionCookieDomain()` is called.
 *
 * If we evaluated this at module-load time, the varlock bundle default
 * (`https://app.epic-startup.test:2999`) would be used instead of the
 * production value, producing cookies with `Domain=.epic-startup.test`.
 */
let _authSessionStorage: SessionStorage | undefined

function getAuthSessionStorage(): SessionStorage {
	if (_authSessionStorage) return _authSessionStorage

	const storage = createCookieSessionStorage({
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
	const originalCommitSession = storage.commitSession

	Object.defineProperty(storage, 'commitSession', {
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

	_authSessionStorage = storage
	return storage
}

export const authSessionStorage: SessionStorage = {
	getSession(...args) {
		return getAuthSessionStorage().getSession(...args)
	},
	commitSession(...args) {
		return getAuthSessionStorage().commitSession(...args)
	},
	destroySession(...args) {
		return getAuthSessionStorage().destroySession(...args)
	},
}
