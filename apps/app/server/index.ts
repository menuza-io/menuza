import 'varlock/auto-load'

import { styleText } from 'node:util'
import { helmet } from '@nichtsam/helmet/node-http'
import { logger, wideEventMiddleware } from '@repo/observability'
import { ip as ipAddress } from 'address'
import closeWithGrace from 'close-with-grace'
import compression from 'compression'
import express from 'express'
import rateLimit from 'express-rate-limit'
import getPort, { portNumbers } from 'get-port'
import { ENV } from 'varlock/env'

const MODE = ENV.NODE_ENV
const IS_PROD = MODE === 'production'
const IS_DEV = MODE === 'development'
const ALLOW_INDEXING = ENV.ALLOW_INDEXING !== false
const BUILD_PATH = '../build/server/index.js'

const app = express()

// ✅ EARLY CORS + LOGGING MIDDLEWARE
app.use((req, res, next) => {
	const origin = req.get('Origin')
	const allowedOrigins = IS_DEV
		? [
				'http://localhost:8081',
				'http://localhost:8082',
				'http://localhost:19006', // Default Expo web port
			]
		: []

	// Only set CORS headers if origin is explicitly allowed
	if (origin && allowedOrigins.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin)
		res.header(
			'Access-Control-Allow-Methods',
			'GET, POST, PUT, DELETE, OPTIONS',
		)
		res.header(
			'Access-Control-Allow-Headers',
			'Origin, Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers, Authorization, bypass-tunnel-reminder, X-PostHog-Distinct-ID, X-PostHog-Session-ID',
		)
		res.header('Access-Control-Allow-Credentials', 'true')
	}

	if (req.method === 'OPTIONS') {
		return res.sendStatus(204)
	}

	next()
})

// Only the Host header is trusted for the HTTPS redirect target:
// X-Forwarded-Host is client-controllable and would make the redirect open.
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i
const getHost = (req: { get: (key: string) => string | undefined }) => {
	const host = req.get('host') ?? ''
	return HOST_PATTERN.test(host) ? host : ''
}

// Cloudflare is our proxy
app.set('trust proxy', true)

// ensure HTTPS only (X-Forwarded-Proto comes from Cloudflare)
app.use((req, res, next) => {
	if (req.method !== 'GET') return next()
	const proto = req.get('X-Forwarded-Proto')
	const host = getHost(req)
	if (proto === 'http' && host) {
		res.set('X-Forwarded-Proto', 'https')
		res.redirect(`https://${host}${req.originalUrl}`)
		return
	}
	next()
})

/**
 * Normalize a request path for use in redirects.
 * Ensures the result is an absolute path on this host (no protocol or host).
 */
const normalizePathForRedirect = (path: string): string => {
	if (typeof path !== 'string') return '/'
	// Collapse repeated slashes and ensure a single leading slash.
	let normalized = path.replace(/\/+/g, '/')
	if (!normalized.startsWith('/')) {
		normalized = '/' + normalized
	}
	// Remove any NUL characters to avoid header splitting issues.

	normalized = normalized.replace(/\0/g, '')
	return normalized
}

// no ending slashes for SEO reasons
// https://github.com/mohammedzamakhan/epic-startup/discussions/108
app.get('*', (req, res, next) => {
	if (req.path.endsWith('/') && req.path.length > 1) {
		const query = req.url.slice(req.path.length)
		const rawPath = req.path.slice(0, -1)
		const safePath = normalizePathForRedirect(rawPath)
		let redirectTarget = safePath + query

		try {
			// Parse relative to a fixed origin to avoid accidentally creating an external URL.
			const url = new URL(redirectTarget, 'https://example.com')
			// Only use the path + search + hash components, keeping the redirect on this host.
			redirectTarget = url.pathname + url.search + url.hash
		} catch {
			redirectTarget = '/'
		}

		res.redirect(302, redirectTarget)
	} else {
		next()
	}
})

app.use(compression())

// http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
app.disable('x-powered-by')

// Then continue with general middleware handling
app.use((req, res, next) => {
	helmet(res, { general: { referrerPolicy: false } })
	next()
})

