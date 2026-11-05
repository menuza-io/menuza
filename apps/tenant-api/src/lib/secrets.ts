import crypto from 'node:crypto'
import { resolveOperatorAnalyticsSecret } from '@repo/reports/token'
import { ENV, initVarlockEnv } from 'varlock/env'
import { bindAppService } from './app-service.ts'

// Keep in sync with packages/security/src/insecure-secret.ts (this node does
// not depend on that package). secrets.test.ts fails when the lists drift.
export const INSECURE_SECRET_MARKERS = [
	'your-jwt-secret',
	'do-not-use-in-prod',
	'change-me',
	'changeme',
	'super-duper-secret',
	'super-duper-s3cret',
	'super-duper-s3cr3t',
	'test-session-secret',
]

function isInsecureSecret(value: string) {
	const lower = value.toLowerCase()
	return INSECURE_SECRET_MARKERS.some((marker) => lower.includes(marker))
}

export function getBearerToken(header: string | null | undefined) {
	return header?.startsWith('Bearer ') ? header.substring(7) : ''
}

export function timingSafeEqualString(left: string, right: string) {
	const leftHash = crypto.createHash('sha256').update(left).digest()
	const rightHash = crypto.createHash('sha256').update(right).digest()
	return crypto.timingSafeEqual(leftHash, rightHash)
}

function ensureVarlockInit() {
	if (!(globalThis as any).__varlockLoadedEnv) {
		const config: Record<string, { value: unknown }> = {}
		if (typeof process !== 'undefined' && process.env) {
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) {
					config[key] = { value }
				}
			}
		}
		;(globalThis as any).__varlockLoadedEnv = {
			config,
			settings: { disableProcessEnvInjection: true },
		}
		initVarlockEnv({ allowFail: true })
	}
}

ensureVarlockInit()

export function syncEnvFromProcess() {
	if (typeof process !== 'undefined' && process.env) {
		const existingConfig = (globalThis as any).__varlockLoadedEnv?.config ?? {}
		const newConfig: Record<string, { value: unknown }> = { ...existingConfig }
		let changed = false
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && newConfig[key]?.value !== value) {
				newConfig[key] = { value }
				changed = true
			}
		}
		if (changed || !(globalThis as any).__varlockLoadedEnv) {
			;(globalThis as any).__varlockLoadedEnv = {
				...(globalThis as any).__varlockLoadedEnv,
				config: newConfig,
				settings: {
					disableProcessEnvInjection: true,
					...(globalThis as any).__varlockLoadedEnv?.settings,
				},
			}
			initVarlockEnv({ allowFail: true })
		}
	}
}

export function applyVarlockEnv(env: Record<string, unknown> | object) {
	ensureVarlockInit()
	// Every entry that receives `env` (Worker fetch, Durable Object fetch and
	// alarm) comes through here, so the App service binding is always current.
	bindAppService((env as { APP?: unknown }).APP)
	const existingConfig = (globalThis as any).__varlockLoadedEnv?.config ?? {}
	const newConfig: Record<string, { value: unknown }> = { ...existingConfig }
	if (typeof process !== 'undefined' && process.env) {
		for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
			if (typeof value === 'string' && process.env[key] === undefined) {
				process.env[key] = value
			}
		}
	}
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			newConfig[key] = { value: String(value) }
		}
	}
	;(globalThis as any).__varlockLoadedEnv = {
		...(globalThis as any).__varlockLoadedEnv,
		config: newConfig,
	}
	initVarlockEnv({ allowFail: true })
}

export function getOperatorToken() {
	syncEnvFromProcess()
	return ENV.TENANT_OPERATOR_TOKEN || ''
}

export function getInternalCommandToken() {
	syncEnvFromProcess()
	return ENV.INTERNAL_COMMAND_TOKEN || ''
}

/** The value committed in .env.schema. */
export const DEV_OPERATOR_ANALYTICS_TOKEN =
	'dev-operator-analytics-token-do-not-use-in-prod'

/**
 * Secret that signs operator analytics JWTs. Distinct from
 * INTERNAL_COMMAND_TOKEN so a leaked cron/provision token cannot mint tokens
 * that read calls, customers, orders, and wages. Empty when it is missing,
 * shared with the command token, or still the development default in production.
 */
