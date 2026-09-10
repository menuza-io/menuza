import pino from 'pino'
import { ENV } from './package-env.ts'
import type { Logger as PinoLogger } from 'pino'
import { getClientIp as extractClientIp } from '@repo/security'

/**
 * Centralized logger utility using Pino
 *
 * Features:
 * - Structured JSON logging
 * - Automatic sensitive data redaction
 * - Pretty printing in development
 * - Child loggers for context
 *
 * @example
 * ```typescript
 * import { logger } from './logger.server'
 *
 * // Basic logging
 * logger.info('User logged in')
 * logger.error({ err: error, userId }, 'Failed to process request')
 *
 * // Child logger with context
 * const requestLogger = logger.child({ requestId: '123', userId: 'user-456' })
 * requestLogger.info('Processing payment')
 * ```
 */

function readNodeEnv(): 'production' | 'development' | 'test' {
	try {
		return ENV.NODE_ENV
	} catch {
		const fromProcess = process.env.NODE_ENV
		if (
			fromProcess === 'development' ||
			fromProcess === 'test' ||
			fromProcess === 'production'
		) {
			return fromProcess
		}
		return 'production'
	}
}

const isDevelopment = readNodeEnv() === 'development'
const isTest = readNodeEnv() === 'test'

// Redact sensitive fields from logs - expanded for OAuth, SSO, and authentication patterns
const redactPaths = [
	// Password fields
	'*.password',
	'*.Password',
	'*.newPassword',
	'*.oldPassword',
	'*.confirmPassword',

	// Token fields
	'*.token',
	'*.Token',
	'*.accessToken',
	'*.access_token',
	'*.refreshToken',
	'*.refresh_token',
	'*.idToken',
	'*.id_token',
	'*.resetToken',
	'*.reset_token',
	'*.verificationToken',
	'*.verification_token',

	// Secret and API key fields
	'*.secret',
	'*.Secret',
	'*.clientSecret',
	'*.client_secret',
	'*.apiKey',
	'*.api_key',
	'*.apiSecret',
	'*.api_secret',
	'*.accessKey',
	'*.access_key',
	'*.secretKey',
	'*.secret_key',

	// Private keys and credentials
	'*.privateKey',
	'*.private_key',
	'*.encryptionKey',
	'*.encryption_key',
	'*.credentials',
	'*.credentials.*',

	// Session and auth headers
	'*.sessionId',
	'*.session_id',
	'*.cookie',
	'*.Cookie',
	'*.authorization',
	'*.Authorization',
	'req.headers.authorization',
	'req.headers.cookie',
	'res.headers["set-cookie"]',

	// SSO-specific fields
	'*.samlResponse',
	'*.saml_response',
	'*.assertion',
	'*.SAMLResponse',
	'*.code', // OAuth authorization codes

	// Financial and PII
	'*.creditCard',
	'*.credit_card',
	'*.cardNumber',
	'*.card_number',
	'*.cvv',
	'*.ssn',
	'*.socialSecurityNumber',
]

/**
 * Validate IP address format to prevent injection attacks
 */
function validateIpAddress(ip: string): string {
	if (!ip || ip === 'unknown') return 'unknown'

	const trimmed = ip.trim()

	// IPv4 validation
	const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
	const ipv4Match = trimmed.match(ipv4Regex)
	if (ipv4Match) {
		// Verify each octet is 0-255
		const octets = [ipv4Match[1]!, ipv4Match[2]!, ipv4Match[3]!, ipv4Match[4]!]
		const valid = octets.every((octet) => {
			const num = parseInt(octet, 10)
			return num >= 0 && num <= 255
		})
		return valid ? trimmed : 'invalid'
	}

	// IPv6 validation (basic check for valid characters and structure)
	const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/
	if (ipv6Regex.test(trimmed)) {
		return trimmed
	}

	// Compressed IPv6 (::)
	if (/^::1$|^([0-9a-fA-F]{0,4}::?)+[0-9a-fA-F]{0,4}$/.test(trimmed)) {
		return trimmed
	}

	return 'invalid'
}

/**
 * Sanitize URL to redact sensitive query parameters
 */
