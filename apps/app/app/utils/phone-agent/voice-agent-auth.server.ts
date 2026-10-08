import crypto from 'node:crypto'
import { ENV } from 'varlock/env'

const VOICE_AGENT_TOKEN_MIN_LENGTH = 32

// The committed .env.schema defaults all carry one of these markers.
const INSECURE_SECRET_MARKERS = ['do-not-use-in-prod', 'change-me']

let warnedInsecureToken = false

function safeCompare(presented: string, expected: string) {
	const left = crypto.createHash('sha256').update(presented).digest()
	const right = crypto.createHash('sha256').update(expected).digest()
	return crypto.timingSafeEqual(left, right)
}

/**
 * The configured VOICE_AGENT_TOKEN, or null when it must not be accepted:
 * shorter than 32 characters, or a development default in production.
 */
export function getUsableVoiceAgentToken(): string | null {
	const token = ENV.VOICE_AGENT_TOKEN ?? ''
	if (token.length < VOICE_AGENT_TOKEN_MIN_LENGTH) return null
	if (process.env.NODE_ENV === 'production') {
		const lower = token.toLowerCase()
		if (INSECURE_SECRET_MARKERS.some((marker) => lower.includes(marker))) {
			if (!warnedInsecureToken) {
				warnedInsecureToken = true
				console.error(
					'VOICE_AGENT_TOKEN is a development default; refusing voice-agent requests until a real secret is set.',
				)
			}
			return null
		}
	}
	return token
}

/**
 * Authenticates the voice-agent worker. Uses its own token (not
 * INTERNAL_COMMAND_TOKEN) so a leaked worker secret cannot reach cron,
 * provisioning, or cache routes. Throws a 401 JSON response, never a
 * redirect, because the caller is a machine.
 */
export function requireVoiceAgentAuth(request: Request) {
	const expected = getUsableVoiceAgentToken()
	const header = request.headers.get('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
	if (!expected || !presented || !safeCompare(presented, expected)) {
		throw Response.json(
			{ error: 'Unauthorized' },
			{ status: 401, headers: { 'Cache-Control': 'no-store' } },
		)
	}
}