export function getOperatorAnalyticsToken() {
	syncEnvFromProcess()
	// An unset NODE_ENV is production. The schema default must not sign reports.
	const nodeEnv =
		typeof process !== 'undefined' ? process.env.NODE_ENV : undefined
	return resolveOperatorAnalyticsSecret({
		secret: ENV.OPERATOR_ANALYTICS_TOKEN,
		internalCommandToken: getInternalCommandToken(),
		isPlaceholder: (token) =>
			token === DEV_OPERATOR_ANALYTICS_TOKEN || isInsecureSecret(token),
		placeholderAllowed: nodeEnv === 'development' || nodeEnv === 'test',
	})
}

export function getVoiceAgentToken() {
	syncEnvFromProcess()
	return ENV.VOICE_AGENT_TOKEN || ''
}

export const VOICE_AGENT_TOKEN_MIN_LENGTH = 32

/** The value committed in .env.schema and .dev.vars.example. */
export const DEV_VOICE_AGENT_TOKEN =
	'dev-voice-agent-token-do-not-use-in-prod-32b'

const loggedVoiceAgentTokenProblems = new Set<string>()

/**
 * Why VOICE_AGENT_TOKEN cannot be used, or null when it can. A token shared
 * with another secret would let whoever holds that secret act as the voice
 * worker (and vice versa), so reuse disables the voice routes outright.
 */
export function voiceAgentTokenProblem(): string | null {
	const token = getVoiceAgentToken()
	if (token.length < VOICE_AGENT_TOKEN_MIN_LENGTH) {
		return `VOICE_AGENT_TOKEN must be at least ${VOICE_AGENT_TOKEN_MIN_LENGTH} characters`
	}
	const others = {
		INTERNAL_COMMAND_TOKEN: getInternalCommandToken(),
		TENANT_OPERATOR_TOKEN: getOperatorToken(),
		JWT_SECRET: ENV.JWT_SECRET || '',
		AUTH_HMAC_SECRET: ENV.AUTH_HMAC_SECRET || '',
	}
	for (const [name, value] of Object.entries(others)) {
		if (value && timingSafeEqualString(token, value)) {
			return `VOICE_AGENT_TOKEN must differ from ${name}`
		}
	}
	if (
		(ENV as any).NODE_ENV === 'production' &&
		(token === DEV_VOICE_AGENT_TOKEN || isInsecureSecret(token))
	) {
		return 'VOICE_AGENT_TOKEN is using a development default'
	}
	return null
}

/** Logs each configuration problem once per process instead of per request. */
export function logVoiceAgentTokenProblem(problem: string) {
	if (loggedVoiceAgentTokenProblems.has(problem)) return
	loggedVoiceAgentTokenProblems.add(problem)
	console.error(`Voice agent routes are disabled: ${problem}`)
}

/** Timing-safe bearer check that fails closed when the secret is too short. */
export function bearerMatches(
	header: string | null | undefined,
	expected: string,
	minLength: number,
) {
	const presented = getBearerToken(header)
	if (expected.length < minLength || !presented) return false
	if ((ENV as any).NODE_ENV === 'production' && isInsecureSecret(expected)) {
		return false
	}
	return timingSafeEqualString(presented, expected)
}

export function assertTenantApiSecrets() {
	syncEnvFromProcess()
	const internalToken = getInternalCommandToken()
	const operatorToken = getOperatorToken()
	const jwtSecret = ENV.JWT_SECRET || ''
	const hmacSecret = ENV.AUTH_HMAC_SECRET || ''
	const isProd = (ENV as any).NODE_ENV === 'production'

	if (internalToken.length < 16) {
		throw new Error(
			'INTERNAL_COMMAND_TOKEN must be set to at least 16 characters',
		)
	}
	if (
		operatorToken.length < 16 ||
		(isProd && isInsecureSecret(operatorToken))
	) {
		throw new Error(
			'TENANT_OPERATOR_TOKEN is missing, too short, or using a default value',
		)
	}
	if (jwtSecret.length < 16 || (isProd && isInsecureSecret(jwtSecret))) {
		throw new Error(
			'JWT_SECRET is missing, too short, or using a default value',
		)
	}
	if (hmacSecret.length < 16 || (isProd && isInsecureSecret(hmacSecret))) {
		throw new Error(
			'AUTH_HMAC_SECRET is missing, too short, or using a default value',
		)
	}
	if (isProd && isInsecureSecret(internalToken)) {
		throw new Error('INTERNAL_COMMAND_TOKEN is using a development default')
	}
}

export function hmacHash(value: string) {
	syncEnvFromProcess()
	const hmacSecret = ENV.AUTH_HMAC_SECRET || ''
	if (hmacSecret.length < 16) {
		throw new Error('AUTH_HMAC_SECRET is not configured')
	}
	return crypto.createHmac('sha256', hmacSecret).update(value).digest('hex')
}
