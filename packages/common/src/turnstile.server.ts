export const TURNSTILE_SITEVERIFY_URL =
	'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export type TurnstileSiteverifyResponse = {
	success: boolean
	action?: string
	hostname?: string
	'error-codes'?: string[]
}

export type VerifyTurnstileOptions = {
	secret: string
	token: string
	remoteIp?: string | null
	expectedAction?: string
	expectedHostnames?: ReadonlySet<string>
	timeoutMs?: number
}

export function parseTurnstileHostnames(raw: string | undefined) {
	return new Set(
		(raw ?? '')
			.split(',')
			.map((hostname) => hostname.trim().toLowerCase())
			.filter(Boolean),
	)
}

export function isTurnstileConfigured(secret: string | undefined) {
	return Boolean(secret?.trim())
}

export async function verifyTurnstileToken(
	options: VerifyTurnstileOptions,
): Promise<TurnstileSiteverifyResponse> {
	const { secret, token, remoteIp, expectedAction, expectedHostnames } = options
	if (!secret.trim()) {
		return { success: false, 'error-codes': ['missing-secret'] }
	}
	if (!token || token.length > 2048) {
		return { success: false, 'error-codes': ['invalid-token'] }
	}

	const body = new URLSearchParams({
		secret,
		response: token,
	})
	if (remoteIp) body.set('remoteip', remoteIp)

	let response: Response
	try {
		response = await fetch(TURNSTILE_SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		})
	} catch {
		return { success: false, 'error-codes': ['siteverify-unavailable'] }
	}

	if (!response.ok) {
		return { success: false, 'error-codes': ['siteverify-http-error'] }
	}

	const result = (await response
		.json()
		.catch(() => null)) as TurnstileSiteverifyResponse | null
	if (!result?.success) return result ?? { success: false }

	if (expectedAction && result.action !== expectedAction) {
		return { success: false, 'error-codes': ['action-mismatch'] }
	}

	const hostname = result.hostname?.trim().toLowerCase()
	if (expectedHostnames && expectedHostnames.size > 0) {
		if (!hostname || !expectedHostnames.has(hostname)) {
			return { success: false, 'error-codes': ['hostname-mismatch'] }
		}
	}

	return result
}
