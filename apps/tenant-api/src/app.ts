import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { logger as honoLogger } from 'hono/logger'
import { installRequiredMessage } from '@repo/common/zod-defaults'
import { logger } from '@repo/observability'
import { withBackground } from './lib/background.ts'
import { errorLogFields } from './lib/error-log.ts'
import { consentBaseUrl } from './lib/email-consent.ts'
import { isAllowedAnalyticsOrigin, isPosOrigin } from './lib/origin.ts'
import { requestLoggingMiddleware } from './lib/request-logging.ts'
import { getNodeRegion } from './lib/region.ts'
import { analyticsRoutes } from './routes/analytics.ts'
import { homeInternalRoutes } from './routes/home-internal.ts'
import { authRoutes } from './routes/auth.ts'
import { shopRoutes } from './routes/shop.ts'
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
import {
	guestPhotoRoutes,
	guestPhotoTickRoutes,
} from './routes/guest-photos.ts'
import { menuAvailabilityEventRoutes } from './routes/menu-availability-events.ts'
import { menuPopularTickRoutes } from './routes/menu-popular-tick.ts'
import { operatorGuestPhotoRoutes } from './routes/operator-guest-photos.ts'
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
import { marketingAudienceRoutes } from './routes/operator-marketing-audiences.ts'
import { marketingSettingsRoutes } from './routes/operator-marketing-settings.ts'
import { marketingInternalRoutes } from './routes/marketing-internal.ts'
import {
	publicShortLinkRoutes,
	shortLinkOperatorRoutes,
} from './routes/short-links.ts'
import { funnelOperatorRoutes } from './routes/operator-funnel.ts'
import { photoTestOperatorRoutes } from './routes/operator-photo-tests.ts'
import { mailboxRoutes } from './routes/mailbox.ts'
import { emailDomainRoutes } from './routes/email-domains.ts'
import { alertTextRoutes } from './routes/alert-texts.ts'
import { phoneLookupRoutes } from './routes/phone-lookup.ts'
import { smsStatusWebhookRoutes } from './routes/sms-status.ts'
import { provisionRoutes } from './routes/provision.ts'
import { publicOrderRoutes } from './routes/orders.ts'
import { publicDeliveryRoutes } from './routes/delivery.ts'
import { orderSystemRoutes } from './routes/order-system.ts'
import { customerOrderRoutes } from './routes/customer-orders.ts'
import { pushRoutes } from './routes/push.ts'
import {
	smsInboundInternalRoutes,
	smsWebhookRoutes,
} from './routes/sms-webhook.ts'
import { subscriptionRoutes } from './routes/subscriptions.ts'
import { operatorOrderRoutes } from './routes/operator-orders.ts'
import { operatorQrRoutes } from './routes/operator-qr.ts'
import { operatorPeopleRoutes } from './routes/operator-people.ts'
import { operatorPosRoutes } from './routes/operator-pos.ts'
import { operatorPrintRoutes } from './routes/operator-print.ts'
import { printRoutes } from './routes/print.ts'
import { posRoutes } from './routes/pos.ts'
import { posInventoryRoutes } from './routes/pos-inventory.ts'
import { posKdsRoutes } from './routes/pos-kds.ts'
import { posOnlineOrdersRoutes } from './routes/pos-online-orders.ts'
import { posReservationsRoutes } from './routes/pos-reservations.ts'
import { posTimeclockRoutes } from './routes/pos-timeclock.ts'
import {
	publicVoiceRoutes,
	voiceOperatorRoutes,
	voiceSystemRoutes,
} from './routes/voice.ts'
import {
	reservationsInternalRoutes,
	reservationsTickRoutes,
	reservationsVoiceActionRoutes,
} from './routes/reservations-internal.ts'
import { reservationsOperatorRoutes } from './routes/reservations-operator.ts'
import { reservationsPaymentsInternalRoutes } from './routes/reservations-payments-internal.ts'
import { reservationsPublicRoutes } from './routes/reservations-public.ts'
import { inventoryTickRoutes } from './routes/inventory-tick.ts'
import { orderMessagesTickRoutes } from './routes/order-messages-tick.ts'
import { giftCardRoutes } from './routes/gift-cards.ts'
import { giftCardTickRoutes } from './routes/gift-cards-tick.ts'
import { loyaltyTickRoutes } from './routes/loyalty-tick.ts'
import { loyaltyRoutes } from './routes/loyalty.ts'
import { operatorDiscountRoutes } from './routes/operator-discounts.ts'
import { operatorGiftCardRoutes } from './routes/operator-gift-cards.ts'
import { operatorInventoryRoutes } from './routes/operator-inventory.ts'
import { operatorLoyaltyRoutes } from './routes/operator-loyalty.ts'
import { posGiftCardRoutes } from './routes/pos-gift-cards.ts'
import { posLoyaltyRoutes } from './routes/pos-loyalty.ts'