app.get(['/img/*', '/favicons/*'], (_req, res) => {
	// if we made it past the express.static for these, then we're missing something.
	// So we'll just send a 404 and won't bother calling other middleware.
	return res.status(404).send('Not found')
})

// Wide Event middleware - emits one structured log per request with full context
app.use(
	wideEventMiddleware({
		serviceName: 'app',
		serviceVersion: process.env.npm_package_version,
		skipPaths: [
			'/api/health',
			'/resources/healthcheck',
			'/resources/images/*',
			'/assets/*',
			'/favicons/*',
			'/img/*',
		],
	}),
)

// IP tracking and blacklist middleware
app.use(async (req, res, next) => {
	try {
		// Check if IP is blacklisted first
		const ipTracking = await import('@repo/common/ip-tracking')
		const ip = req.get('cf-connecting-ip') || req.ip || '127.0.0.1'

		const isBlacklisted = await ipTracking.isIpBlacklisted(ip)
		if (isBlacklisted) {
			return res.status(403).json({
				error: 'Access denied',
				message: 'Your IP address has been blocked due to suspicious activity.',
				code: 'IP_BLACKLISTED',
			})
		}
	} catch (error) {
		// If there's an error checking blacklist, log it but don't block the request
		logger.error({ err: error }, 'Error checking IP blacklist')
	}

	// Track the request after the response is finished
	res.on('finish', () => {
		// Track the request asynchronously
		setImmediate(async () => {
			try {
				const ipTracking = await import('@repo/common/ip-tracking')
				const ip = req.get('cf-connecting-ip') || req.ip || '127.0.0.1'
				await ipTracking.trackIpRequest({
					ip,
					method: req.method,
					path: req.path,
					userAgent: req.get('user-agent'),
					referer: req.get('referer'),
					statusCode: res.statusCode,
				})
			} catch (error) {
				// Silently fail to not break the app
				logger.error({ err: error }, 'IP tracking error')
			}
		})
	})

	next()
})

// Periodic cleanup of in-memory request counts (every 5 minutes)
setInterval(
	async () => {
		try {
			const ipTracking = await import('@repo/common/ip-tracking')
			ipTracking.cleanupRequestCounts()
		} catch (error) {
			logger.error({ err: error }, 'Error cleaning up request counts')
		}
	},
	5 * 60 * 1000,
)

// When running tests or running in development, we want to effectively disable
// rate limiting because playwright tests are very fast and we don't want to
// have to wait for the rate limit to reset between tests.
const maxMultiple =
	!IS_PROD || process.env.PLAYWRIGHT_TEST_BASE_URL ? 10_000 : 1
const rateLimitDefault = {
	windowMs: 60 * 1000,
	limit: 1000 * maxMultiple,
	standardHeaders: true,
	legacyHeaders: false,
	validate: { trustProxy: false },
	// Malicious users can spoof their IP address which means we should not default
	// to trusting req.ip when hosted behind a CDN. For Cloudflare, use cf-connecting-ip.
	keyGenerator: (req: express.Request) => {
		return req.get('cf-connecting-ip') ?? `${req.ip}`
	},
}

const strongestRateLimit = rateLimit({
	...rateLimitDefault,
	windowMs: 60 * 1000,
	limit: 10 * maxMultiple,
})

const strongRateLimit = rateLimit({
	...rateLimitDefault,
	windowMs: 60 * 1000,
	limit: 100 * maxMultiple,
})

const generalRateLimit = rateLimit(rateLimitDefault)
app.use((req, res, next) => {
	// MCP endpoints have their own rate limiting - skip express rate limiter
	if (req.path.startsWith('/mcp')) {
		return next()
	}

	const strongPaths = [
		'/login',
		'/signup',
		'/verify',
		'/admin',
		'/onboarding',
		'/reset-password',
		'/settings/profile',
		'/resources/login',
		'/resources/verify',
	]
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		if (strongPaths.some((p) => req.path.includes(p))) {
			return strongestRateLimit(req, res, next)
		}
		return strongRateLimit(req, res, next)
	}

	// the verify route is a special case because it's a GET route that
	// can have a token in the query string
	if (req.path.includes('/verify')) {
		return strongestRateLimit(req, res, next)
	}

	return generalRateLimit(req, res, next)
})

