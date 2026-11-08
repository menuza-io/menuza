import crypto from 'node:crypto'
import { getDomainUrl } from '@repo/common'
import { and, db, eq, lt, Verification } from '@repo/database'
import {
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { createCookie } from 'react-router'
import { ENV } from 'varlock/env'
import { z } from 'zod'

export const passkeyCookie = createCookie('webauthn-challenge', {
	path: '/',
	sameSite: 'lax',
	httpOnly: true,
	maxAge: 60 * 60 * 2,
	secure: true,
	secrets: [ENV.SESSION_SECRET],
})

/**
 * Sign-in challenges are single-use and live server-side: the cookie holds
 * only an opaque id, and the action consumes the matching `Verification` row
 * with `DELETE ... RETURNING` before verifying. Replaying a captured request
 * (synced passkeys report a signCount of 0) therefore fails.
 */
export const AUTHENTICATION_CHALLENGE_TTL_MS = 5 * 60 * 1000
const AUTHENTICATION_CHALLENGE_TYPE = 'webauthn-authentication-challenge'

export const passkeyAuthCookie = createCookie('webauthn-auth-challenge', {
	path: '/',
	sameSite: 'lax',
	httpOnly: true,
	maxAge: AUTHENTICATION_CHALLENGE_TTL_MS / 1000,
	secure: true,
	secrets: [ENV.SESSION_SECRET],
})

function hashChallengeId(id: string) {
	return crypto.createHash('sha256').update(id).digest('hex')
}

export async function createAuthenticationChallenge(challenge: string) {
	const id = crypto.randomBytes(32).toString('base64url')
	const now = Date.now()
	// Opportunistic cleanup of challenges nobody used.
	await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.type, AUTHENTICATION_CHALLENGE_TYPE),
				lt(Verification.expiresAt, new Date(now)),
			),
		)
	await db.insert(Verification).values({
		type: AUTHENTICATION_CHALLENGE_TYPE,
		target: hashChallengeId(id),
		secret: challenge,
		algorithm: 'none',
		digits: 0,
		period: 0,
		charSet: '',
		expiresAt: new Date(now + AUTHENTICATION_CHALLENGE_TTL_MS),
	})
	return id
}

/** Returns the challenge once, or null when unknown, used or expired. */
export async function consumeAuthenticationChallenge(id: string) {
	const [row] = await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.type, AUTHENTICATION_CHALLENGE_TYPE),
				eq(Verification.target, hashChallengeId(id)),
			),
		)
		.returning({
			secret: Verification.secret,
			expiresAt: Verification.expiresAt,
		})
	if (!row || !row.expiresAt || row.expiresAt.getTime() < Date.now()) {
		return null
	}
	return row.secret
}

export const PasskeyCookieSchema = z.object({
	challenge: z.string(),
	userId: z.string(),
})

export const RegistrationResponseSchema = z.object({
	id: z.string(),
	rawId: z.string(),
	response: z.object({
		clientDataJSON: z.string(),
		attestationObject: z.string(),
		transports: z
			.array(
				z.enum([
					'ble',
					'cable',
					'hybrid',
					'internal',
					'nfc',
					'smart-card',
					'usb',
				]),
			)
			.optional(),
	}),
	authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
	clientExtensionResults: z.object({
		credProps: z
			.object({
				rk: z.boolean(),
			})
			.optional(),
	}),
	type: z.literal('public-key'),
}) satisfies z.ZodType<RegistrationResponseJSON>

const AuthenticationResponseSchema = z.object({
	id: z.string(),
	rawId: z.string(),
	response: z.object({
		clientDataJSON: z.string(),
		authenticatorData: z.string(),
		signature: z.string(),
		userHandle: z.string().optional(),
	}),
	type: z.literal('public-key'),
	clientExtensionResults: z.object({
		appid: z.boolean().optional(),
		credProps: z
			.object({
				rk: z.boolean().optional(),
			})
			.optional(),
		hmacCreateSecret: z.boolean().optional(),
	}),
}) satisfies z.ZodType<AuthenticationResponseJSON>

export const PasskeyLoginBodySchema = z.object({
	authResponse: AuthenticationResponseSchema,
	remember: z.boolean().default(false),
	redirectTo: z.string().nullable(),
})

export function getWebAuthnConfig(request: Request) {
	const url = new URL(getDomainUrl(request))

	return {
		rpName: url.hostname,
		rpID: url.hostname,
		origin: url.origin,
	} as const
}
