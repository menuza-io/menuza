import type { Request, Response, NextFunction } from 'express'
import { ENV } from './package-env.js'
import { getRuntimeDeploymentId, getRuntimeRegion } from './runtime-env.js'
import {
	runWithRequestContext,
	getRequestContext,
	addWideEventContext,
} from './request-context.js'

/**
 * Express middleware options for wide event logging
 */
export interface WideEventMiddlewareOptions {
	/**
	 * Paths to skip logging for (e.g., health checks, static assets)
	 * Supports glob-like patterns with *
	 */
	skipPaths?: string[]

	/**
	 * Header name to extract request ID from (default: 'x-request-id')
	 */
	requestIdHeader?: string

	/**
	 * Header name to extract trace ID from (default: 'x-trace-id')
	 */
	traceIdHeader?: string

	/**
	 * Service name to include in logs
	 */
	serviceName?: string

	/**
	 * Service version to include in logs
	 */
	serviceVersion?: string
}

/**
 * Express middleware that wraps requests in a Wide Event context.
 *
 * Features:
 * - Creates AsyncLocalStorage context for each request
 * - Generates or extracts request ID
 * - Emits a single structured "wide event" log at request completion
 * - Captures duration, status code, and all accumulated context
 *
 * @example
 * ```typescript
 * import { wideEventMiddleware } from '@repo/observability'
 *
 * app.use(wideEventMiddleware({
 *   serviceName: 'api',
 *   serviceVersion: '1.0.0',
 *   skipPaths: ['/health', '/assets/*']
 * }))
 * ```
 */
export function wideEventMiddleware(
	options: WideEventMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
	const {
		skipPaths = [
			'/api/health',
			'/resources/healthcheck',
			'/health',
			'/assets/*',
			'/favicons/*',
		],
		requestIdHeader = 'x-request-id',
		traceIdHeader = 'x-trace-id',
		serviceName = ENV.SERVICE_NAME || 'unknown',
		serviceVersion = ENV.SERVICE_VERSION ||
			process.env.npm_package_version ||
			'unknown',
	} = options

	return (req: Request, res: Response, next: NextFunction): void => {
		// Skip logging for specified paths
		const path = req.path || req.url
		const shouldSkip = skipPaths.some((pattern) => {
			if (pattern.includes('*')) {
				const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
				return regex.test(path)
			}
			return path === pattern || path.startsWith(pattern)
		})

		if (shouldSkip) {
			next()
			return
		}

		// Get or generate request ID
		const requestId = req.get(requestIdHeader) || undefined
		const traceId = req.get(traceIdHeader) || undefined

		// Run the request within a Wide Event context
		runWithRequestContext(requestId, () => {
			const ctx = getRequestContext()
			if (!ctx) {
				next()
				return
			}

			// Set response header for request correlation
			res.setHeader('x-request-id', ctx.requestId)

			// Add initial request context
			addWideEventContext({
				// Service info
				service: serviceName,
				version: serviceVersion,
				region: getRuntimeRegion(),
				deploymentId: getRuntimeDeploymentId(),

				// Request info
				...(traceId && { traceId }),
				ip: req.get('cf-connecting-ip') || req.ip || undefined,
				userAgent: req.get('user-agent'),
				referer: req.get('referer'),

				// This will be enriched later with user/org context
			})

			// Track if we've already emitted the wide event to prevent duplicates
			// (both 'finish' and 'error' can fire, or 'close' can fire for aborted requests)
			let hasEmitted = false

			const emitOnce = (error?: unknown) => {
				if (hasEmitted) return
				hasEmitted = true

				const emitData: {
					method: string
					path: string
					statusCode: number
					error?: unknown
				} = {
					method: req.method,
					path: path,
					statusCode: res.statusCode || 500,
				}

				if (error !== undefined) {
					emitData.error = error
				}

				ctx.wideEvent.emit(emitData)
			}

			// Emit wide event when response finishes
			res.on('finish', () => emitOnce())

			// Handle client disconnection (aborted/closed connections)
			res.on('close', () => {
				if (!res.writableFinished) {
					// Response was closed before finishing - client likely disconnected
					ctx.wideEvent.addContext({ connectionAborted: true })
					emitOnce()
				}
			})

			// Handle errors
			res.on('error', (error) => emitOnce(error))

			next()
		})
	}
}

/**
 * Helper to add user context to the current request's wide event.
 * Call this after authentication to enrich logs with user info.
 *
 * @example
 * ```typescript
 * // In your auth middleware or loader
 * addUserContext({
 *   userId: user.id,
 *   organizationId: org.id,
 *   subscriptionTier: org.plan,
 *   userRole: membership.role,
 * })
 * ```
 */
export function addUserContext(context: {
	userId?: string
	organizationId?: string
	subscriptionTier?: string
	userRole?: string
	userEmail?: string // Will be partially redacted in logs
}): void {
	const { userEmail, ...rest } = context

	addWideEventContext({
		...rest,
		// Redact email to show only domain
		...(userEmail && { userEmailDomain: userEmail.split('@')[1] }),
	})
}

/**
 * Helper to add error context to the current request's wide event.
 *
 * @example
 * ```typescript
 * try {
 *   await processPayment()
 * } catch (error) {
 *   addErrorContext(error, { paymentMethod: 'stripe' })
 *   throw error
 * }
 * ```
 */
/**
 * Sanitizes a stack trace to remove sensitive information.
 * In production, removes absolute file paths and potentially sensitive patterns.
 */
function sanitizeStackTrace(stack: string): string {
	const isProduction = ENV.NODE_ENV === 'production'

	if (!isProduction) {
		return stack
	}

	return (
		stack
			// Remove absolute file paths (Unix and Windows)
			.replace(/\/[^\s:]+\//g, './')
			.replace(/[A-Za-z]:\\[^\s:]+\\/g, '.\\')
			// Remove home directory references
			.replace(/\/Users\/[^/]+\//g, '~/')
			.replace(/\/home\/[^/]+\//g, '~/')
			// Remove node_modules internal paths for brevity
			.replace(/node_modules\/[^\s:]+/g, 'node_modules/...')
			// Limit stack trace depth in production
			.split('\n')
			.slice(0, 10)
			.join('\n')
	)
}

export function addErrorContext(
	error: unknown,
	additionalContext?: Record<string, unknown>,
): void {
	const errorInfo: Record<string, unknown> = {
		errorType: error instanceof Error ? error.name : 'UnknownError',
		errorMessage: error instanceof Error ? error.message : String(error),
		...(error instanceof Error &&
			error.stack && { errorStack: sanitizeStackTrace(error.stack) }),
		...additionalContext,
	}

	addWideEventContext(errorInfo)
}