import { rateLimit } from './lib/rate-limit.ts'

// Routes return Zod's first issue message to the browser, so a missing field
// says "Required" here as it does in App and Admin.
installRequiredMessage()

/**
 * `emailLinks` is `not_configured` on a production node without a usable
 * `TENANT_API_URL`: it keeps serving, but skips every email that needs a
 * signed link (broadcasts, journey email steps, confirmations), so deploy
 * checks should treat it as a failure.
 */
function healthHandler(c: Context) {
	return c.json({
		status: 'ok',
		service: 'tenant-api',
		region: getNodeRegion(),
		emailLinks: consentBaseUrl() ? 'ok' : 'not_configured',
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

	// Background work started by a service (loyalty journeys) rides on the
	// request's waitUntil on Workers. Hono throws without a context (Node).
	app.use('*', (c, next) => {
		let waitUntil: ((task: Promise<unknown>) => void) | null = null
		try {
			const ctx = c.executionCtx
			waitUntil = (task) => ctx.waitUntil(task)
		} catch {
			/* Node: no execution context */
		}
		return waitUntil ? withBackground(waitUntil, next) : next()
	})

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
	const photoUploadBodyLimit = bodyLimit({
		maxSize: 10 * 1024 * 1024 + 256 * 1024,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	})
	const singleDocumentBodyLimit = bodyLimit({
		maxSize: 12 * 1024 * 1024,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	})
	const setupImportBodyLimit = bodyLimit({
		maxSize: 25 * 1024 * 1024,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	})
	app.use('*', (c, next) => {
		const path = c.req.path
		if (path === '/photos/upload') return photoUploadBodyLimit(c, next)
		if (path.startsWith('/api/')) return serviceBodyLimit(c, next)
		if (path === '/operator/inventory/setup/imports') {
			return setupImportBodyLimit(c, next)
		}
		if (
			path === '/operator/inventory/deliveries/invoice/read' ||
			/^\/operator\/inventory\/suppliers\/[^/]+\/price-list\/parse$/.test(path)
		) {
			return singleDocumentBodyLimit(c, next)
		}
		return publicBodyLimit(c, next)
	})

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
		// A Station till also runs the host stand: it calls the day-of-service
		// routes with a bearer token it minted at `/pos/reservations/token`.
		const posPath =
			c.req.path.startsWith('/pos/') ||
			c.req.path.startsWith('/operator/reservations/book/')
		const allowed = origin
			? (posPath && isPosOrigin(origin)) ||
				(await isAllowedAnalyticsOrigin(origin))
			: false

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
			// The till measures its clock skew from the server's Date header.
			if (posPath) {
				c.res.headers.set('Access-Control-Expose-Headers', 'Date')
			}
		}
	})

	app.use(
		'/operator/*',
		rateLimit('operator', { windowMs: 60 * 1000, maxRequests: 120 }),
	)
	// Order placement is the money path: throttle hard per IP, and never let a
	// receipt lookup become an enumeration vector.
	const orderCreateRateLimit = rateLimit('public-order-create', {
		windowMs: 60 * 1000,
		maxRequests: 12,
	})
	const orderReadRateLimit = rateLimit('public-order-reads', {
		windowMs: 60 * 1000,
		maxRequests: 240,
	})
	const orderRateLimitGate = async (c: Context, next: () => Promise<void>) => {
		// Starting a tab payment is a write on the money path too.
		if (
			c.req.method === 'POST' &&
			(c.req.path === '/orders' || c.req.path === '/orders/tab/pay')
		) {
			return orderCreateRateLimit(c, next)
		}
		// A receipt re-send is a read of one order by its capability, like the
		// receipt itself (and has its own durable per-order limit).
		if (
			c.req.method === 'GET' ||
			(c.req.method === 'POST' && c.req.path.endsWith('/resend-link'))
		) {
			return orderReadRateLimit(c, next)
		}
		await next()
	}
	app.use('/orders', orderRateLimitGate)
	app.use('/orders/*', orderRateLimitGate)
	// Address search + quotes hit a billable geocoder: per-IP limits here,
	// plus per-org hourly caps inside the routes.
	const deliveryPlacesRateLimit = rateLimit('public-delivery-places', {
		windowMs: 60 * 1000,
		maxRequests: 60,
	})
	const deliveryQuoteRateLimit = rateLimit('public-delivery-quote', {
		windowMs: 60 * 1000,
		maxRequests: 20,
	})
	app.use('/delivery/*', async (c, next) => {
		if (c.req.method === 'GET') return deliveryPlacesRateLimit(c, next)
		if (c.req.method === 'POST') return deliveryQuoteRateLimit(c, next)
		await next()
	})
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

	// POS terminals share a restaurant's NAT, so the per-IP ceiling is high.
	// Pairing codes are single use and 256 bits, so only bulk probing is throttled.
	app.use(
		'/pos/pair',
		rateLimit('pos-pair', { windowMs: 60 * 1000, maxRequests: 20 }),
	)
	app.use('/pos/*', rateLimit('pos', { windowMs: 60 * 1000, maxRequests: 600 }))
	// Printers poll every few seconds; a wrong password is refused before any work.
	app.use('/print/*', rateLimit('print', { windowMs: 60 * 1000, maxRequests: 600 }))

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

	// Provider webhooks for inbound text replies (#75). The signature is the
	// gate; this is only a burst ceiling.
	app.use(
		'/webhooks/sms/*',
		rateLimit('sms-webhook', { windowMs: 60 * 1000, maxRequests: 300 }),
	)
	app.use(
		'/webhooks/sms-status/*',
		rateLimit('sms-status-webhook', { windowMs: 60 * 1000, maxRequests: 300 }),
	)

	app.use(
		'/voice/*',
		rateLimit('public-voice-handoffs', {
			windowMs: 60 * 1000,
			maxRequests: 30,
		}),
	)

	// Customer loyalty calls need a customer token, so this is only a burst
	// ceiling. Guests at one restaurant share its network, so it is generous;
	// writes (quotes, member codes, approval decisions) get less, and
	// each also has a durable per-customer limit (`enforceLoyaltyLimit`).
	const loyaltyReadRateLimit = rateLimit('loyalty-reads', {
		windowMs: 60 * 1000,
		maxRequests: 240,
	})
	const loyaltyWriteRateLimit = rateLimit('loyalty-writes', {
		windowMs: 60 * 1000,
		maxRequests: 120,
	})
	// Every method but POST is a read (HEAD included), so none skips the limit.
	app.use('/loyalty/*', (c, next) =>
		c.req.method === 'POST'
			? loyaltyWriteRateLimit(c, next)
			: loyaltyReadRateLimit(c, next),
	)

	// The guest's own orders (#112) need a customer token; this is a burst ceiling.
	app.use(
		'/customer/*',
		rateLimit('customer-orders', { windowMs: 60 * 1000, maxRequests: 120 }),
	)
	// Device registration and preferences (#105): a phone registers a few times.
	app.use(
		'/push/*',
		rateLimit('guest-push', { windowMs: 60 * 1000, maxRequests: 60 }),
	)
	app.use(
		'/photos/*',
		rateLimit('guest-photos', { windowMs: 60 * 1000, maxRequests: 60 }),
	)

	// Gift cards: a balance check and a purchase are the guessable or abusable
	// calls, so they get their own tighter burst limit on top of the durable
	// per-address, per-customer and per-organization guess limits.
	const giftCardSensitiveRateLimit = rateLimit('gift-cards-sensitive', {
		windowMs: 60 * 1000,
		maxRequests: 30,
	})
	const giftCardReadRateLimit = rateLimit('gift-cards-reads', {
		windowMs: 60 * 1000,
		maxRequests: 240,
	})
	app.use('/gift-cards/*', (c, next) =>
		c.req.method === 'POST'
			? giftCardSensitiveRateLimit(c, next)
			: giftCardReadRateLimit(c, next),
	)

	app.get('/health', healthHandler)
	app.get('/api/health', healthHandler)

	app.route('/auth', authRoutes)
	app.route('/subscriptions', subscriptionRoutes)
	app.route('/shop', shopRoutes)
	app.route('/customer/orders', customerOrderRoutes)
	app.route('/push', pushRoutes)
	app.route('/forms', publicFormRoutes)
	app.route('/orders', publicOrderRoutes)
	app.route('/delivery', publicDeliveryRoutes)
	app.route('/analytics', analyticsRoutes)
	app.route('/api', provisionRoutes)
	app.route('/api', emailDomainRoutes)
	app.route('/api/forms', formSystemRoutes)
	app.route('/api/orders', orderSystemRoutes)
	app.route('/api/marketing', engagementSyncRoutes)
	app.route('/api/marketing', marketingInternalRoutes)
	app.route('/api/sms-inbound', smsInboundInternalRoutes)
	app.route('/webhooks/sms', smsWebhookRoutes)
	app.route('/webhooks/sms-status', smsStatusWebhookRoutes)
	app.route('/api/staff', staffTickRoutes)
	app.route('/api/journeys', journeySystemRoutes)
	app.route('/api/menu', menuAvailabilityEventRoutes)
	app.route('/api/menu/popular', menuPopularTickRoutes)
	app.route('/api/guest-photos', guestPhotoTickRoutes)
	app.route('/photos', guestPhotoRoutes)
	app.route('/operator/photos', operatorGuestPhotoRoutes)
	app.route('/api/voice', voiceSystemRoutes)
	app.route('/api/alert-texts', alertTextRoutes)
	app.route('/api/phone-lookup', phoneLookupRoutes)
	app.route('/voice', publicVoiceRoutes)
	app.route('/operator', operatorRoutes)
	app.route('/operator/forms', formOperatorRoutes)
	app.route('/operator/mailbox', mailboxRoutes)
	app.route('/operator/funnel', funnelOperatorRoutes)
	app.route('/operator/photo-tests', photoTestOperatorRoutes)
	app.route('/operator/journeys', journeyOperatorRoutes)
	app.route('/operator/marketing/audiences', marketingAudienceRoutes)
	app.route('/operator/marketing/settings', marketingSettingsRoutes)
	app.route('/operator/marketing/short-links', shortLinkOperatorRoutes)
	app.route('/short-links', publicShortLinkRoutes)
	app.route('/operator/orders', operatorOrderRoutes)
	app.route('/operator/qr', operatorQrRoutes)
	app.route('/operator/people', operatorPeopleRoutes)
	app.route('/operator/pos/printers', operatorPrintRoutes)
	app.route('/operator/pos', operatorPosRoutes)
	app.route('/operator/calls', voiceOperatorRoutes)
	app.route('/operator/staff', staffOperatorRoutes)
	app.route('/operator/timeclock', timeclockOperatorRoutes)
	app.route('/operator/schedule', scheduleOperatorRoutes)
	app.route('/operator/labor', laborRoutes)
	app.route('/operator/hiring', hiringOperatorRoutes)
	app.route('/careers', careersRoutes)
	app.route('/internal/staff', staffInternalRoutes)
	app.route('/internal/home', homeInternalRoutes)
	app.route('/kiosk', kioskRoutes)
	app.route('/print', printRoutes)
	app.route('/pos/timeclock', posTimeclockRoutes)
	app.route('/pos/inventory', posInventoryRoutes)
	app.route('/pos/reservations', posReservationsRoutes)
	app.route('/pos/kds', posKdsRoutes)
	app.route('/pos/online-orders', posOnlineOrdersRoutes)
	app.route('/pos', posRoutes)
	app.route('/schedule-link', scheduleLinkRoutes)
	app.route('/operator/reservations', reservationsOperatorRoutes)
	app.route('/reservations', reservationsPublicRoutes)
	app.route('/internal/reservations', reservationsInternalRoutes)
	app.route('/api/reservations/payments', reservationsPaymentsInternalRoutes)
	app.route('/api/reservations', reservationsTickRoutes)
	app.route('/api/loyalty', loyaltyTickRoutes)
	app.route('/api/gift-cards', giftCardTickRoutes)
	app.route('/api/inventory', inventoryTickRoutes)
	app.route('/api/order-messages', orderMessagesTickRoutes)
	app.route('/loyalty', loyaltyRoutes)
	app.route('/operator/loyalty', operatorLoyaltyRoutes)
	app.route('/operator/discounts', operatorDiscountRoutes)
	app.route('/operator/inventory', operatorInventoryRoutes)
	app.route('/pos/loyalty', posLoyaltyRoutes)
	app.route('/gift-cards', giftCardRoutes)
	app.route('/operator/gift-cards', operatorGiftCardRoutes)
	app.route('/pos/gift-cards', posGiftCardRoutes)
	app.route('/api/voice/actions', reservationsVoiceActionRoutes)

	app.notFound((c) => {
		return c.json({ error: 'Endpoint Not Found' }, 404)
	})

	app.onError((err, c) => {
		logger.error(
			{
				...errorLogFields(err),
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
