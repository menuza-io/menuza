import { AsyncLocalStorage } from 'node:async_hooks'
import { isCiRuntime } from './runtime-env.js'
import { randomUUID } from 'node:crypto'
import { logger } from './logger.server.js'

/**
 * Request context that is propagated through async operations using AsyncLocalStorage.
 * This allows accessing request-specific data anywhere in the call stack without
 * explicitly passing it through every function.
 */
export interface RequestContext {
	/** Unique identifier for this request */
	requestId: string
	/** Wide event instance for accumulating context throughout the request */
	wideEvent: WideEventBuilder
	/** Start time of the request in milliseconds */
	startTime: number
	/** Additional context that can be added throughout the request */
	extra: Record<string, unknown>
}

/**
 * Wide Event builder that accumulates context throughout a request lifecycle.
 * Instead of emitting multiple log lines, context is collected and emitted once
 * at request completion.
 *
 * @example
 * ```typescript
 * const event = getRequestContext()?.wideEvent
 * event?.addContext({ userId: 'user-123', organizationId: 'org-456' })
 * event?.addContext({ cartItemCount: 3, paymentMethod: 'stripe' })
 * // Single log emitted at request end with all context
 * ```
 */
export class WideEventBuilder {
	private context: Record<string, unknown> = {}
	private readonly requestId: string
	private readonly startTime: number

	constructor(requestId: string) {
		this.requestId = requestId
		this.startTime = Date.now()
	}

	/**
	 * Add context to the wide event. Can be called multiple times;
	 * context is merged (later calls override earlier values for same keys).
	 */
	addContext(data: Record<string, unknown>): this {
		Object.assign(this.context, data)
		return this
	}

	/**
	 * Get a copy of the current accumulated context
	 */
	getContext(): Record<string, unknown> {
		return { ...this.context }
	}

	/**
	 * Emit the wide event log. Called once at request completion.
	 * @param finalData - Final data to include (status code, duration, etc.)
	 */
	emit(finalData: {
		statusCode: number
		method: string
		path: string
		error?: Error | unknown
	}): void {
		const durationMs = Date.now() - this.startTime

		const event = {
			// Core request identifiers
			requestId: this.requestId,
			timestamp: new Date().toISOString(),

			// HTTP request details
			method: finalData.method,
			path: finalData.path,
			statusCode: finalData.statusCode,
			durationMs,

			// Outcome classification
			outcome:
				finalData.statusCode >= 500
					? 'error'
					: finalData.statusCode >= 400
						? 'client_error'
						: 'success',

			// All accumulated context
			...this.context,
		}

		if (isCiRuntime()) {
			// Do not log anything on CI/CD while running E2E tests!
		} else if (finalData.error) {
			logger.error(
				{ ...event, err: finalData.error },
				'Request completed with error',
			)
		} else if (finalData.statusCode >= 500) {
			logger.error(event, 'Request completed with server error')
		} else if (finalData.statusCode >= 400) {
			logger.warn(event, 'Request completed with client error')
		} else if (durationMs > 2000) {
			logger.warn(event, 'Slow request completed')
		} else {
			logger.info(event, 'Request completed')
		}
	}
}

/**
 * AsyncLocalStorage instance for request context propagation.
 * This allows accessing the current request's context from anywhere
 * in the async call stack.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>()

/**
 * Get the current request context. Returns undefined if called outside
 * of a request context (e.g., during startup or in background jobs).
 */
export function getRequestContext(): RequestContext | undefined {
	return requestContextStorage.getStore()
}

/**
 * Get the current wide event builder. Convenience function.
 */
export function getWideEvent(): WideEventBuilder | undefined {
	return getRequestContext()?.wideEvent
}

/**
 * Add context to the current request's wide event.
 * Safe to call even if there's no request context (will be a no-op).
 *
 * @example
 * ```typescript
 * addWideEventContext({ userId: user.id, subscriptionTier: user.plan })
 * ```
 */
export function addWideEventContext(data: Record<string, unknown>): void {
	getWideEvent()?.addContext(data)
}

/**
 * Run a function within a request context.
 * This sets up the AsyncLocalStorage with a new request context
 * and wide event builder.
 *
 * @param requestId - The request ID (use existing from headers or generate new)
 * @param fn - The function to run within the context
 * @returns The result of the function
 */
export function runWithRequestContext<T>(
	requestId: string | undefined,
	fn: () => T,
): T {
	const id = requestId || randomUUID()
	const context: RequestContext = {
		requestId: id,
		wideEvent: new WideEventBuilder(id),
		startTime: Date.now(),
		extra: {},
	}
	return requestContextStorage.run(context, fn)
}

/**
 * Generate a new request ID
 */
export function generateRequestId(): string {
	return randomUUID()
}
