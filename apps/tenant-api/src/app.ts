import { type Context, Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { logger } from '@repo/observability'
import { isAllowedAnalyticsOrigin } from './lib/origin.ts'
import { requestLoggingMiddleware } from './lib/request-logging.ts'
import { getNodeRegion } from './lib/region.ts'
import { analyticsRoutes } from './routes/analytics.ts'
import { authRoutes } from './routes/auth.ts'
import { shopRoutes } from './routes/shop.ts'
import { engagementSyncRoutes } from './routes/engagement-sync.ts'
import { formOperatorRoutes, publicFormRoutes } from './routes/forms.ts'
import {
	journeyOperatorRoutes,
	journeySystemRoutes,
} from './routes/journeys.ts'
import { operatorRoutes } from './routes/operator.ts'
import { provisionRoutes } from './routes/provision.ts'

import { rateLimit } from './lib/rate-limit.ts'

function healthHandler(c: Context) {
	return c.json({
		status: 'ok',
		service: 'tenant-api',
		region: getNodeRegion(),
		timestamp: new Date().toISOString(),
	})
}

/**
 * Shared Hono app for Node (OCI) and Durable Object (Cloudflare) runtimes.
 */
export function createTenantApiApp() {
	const app = new Hono()

	app.use('*', requestLoggingMiddleware())
	app.use('*', honoLogger())

	app.use('*', async (c, next) => {
		const origin = c.req.header('Origin')
		const allowed = origin ? await isAllowedAnalyticsOrigin(origin) : false

		if (c.req.method === 'OPTIONS') {
			if (!origin || !allowed) {
				return c.body(null, 403)
			}
			const reqHeaders = c.req.header('Access-Control-Request-Headers')
			return c.body(null, 204, {
				'Access-Control-Allow-Origin': origin,
				Vary: 'Origin',
				'Access-Control-Allow-Methods':
					'GET, POST, PATCH, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers':
					reqHeaders || 'Content-Type, Authorization',
				'Access-Control-Max-Age': '600',
			})
		}

		await next()

		if (origin && allowed) {
			c.res.headers.set('Access-Control-Allow-Origin', origin)
			c.res.headers.append('Vary', 'Origin')
		}
	})

	app.use(
		'/operator/*',
		rateLimit('operator', { windowMs: 60 * 1000, maxRequests: 120 }),
	)
	app.use(
		'/forms/*',
		rateLimit('public-forms', { windowMs: 60 * 60 * 1000, maxRequests: 30 }),
	)

	app.get('/health', healthHandler)
	app.get('/api/health', healthHandler)

	app.route('/auth', authRoutes)
	app.route('/shop', shopRoutes)
	app.route('/forms', publicFormRoutes)
	app.route('/analytics', analyticsRoutes)
	app.route('/api', provisionRoutes)
	app.route('/api/marketing', engagementSyncRoutes)
	app.route('/api/journeys', journeySystemRoutes)
	app.route('/operator', operatorRoutes)
	app.route('/operator/forms', formOperatorRoutes)
	app.route('/operator/journeys', journeyOperatorRoutes)

	app.notFound((c) => {
		return c.json({ error: 'Endpoint Not Found' }, 404)
	})

	app.onError((err, c) => {
		logger.error(
			{
				err,
				requestId: c.res.headers.get('x-request-id'),
				method: c.req.method,
				path: c.req.path,
			},
			'Unhandled error in tenant-api',
		)
		return c.json({ error: 'Internal Server Error' }, 500)
	})

	return app
}
