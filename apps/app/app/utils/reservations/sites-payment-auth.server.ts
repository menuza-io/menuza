import crypto from 'node:crypto'
import { ENV } from 'varlock/env'

const MIN_LENGTH = 32

// The committed .env.schema defaults all carry one of these markers.
const INSECURE_SECRET_MARKERS = ['do-not-use-in-prod', 'change-me']

let warned = false

function safeCompare(presented: string, expected: string) {
	const left = crypto.createHash('sha256').update(presented).digest()
	const right = crypto.createHash('sha256').update(expected).digest()
	return crypto.timingSafeEqual(left, right)
}

/**
 * The configured SITES_RESERVATION_PAYMENT_TOKEN, or null when it must not be
 * accepted: shorter than 32 characters, equal to any other platform token, or a
 * development default in production.
 */
export function getUsableSitesReservationPaymentToken(): string | null {
	const token = ENV.SITES_RESERVATION_PAYMENT_TOKEN ?? ''
	if (token.length < MIN_LENGTH) return null
	const others = [
		ENV.INTERNAL_COMMAND_TOKEN,
		ENV.VOICE_AGENT_TOKEN,
		ENV.TENANT_OPERATOR_TOKEN,
	]
	if (others.some((other) => other && other === token)) {
		if (!warned) {
			warned = true
			console.error(
				'SITES_RESERVATION_PAYMENT_TOKEN must differ from every other platform token; refusing Sites payment requests.',
			)
		}
		return null
	}
	if (process.env.NODE_ENV === 'production') {
		const lower = token.toLowerCase()
		if (INSECURE_SECRET_MARKERS.some((marker) => lower.includes(marker))) {
			if (!warned) {
				warned = true
				console.error(
					'SITES_RESERVATION_PAYMENT_TOKEN is a development default; refusing Sites payment requests until a real secret is set.',
				)
			}
			return null
		}
	}
	return token
}

/**
 * Authenticates the Sites worker on the two reservation payment routes only.
 * It is deliberately not INTERNAL_COMMAND_TOKEN, so a compromised Sites worker
 * cannot reach cron, provisioning or cache routes. Throws a 401 JSON response.
 */
export function requireSitesReservationPaymentAuth(request: Request) {
	const expected = getUsableSitesReservationPaymentToken()
	const header = request.headers.get('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
	if (!expected || !presented || !safeCompare(presented, expected)) {
		throw Response.json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'Cache-Control': 'no-store' } },
		)
	}
}