export function sanitizeUrl(url: string): string {
	try {
		const parsed = new URL(url)
		const sensitiveParams = [
			'token',
			'access_token',
			'accessToken',
			'refresh_token',
			'refreshToken',
			'password',
			'api_key',
			'apikey',
			'apiKey',
			'key',
			'session',
			'sessionId',
			'session_id',
			'secret',
			'code',
			'authorization',
			'reset_token',
			'resetToken',
			'verification_token',
			'client_secret',
			'clientSecret',
		]

		sensitiveParams.forEach((param) => {
			if (parsed.searchParams.has(param)) {
				parsed.searchParams.set(param, '[REDACTED]')
			}
		})

		return parsed.toString()
	} catch {
		return '[INVALID_URL]'
	}
}

/**
 * Create the base Pino logger instance
 */
const createLogger = (): PinoLogger => {
	const baseConfig: pino.LoggerOptions = {
		level: isTest ? 'silent' : isDevelopment ? 'debug' : 'info',
		redact: {
			paths: redactPaths,
			censor: '[REDACTED]',
		},
		formatters: {
			level: (label) => {
				return { level: label }
			},
			bindings: (bindings) => {
				return {
					pid: bindings.pid,
					hostname: bindings.hostname,
					node_version: process.version,
				}
			},
		},
		timestamp: pino.stdTimeFunctions.isoTime,
		// Serialize errors properly
		serializers: {
			err: pino.stdSerializers.err,
			error: pino.stdSerializers.err,
			req: pino.stdSerializers.req,
			res: pino.stdSerializers.res,
		},
	}

	// Use pretty printing in development with graceful fallback
	if (isDevelopment) {
		try {
			return pino({
				...baseConfig,
				transport: {
					target: 'pino-pretty',
					options: {
						colorize: true,
						translateTime: 'HH:MM:ss.l',
						ignore: 'pid,hostname,node_version',
						singleLine: false,
						messageFormat: '{msg}',
					},
				},
			})
		} catch (error) {
			console.warn(
				'pino-pretty not available, falling back to JSON logs:',
				error,
			)
			return pino(baseConfig)
		}
	}

	// Production: structured JSON
	return pino(baseConfig)
}

/**
 * Base logger instance
 */
export const logger = createLogger()

/**
 * Create a child logger with specific context
 * Useful for adding request IDs, user IDs, etc.
 *
 * @example
 * ```typescript
 * const requestLogger = createChildLogger({ requestId: req.headers['x-request-id'] })
 * requestLogger.info('Processing request')
 * ```
 */
export function createChildLogger(bindings: Record<string, any>) {
	return logger.child(bindings)
}

/**
 * Helper to sanitize IP addresses for privacy compliance
 * Masks the last octet of IPv4 addresses and last groups of IPv6
 */
export function sanitizeIpAddress(ip: string): string {
	if (!ip) return 'unknown'

	// IPv4: mask last octet
	const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/
	const ipv4Match = ip.match(ipv4Regex)
	if (ipv4Match) {
		// Verify valid octets
		const octets = [ipv4Match[1]!, ipv4Match[2]!, ipv4Match[3]!]
		const valid = octets.every((octet) => {
			const num = parseInt(octet, 10)
			return num >= 0 && num <= 255
		})
		return valid
			? `${ipv4Match[1]}.${ipv4Match[2]}.${ipv4Match[3]}.xxx`
			: 'unknown'
	}

	// IPv6: keep first 48 bits (first 3 groups), mask the rest
	// Handle both expanded and compressed notation
	const ipv6Parts = ip.split(':')
	if (ipv6Parts.length >= 3 && /^[0-9a-fA-F:]+$/.test(ip)) {
		// Take first 3 groups and mask the rest
		const prefix = ipv6Parts.slice(0, 3).join(':')
		return `${prefix}:xxxx:xxxx:xxxx:xxxx:xxxx`
	}

	// Handle compressed IPv6 (::)
	if (ip.includes('::')) {
		const parts = ip.split('::')
		if (parts[0]) {
			const prefix = parts[0].split(':').slice(0, 3).join(':')
			return prefix ? `${prefix}::xxxx:xxxx:xxxx` : '::xxxx:xxxx:xxxx'
		}
		return '::xxxx:xxxx:xxxx'
	}

	return 'unknown'
}

/**
 * Utility to extract and validate client IP from request headers
 */
export function getClientIp(request: Request): string {
	const rawIp = extractClientIp(request, { fallback: 'unknown' })

	// Validate IP to prevent injection attacks
	return validateIpAddress(rawIp)
}