if (!ALLOW_INDEXING) {
	app.use((_, res, next) => {
		res.set('X-Robots-Tag', 'noindex, nofollow')
		next()
	})
}

if (IS_DEV) {
	console.log('Starting development server')
	const viteDevServer = await import('vite').then((vite) =>
		vite.createServer({
			server: { middlewareMode: true },
			// We tell Vite we are running a custom app instead of
			// the SPA default so it doesn't run HTML middleware
			appType: 'custom',
		}),
	)
	app.use(viteDevServer.middlewares)
	app.use(async (req, res, next) => {
		try {
			const source = await viteDevServer.ssrLoadModule('./server/app.ts')
			return await source.app(req, res, next)
		} catch (error) {
			if (typeof error === 'object' && error instanceof Error) {
				viteDevServer.ssrFixStacktrace(error)
			}
			next(error)
		}
	})
} else {
	console.log('Starting production server')
	// React Router fingerprints its assets so we can cache forever.
	app.use(
		'/assets',
		express.static('build/client/assets', {
			immutable: true,
			maxAge: '1y',
			fallthrough: false,
		}),
	)
	// Everything else (like favicon.ico) is cached for an hour. You may want to be
	// more aggressive with this caching.
	app.use(express.static('build/client', { maxAge: '1h' }))

	const { createRequestHandler } = await import('@react-router/express')
	const { serverBuildContext } = await import('../app/server-context.ts')
	const build = await import(BUILD_PATH)

	app.use(
		createRequestHandler({
			build,
			mode: MODE,
			getLoadContext: async () => {
				const RR = await new Function("return import('react-router')")()
				const ctx = new RR.RouterContextProvider()
				ctx.set(serverBuildContext, build)
				return ctx
			},
		}),
	)
}

const desiredPort = Number(process.env.PORT ?? 3001)
const portToUse = await getPort({
	port: portNumbers(desiredPort, desiredPort + 100),
})
const portAvailable = desiredPort === portToUse
if (!portAvailable && !IS_DEV) {
	logger.warn({ desiredPort, portToUse }, 'Port not available')
	process.exit(1)
}

const server = app.listen(portToUse, () => {
	if (!portAvailable) {
		logger.warn(
			{ desiredPort, portToUse },
			`Port ${desiredPort} is not available, using ${portToUse} instead`,
		)
		console.warn(
			styleText(
				'yellow',
				`⚠️  Port ${desiredPort} is not available, using ${portToUse} instead.`,
			),
		)
	}

	const localUrl = `http://localhost:${portToUse}`
	let lanUrl: string | null = null
	const localIp = ipAddress() ?? 'Unknown'
	// Check if the address is a private ip
	// https://en.wikipedia.org/wiki/Private_network#Private_IPv4_address_spaces
	// https://github.com/facebook/create-react-app/blob/d960b9e38c062584ff6cfb1a70e1512509a966e7/packages/react-dev-utils/WebpackDevServerUtils.js#LL48C9-L54C10
	if (/^10[.]|^172[.](1[6-9]|2[0-9]|3[0-1])[.]|^192[.]168[.]/.test(localIp)) {
		lanUrl = `http://${localIp}:${portToUse}`
	}

	logger.info(
		{ port: portToUse, localUrl, lanUrl, mode: MODE },
		'Server started successfully',
	)

	console.log(`🚀  We have liftoff!`)
	console.log(
		`
${styleText('bold', 'Local:')}            ${styleText('cyan', localUrl)}
${lanUrl ? `${styleText('bold', 'On Your Network:')}  ${styleText('cyan', lanUrl)}` : ''}
${styleText('bold', 'Press Ctrl+C to stop')}
		`.trim(),
	)
})

closeWithGrace(async ({ err }) => {
	if (typeof server !== 'undefined' && server) {
		await new Promise((resolve, reject) => {
			server.close((e) => (e ? reject(e) : resolve('ok')))
		})
	}
	if (err) {
		// Log to console first for immediate visibility
		console.error(styleText('red', String(err)))
		console.error(styleText('red', String(err.stack)))

		logger.fatal({ err }, 'Server shutting down with error')
	} else {
		logger.info('Server shutting down gracefully')
	}
})
