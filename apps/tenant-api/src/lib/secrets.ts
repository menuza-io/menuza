import crypto from 'node:crypto'
import { ENV, initVarlockEnv } from 'varlock/env'

const INSECURE_SECRET_MARKERS = [
	'your-jwt-secret',
	'do-not-use-in-prod',
	'change-me',
	'super-duper-secret',
	'super-duper-s3cr3t'
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
