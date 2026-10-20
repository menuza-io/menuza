import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { logger as honoLogger } from 'hono/logger'
import { logger } from '@repo/observability'
import { isAllowedAnalyticsOrigin } from './lib/origin.ts'
import { requestLoggingMiddleware } from './lib/request-logging.ts'
import { getNodeRegion } from './lib/region.ts'
import { analyticsRoutes } from './routes/analytics.ts'
import { authRoutes } from './routes/auth.ts'
import { shopRoutes } from './routes/shop.ts'
import { subscriptionRoutes } from './routes/subscriptions.ts'
import { engagementSyncRoutes } from './routes/engagement-sync.ts'
import {
	formOperatorRoutes,
	formSystemRoutes,
	publicFormRoutes,
} from './routes/forms.ts'
import {
	journeyOperatorRoutes,
	journeySystemRoutes,
} from './routes/journeys.ts'
import { staffOperatorRoutes } from './routes/staff.ts'
import { careersRoutes } from './routes/careers.ts'
import { hiringOperatorRoutes } from './routes/hiring.ts'
import { staffInternalRoutes } from './routes/staff-internal.ts'
import { staffTickRoutes } from './routes/staff-tick.ts'
import { scheduleLinkRoutes } from './routes/schedule-link.ts'
import { scheduleOperatorRoutes } from './routes/schedule.ts'
import { timeclockOperatorRoutes } from './routes/timeclock.ts'
import { kioskRoutes } from './routes/kiosk.ts'
import { laborRoutes } from './routes/labor.ts'
import { operatorRoutes } from './routes/operator.ts'
import { mailboxRoutes } from './routes/mailbox.ts'
import { provisionRoutes } from './routes/provision.ts'
import {
	publicVoiceRoutes,
	voiceOperatorRoutes,
	voiceSystemRoutes,
} from './routes/voice.ts'

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

	// Reject oversized bodies before any handler buffers them with c.req.json().
	// Service-to-service routes under /api carry transcripts, so get more room.
	const publicBodyLimit = bodyLimit({
		maxSize: 1024 * 1024,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	})
	const serviceBodyLimit = bodyLimit({
		maxSize: 8 * 1024 * 1024,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	})
	app.use('*', (c, next) =>
		c.req.path.startsWith('/api/')
			? serviceBodyLimit(c, next)
			: publicBodyLimit(c, next),
	)

	app.use('*', async (c, next) => {
		await next()
		c.res.headers.set('X-Content-Type-Options', 'nosniff')
		c.res.headers.set('Referrer-Policy', 'no-referrer')
		c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
		// Responses here carry PII and bearer tokens; never let a shared cache
		// or the browser disk cache keep them.
		if (!c.res.headers.has('Cache-Control')) {
			c.res.headers.set('Cache-Control', 'no-store')
		}
	})

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
	const publicFormReadRateLimit = rateLimit('public-form-reads', {
		windowMs: 60 * 1000,
		maxRequests: 120,
	})
	const publicFormSubmissionRateLimit = rateLimit('public-form-submissions', {
		windowMs: 60 * 60 * 1000,
		maxRequests: 30,
	})
	app.use('/forms/*', async (c, next) => {
		if (c.req.method === 'GET') return publicFormReadRateLimit(c, next)
		if (c.req.method === 'POST' && c.req.path.endsWith('/submissions')) {
			return publicFormSubmissionRateLimit(c, next)
		}
		await next()
	})

	// Kiosks sit behind a workplace's shared NAT, so the per-IP ceilings are
	// high; PIN guessing is limited per device by persisted backoff counters.
	// Pairing codes are single use and long, so only bulk probing is throttled.
	app.use(
		'/kiosk/pair',
		rateLimit('kiosk-pair', { windowMs: 60 * 1000, maxRequests: 20 }),
	)
	app.use(
		'/kiosk/*',
		rateLimit('kiosk', { windowMs: 60 * 1000, maxRequests: 600 }),
	)

	// The public application form: a person applies a few times at most. The
	// organization also enforces durable per-address and per-organization limits
	// in its own database (see `submitApplication`); this is the burst ceiling.
	app.use(
		'/careers/*',
		rateLimit('careers', { windowMs: 60 * 60 * 1000, maxRequests: 30 }),
	)

	// "My schedule" links are bearer credentials in a person's inbox: the secret
	// is 256 bits, so only bulk probing needs a ceiling. Staff share a
	// workplace's NAT, so the per-IP limit is generous.
	app.use(
		'/schedule-link/*',
		rateLimit('schedule-link', { windowMs: 60 * 1000, maxRequests: 240 }),
	)

	app.use(
		'/voice/*',
		rateLimit('public-voice-handoffs', {
			windowMs: 60 * 1000,
			maxRequests: 30,
		}),
	)

	app.get('/health', healthHandler)
	app.get('/api/health', healthHandler)

	app.route('/auth', authRoutes)
	app.route('/shop', shopRoutes)
	app.route('/subscriptions', subscriptionRoutes)
	app.route('/forms', publicFormRoutes)
	app.route('/analytics', analyticsRoutes)
	app.route('/api', provisionRoutes)
	app.route('/api/forms', formSystemRoutes)
	app.route('/api/marketing', engagementSyncRoutes)
	app.route('/api/staff', staffTickRoutes)
	app.route('/api/journeys', journeySystemRoutes)
	app.route('/api/voice', voiceSystemRoutes)
	app.route('/voice', publicVoiceRoutes)
	app.route('/operator', operatorRoutes)
	app.route('/operator/forms', formOperatorRoutes)
	app.route('/operator/mailbox', mailboxRoutes)
	app.route('/operator/journeys', journeyOperatorRoutes)
	app.route('/operator/calls', voiceOperatorRoutes)
	app.route('/operator/staff', staffOperatorRoutes)
	app.route('/operator/timeclock', timeclockOperatorRoutes)
	app.route('/operator/schedule', scheduleOperatorRoutes)
	app.route('/operator/labor', laborRoutes)
	app.route('/operator/hiring', hiringOperatorRoutes)
	app.route('/careers', careersRoutes)
	app.route('/internal/staff', staffInternalRoutes)
	app.route('/kiosk', kioskRoutes)
	app.route('/schedule-link', scheduleLinkRoutes)

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
