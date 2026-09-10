import crypto from 'node:crypto'
import { ENV } from './package-env.js'
import { createCookieSessionStorage, type SessionStorage } from 'react-router'

import {
	operatorCookieName,
	operatorSessionCookieDomain,
} from '@repo/common/cookie-domain'

const IMPERSONATION_SESSION_TTL = 15 * 60 * 1000 // 15 minutes in milliseconds
export const IMPERSONATION_COOKIE_MAX_AGE = 15 * 60 // 15 minutes in seconds

function getImpersonationSecret(): string {
	const secret = ENV.IMPERSONATION_SESSION_SECRET || ENV.SESSION_SECRET
	if (!secret) {
		throw new Error(
			'IMPERSONATION_SESSION_SECRET or SESSION_SECRET environment variable is required',
		)
	}
	return secret
}

const impersonationSecrets = getImpersonationSecret()
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean)

if (impersonationSecrets.length === 0) {
	throw new Error(
		'Impersonation session secret must contain at least one non-empty secret',
	)
}

/**
 * Lazy factory — same reason as `authSessionStorage` in session.server.ts.
 * Must not evaluate `operatorSessionCookieDomain()` at module-load time in
 * Cloudflare Workers, because the worker `env` bindings (including BASE_URL)
 * are only available after the first `fetch()` call runs `applyWorkerEnv`.
 */
let _impersonationSessionStorage: SessionStorage | undefined

function getImpersonationSessionStorage(): SessionStorage {
	return (_impersonationSessionStorage ??= createCookieSessionStorage({
		cookie: {
			name: operatorCookieName('en_imp_session'),
			sameSite: 'lax',
			path: '/',
			httpOnly: true,
			domain: operatorSessionCookieDomain(),
			secrets: impersonationSecrets,
			secure: ENV.NODE_ENV === 'production',
		},
	}))
}

export const impersonationSessionStorage: SessionStorage = {
	getSession(...args) {
		return getImpersonationSessionStorage().getSession(...args)
	},
	commitSession(...args) {
		return getImpersonationSessionStorage().commitSession(...args)
	},
	destroySession(...args) {
		return getImpersonationSessionStorage().destroySession(...args)
	},
}

export const impersonationSessionKey = 'impersonationSessionId'

export function getImpersonationExpirationDate(): Date {
	return new Date(Date.now() + IMPERSONATION_SESSION_TTL)
}

export { getClientIp } from '@repo/security/ip-address.server'

export function hashIp(ip: string): string {
	const secret = getImpersonationSecret().split(',')[0] || ''
	return crypto.createHmac('sha256', secret).update(ip).digest('hex')
}
