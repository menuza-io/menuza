import { t } from '@lingui/macro'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import { getClientIp } from '@repo/security'
import { readLiveEnv } from './env.server.ts'

/** Hidden input the Turnstile widget adds to the surrounding form. */
export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response'

/** Turnstile `action` names, checked against the siteverify response. */
export type OperatorTurnstileAction = 'login' | 'signup' | 'forgot-password'

/**
 * Turnstile is on only when both keys are set: a secret without a site key
 * would refuse every submission (no widget to produce a token), and a site key
 * without a secret has nothing to verify against.
 */
export function getOperatorTurnstileSiteKey(): string | null {
	const siteKey = readLiveEnv('TURNSTILE_SITE_KEY')
	const secret = readLiveEnv('TURNSTILE_SECRET_KEY')
	return siteKey && isTurnstileConfigured(secret) ? siteKey : null
}

export type TurnstileCheckResult = { ok: true } | { ok: false; error: string }

/**
 * Verifies the Turnstile token posted with an operator auth form. Call it
 * before checking credentials or creating anything. Passes when Turnstile is
 * not configured. A failure is a form error, never a thrown response.
 */
export async function checkOperatorTurnstile(
	request: Request,
	formData: FormData,
	action: OperatorTurnstileAction,
): Promise<TurnstileCheckResult> {
	if (!getOperatorTurnstileSiteKey()) return { ok: true }

	const token = formData.get(TURNSTILE_RESPONSE_FIELD)
	if (typeof token !== 'string' || !token.trim()) {
		return {
			ok: false,
			error: t`Complete the security check, then try again.`,
		}
	}

	const result = await verifyTurnstileToken({
		secret: readLiveEnv('TURNSTILE_SECRET_KEY'),
		token,
		remoteIp: getClientIp(request, { returnUndefined: true }),
		expectedAction: action,
		expectedHostnames: parseTurnstileHostnames(
			readLiveEnv('TURNSTILE_HOSTNAMES'),
		),
	})
	if (result.success) return { ok: true }

	return {
		ok: false,
		error: t`The security check failed. Please try again.`,
	}
}

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * CSP sources for the challenge (`frame-src`, `connect-src`, plus a
 * `script-src` fallback for browsers without `'strict-dynamic'`). Empty while
 * Turnstile is off.
 */
export function turnstileCspSources(): string[] {
	return getOperatorTurnstileSiteKey() ? [TURNSTILE_ORIGIN] : []
}
