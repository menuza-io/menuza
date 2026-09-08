import { type MiddlewareHandler } from 'hono'
import { ENV } from 'varlock/env'
import { generateRequestId, logger, runWithRequestContext } from '@repo/observability'

const SKIP_PATHS = new Set(['/health', '/api/health'])

export function requestLoggingMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		const path = c.req.path
		if (SKIP_PATHS.has(path)) {
			await next()
			return
		}

		const requestId =
			c.req.header('x-request-id')?.trim() || generateRequestId()
		const startedAt = Date.now()

		c.res.headers.set('x-request-id', requestId)

		await runWithRequestContext(requestId, async () => {
			try {
				await next()
			} catch (error) {
				logger.error(
					{
						err: error,
						requestId,
						method: c.req.method,
						path,
					},
					'Unhandled tenant-api request error',
				)
				throw error
			} finally {
				logger.info(
					{
						requestId,
						method: c.req.method,
						path,
						status: c.res.status,
						durationMs: Date.now() - startedAt,
						region: ENV.DATA_REGION ?? 'us',
					},
					'tenant-api request completed',
				)
			}
		})
	}
}
