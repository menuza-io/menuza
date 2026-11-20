import crypto from 'node:crypto'
import {
	CUSTOMER_APP_PIPELINE_TOKEN_MIN_LENGTH,
	customerAppBuildCallbackToken,
} from '@repo/common/customer-app'
import { getInstanceInfo } from '@repo/common/litefs'
import { assertSecretNotPlaceholder } from '@repo/security'
import { ENV } from 'varlock/env'

const INSECURE_SECRET_MARKERS = ['do-not-use-in-prod', 'change-me']

let warnedInsecureToken = false

function safeCompare(presented: string, expected: string) {
	const left = crypto.createHash('sha256').update(presented).digest()
	const right = crypto.createHash('sha256').update(expected).digest()
	return crypto.timingSafeEqual(left, right)
}

function unauthorized() {
	throw Response.json(
		{ error: 'Unauthorized' },
		{
			status: 401,
			headers: {
				'WWW-Authenticate': 'Bearer',
				'Cache-Control': 'no-store',
			},
		},
	)
}

async function assertPrimaryPipeline() {
	const { currentIsPrimary } = await getInstanceInfo()
	if (!currentIsPrimary) {
		throw Response.json(
			{ error: 'not_primary' },
			{
				status: 503,
				headers: {
					'Retry-After': '30',
					'Cache-Control': 'no-store',
				},
			},
		)
	}
}

/**
 * The configured CUSTOMER_APP_PIPELINE_TOKEN, or null when it must not be
 * accepted: too short, matches INTERNAL_COMMAND_TOKEN or the GitHub dispatch
 * token, or a development default in production.
 */
export function getUsableCustomerAppPipelineToken(): string | null {
	const token = ENV.CUSTOMER_APP_PIPELINE_TOKEN ?? ''
	const command = ENV.INTERNAL_COMMAND_TOKEN ?? ''
	const github = ENV.CUSTOMER_APP_BUILD_TOKEN ?? ''
	if (token.length < CUSTOMER_APP_PIPELINE_TOKEN_MIN_LENGTH) return null
	if (
		token === command ||
		token === github ||
		(token.length > 0 && command.length > 0 && safeCompare(token, command)) ||
		(token.length > 0 && github.length > 0 && safeCompare(token, github))
	) {
		return null
	}
	assertSecretNotPlaceholder('CUSTOMER_APP_PIPELINE_TOKEN', token)
	if (process.env.NODE_ENV === 'production') {
		const lower = token.toLowerCase()
		if (INSECURE_SECRET_MARKERS.some((marker) => lower.includes(marker))) {
			if (!warnedInsecureToken) {
				warnedInsecureToken = true
				console.error(
					'CUSTOMER_APP_PIPELINE_TOKEN is a development default; refusing pipeline requests until a real secret is set.',
				)
			}
			return null
		}
	}
	return token
}

export function readCustomerAppBuildIdHeader(request: Request): string {
	return request.headers.get('X-Customer-App-Build-Id')?.trim() ?? ''
}

/**
 * Build pipeline config reads. Uses its own secret so a leaked CI credential
 * cannot reach cron, provisioning or Admin commands.
 */
export async function requireCustomerAppPipelineAuth(_request: Request) {
	await assertPrimaryPipeline()
	const expected = getUsableCustomerAppPipelineToken()
	const header = _request.headers.get('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
	if (!expected || !presented || !safeCompare(presented, expected)) {
		unauthorized()
	}
}

/**
 * Status callback for one build. Bearer is an HMAC of the build id; the same id
 * must appear in `X-Customer-App-Build-Id`.
 */
export async function requireCustomerAppBuildCallbackAuth(request: Request) {
	await assertPrimaryPipeline()
	const buildId = readCustomerAppBuildIdHeader(request)
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) unauthorized()
	const expected = getUsableCustomerAppPipelineToken()
	const header = request.headers.get('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
	if (!expected || !presented) unauthorized()
	const wanted = customerAppBuildCallbackToken(buildId, expected)
	if (!safeCompare(presented, wanted)) unauthorized()
}