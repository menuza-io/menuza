import { Hono, type Context } from 'hono'

import {
	giftCardOrderRef as giftCardOrderRefOf,
	parseGiftCardOrderRef,
} from '@repo/common/gift-cards'
import { parseBalanceOrderRef, parseQuoteOrderRef } from '@repo/common/catering'
import { parseTabOrderRef } from '@repo/common/qr-ordering'
import {
	orderDisputeStatusRequestSchema,
	orderPaymentSessionRequestSchema,
	orderPaymentStatusRequestSchema,
	orderQuoteRequestSchema,
	orderRefundIntentRequestSchema,
	orderRefundsPendingRequestSchema,
	orderRefundStatusRequestSchema,
} from '@repo/common/restaurant-orders'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { isCateringPublicDisabled } from '../lib/catering-switches.ts'
import { getGiftCardFlagState } from '../lib/gift-card-context.ts'
import { isGiftCardsKillSwitchOn } from '../lib/gift-card-switches.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { isQrDineInDisabled } from '../lib/qr-tokens.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	applyBalancePaymentEvent,
	bindBalancePaymentSession,
	getBalanceQuote,
} from '../services/catering-balance.ts'
import {
	applyOrderPayLinkPaymentEvent,
	bindOrderPayLinkSession,
	getOrderPayLinkQuote,
} from '../services/order-pay-links.ts'
import {
	applyQuoteRefPaymentEvent,
	bindQuoteRefSession,
	getQuoteRefQuote,
} from '../services/catering-quotes.ts'
import {
	applyDisputeStatus,
	applyProviderRefundStatus,
	createProviderRefundIntent,
	listPendingProviderRefunds,
} from '../services/order-provider-refund-service.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	getOrderQuote,
} from '../services/order-service.ts'
import {
	applyGiftCardDispute,
	applyGiftCardPaymentEvent,
	bindGiftCardPaymentSession,
	getGiftCardQuote,
} from '../services/gift-card-purchase-service.ts'
import {
	applyTabPaymentEvent,
	bindTabPaymentSession,
	getTabQuote,
} from '../services/qr-tab-service.ts'

/** `tab:<id>` refs are QR tabs paid from the phone; the kill switch stops them. */
function tabRef(c: Context, orderId: string) {
	const tabId = parseTabOrderRef(orderId)
	if (!tabId) return { tabId: null, denied: null }
	if (isQrDineInDisabled()) {
		return { tabId, denied: c.json({ error: 'unavailable' }, 503) }
	}
	return { tabId, denied: null }
}

export const orderSystemRoutes = new Hono()

/**
 * System-to-system order routes (App → regional tenant-api), authenticated
 * with the shared INTERNAL_COMMAND_TOKEN using a constant-time comparison.
 * The App never sees customer PII through these paths.
 */
function checkSystemAuth(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'System API is not configured' }, 503)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return null
}

const orgIdSchema = TENANT_ORG_ID_PATTERN

/**
 * Region fail-closed: the org must resolve as active on this node and its
 * dataRegion must match. A failed lookup is never downgraded to stale data.
 */
async function assertOrgRegion(c: Context, orgId: string) {
	const nodeRegion = getNodeRegion()
	const organization = await findActiveOrganizationById(orgId)
	if (!organization) {
		return c.json(
			{
				error: 'organization_not_found',
				message: 'Organization could not be resolved on this node',
			},
			404,
		)
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return c.json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${nodeRegion}")`,
				orgRegion: organization.dataRegion,
				nodeRegion,
			},
			409,
		)
	}
	if (!organization.hasProvisionedDb) {
		return c.json({ error: 'organization_not_provisioned' }, 404)
	}
	return null
}

function failureResponse(
	c: Context,
	failure: {
		status: number
		code: string
		message: string
		details?: Record<string, unknown>
	},
) {
	return c.json(
		{
			error: failure.code,
			message: failure.message,
			// Machine extras only (e.g. `refundableCents`), never request input.
			...(failure.details && typeof failure.details.refundableCents === 'number'
				? { refundableCents: failure.details.refundableCents }
				: {}),
		},
		failure.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
	)
}

orderSystemRoutes.post('/quote', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const parsed = orderQuoteRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid quote request' },
			400,
		)
	}
	if (!orgIdSchema.test(parsed.data.orgId)) {
		return c.json({ error: 'invalid_request', message: 'Invalid orgId' }, 400)
	}
	const regionDenied = await assertOrgRegion(c, parsed.data.orgId)
	if (regionDenied) return regionDenied

	const tab = tabRef(c, parsed.data.orderId)
	if (tab.denied) return tab.denied
	const giftCardId = parseGiftCardOrderRef(parsed.data.orderId)
	if (giftCardId && isGiftCardsKillSwitchOn()) {
		return c.json({ error: 'unavailable' }, 503)
	}
	// A catering quote starts new money: the kill switch stops it.
	// `bal:<orderId>` serves both catering balances and general order pay links (#163).
	const quoteId = parseQuoteOrderRef(parsed.data.orderId)
	const balanceOrderId = parseBalanceOrderRef(parsed.data.orderId)
	if (quoteId && isCateringPublicDisabled()) {
		return c.json({ error: 'catering_unavailable' }, 503)
	}

	try {
		const result = quoteId
			? await getQuoteRefQuote(
					parsed.data.orgId,
					quoteId,
					parsed.data.paymentToken,
				)
			: balanceOrderId
				? await (async () => {
						const catering = await getBalanceQuote(
							parsed.data.orgId,
							balanceOrderId,
							parsed.data.paymentToken,
						)
						if (catering.ok) {
							if (isCateringPublicDisabled()) {
								return {
									ok: false as const,
									failure: {
										status: 503,
										code: 'catering_unavailable',
										message: 'Catering is temporarily unavailable.',
									},
								}
							}
							return catering
						}
						if (catering.failure.code !== 'order_not_found') return catering
						return getOrderPayLinkQuote(
							parsed.data.orgId,
							balanceOrderId,
							parsed.data.paymentToken,
						)
					})()
				: giftCardId
					? await getGiftCardQuote(
							parsed.data.orgId,
							giftCardId,
							parsed.data.paymentToken,
						)
					: tab.tabId
						? await getTabQuote(
								parsed.data.orgId,
								tab.tabId,
								parsed.data.paymentToken,
							)
						: await getOrderQuote(
								parsed.data.orgId,
								parsed.data.orderId,
								parsed.data.paymentToken,
							)
		if (!result.ok) return failureResponse(c, result.failure)
		// Only non-PII fields per contract: amounts, currency, hold, status.
		return c.json(result.data)
	} catch (error) {
		console.error(
			`Order quote failed for org ${parsed.data.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})

orderSystemRoutes.post('/payment-session', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const parsed = orderPaymentSessionRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid payment session request' },
			400,
		)
	}
	if (!orgIdSchema.test(parsed.data.orgId)) {
		return c.json({ error: 'invalid_request', message: 'Invalid orgId' }, 400)
	}
	const regionDenied = await assertOrgRegion(c, parsed.data.orgId)
	if (regionDenied) return regionDenied

	const tab = tabRef(c, parsed.data.orderId)
	if (tab.denied) return tab.denied
	const giftCardId = parseGiftCardOrderRef(parsed.data.orderId)
	if (giftCardId && isGiftCardsKillSwitchOn()) {
		return c.json({ error: 'unavailable' }, 503)
	}
	const quoteId = parseQuoteOrderRef(parsed.data.orderId)
	const balanceOrderId = parseBalanceOrderRef(parsed.data.orderId)
	if (quoteId && isCateringPublicDisabled()) {
		return c.json({ error: 'catering_unavailable' }, 503)
	}

	try {
		const result = quoteId
			? await bindQuoteRefSession({
					orgId: parsed.data.orgId,
					quoteId,
					sessionId: parsed.data.sessionId,
					processor: parsed.data.processor,
				})
			: balanceOrderId
				? await (async () => {
						const catering = await bindBalancePaymentSession({
							orgId: parsed.data.orgId,
							orderId: balanceOrderId,
							sessionId: parsed.data.sessionId,
							processor: parsed.data.processor,
						})
						if (catering.ok) {
							if (isCateringPublicDisabled()) {
								return {
									ok: false as const,
									failure: {
										status: 503,
										code: 'catering_unavailable',
										message: 'Catering is temporarily unavailable.',
									},
								}
							}
							return catering
						}
						if (catering.failure.code !== 'order_not_found') return catering
						return bindOrderPayLinkSession({
							orgId: parsed.data.orgId,
							orderId: balanceOrderId,
							sessionId: parsed.data.sessionId,
							processor: parsed.data.processor,
						})
					})()
				: giftCardId
					? await bindGiftCardPaymentSession({
							orgId: parsed.data.orgId,
							cardId: giftCardId,
							sessionId: parsed.data.sessionId,
							processor: parsed.data.processor,
						})
					: tab.tabId
						? await bindTabPaymentSession({
								orgId: parsed.data.orgId,
								tabId: tab.tabId,
								sessionId: parsed.data.sessionId,
								processor: parsed.data.processor,
							})
						: await bindPaymentSession({
								orgId: parsed.data.orgId,
								orderId: parsed.data.orderId,
								sessionId: parsed.data.sessionId,
								processor: parsed.data.processor,
							})
		if (!result.ok) return failureResponse(c, result.failure)
		return c.json(result.data)
	} catch (error) {
		console.error(
			`Payment session binding failed for org ${parsed.data.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})

orderSystemRoutes.post('/payment-status', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const parsed = orderPaymentStatusRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid payment status request' },
			400,
		)
	}
	if (!orgIdSchema.test(parsed.data.orgId)) {
		return c.json({ error: 'invalid_request', message: 'Invalid orgId' }, 400)
	}
	const regionDenied = await assertOrgRegion(c, parsed.data.orgId)
	if (regionDenied) return regionDenied

	// Payment events are never dropped by the kill switch: money that already
	// moved must still settle (or land in review).
	const tabId = parseTabOrderRef(parsed.data.orderId)
	const giftCardId = parseGiftCardOrderRef(parsed.data.orderId)
	const quoteId = parseQuoteOrderRef(parsed.data.orderId)
	const balanceOrderId = parseBalanceOrderRef(parsed.data.orderId)

	try {
		const result = quoteId
			? await applyQuoteRefPaymentEvent({
					orgId: parsed.data.orgId,
					quoteId,
					sessionId: parsed.data.sessionId,
					processor: parsed.data.processor,
					status: parsed.data.status,
					amountCents: parsed.data.amountCents,
					currency: parsed.data.currency,
					paymentId: parsed.data.paymentId,
				})
			: balanceOrderId
				? await (async () => {
						const catering = await applyBalancePaymentEvent({
							orgId: parsed.data.orgId,
							orderId: balanceOrderId,
							sessionId: parsed.data.sessionId,
							processor: parsed.data.processor,
							status: parsed.data.status,
							amountCents: parsed.data.amountCents,
							currency: parsed.data.currency,
							paymentId: parsed.data.paymentId,
						})
						if (catering.ok || catering.failure.code !== 'order_not_found') {
							return catering
						}
						return applyOrderPayLinkPaymentEvent({
							orgId: parsed.data.orgId,
							orderId: balanceOrderId,
							sessionId: parsed.data.sessionId,
							processor: parsed.data.processor,
							status: parsed.data.status,
							amountCents: parsed.data.amountCents,
							currency: parsed.data.currency,
							paymentId: parsed.data.paymentId,
						})
					})()
				: giftCardId
					? await applyGiftCardPaymentEvent({
							orgId: parsed.data.orgId,
							cardId: giftCardId,
							sessionId: parsed.data.sessionId,
							processor: parsed.data.processor,
							status: parsed.data.status,
							amountCents: parsed.data.amountCents,
							currency: parsed.data.currency,
							paymentId: parsed.data.paymentId,
							risk: parsed.data.risk,
							settings: (await getGiftCardFlagState(parsed.data.orgId))
								.settings,
						})
					: tabId
						? await applyTabPaymentEvent({
								orgId: parsed.data.orgId,
								tabId,
								sessionId: parsed.data.sessionId,
								processor: parsed.data.processor,
								status: parsed.data.status,
								amountCents: parsed.data.amountCents,
								currency: parsed.data.currency,
								paymentId: parsed.data.paymentId,
							})
						: await applyPaymentEvent({
								orgId: parsed.data.orgId,
								orderId: parsed.data.orderId,
								sessionId: parsed.data.sessionId,
								processor: parsed.data.processor,
								status: parsed.data.status,
								amountCents: parsed.data.amountCents,
								currency: parsed.data.currency,
								paymentId: parsed.data.paymentId,
								cardBrand: parsed.data.cardBrand,
								cardLast4: parsed.data.cardLast4,
							})
		if (!result.ok) return failureResponse(c, result.failure)
		return c.json({
			orgId: result.data.orgId,
			orderId: result.data.orderId,
			status: result.data.status,
			paymentStatus: result.data.paymentStatus,
		})
	} catch (error) {
		console.error(
			`Payment status failed for org ${parsed.data.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})

// ---------------------------------------------------------------------------
// Provider refunds (#80). The region books and settles; the App calls the
// provider. Ids, amounts, currency, processor and provider ids only, in every
// answer and log line. Payment money is never stopped by the QR kill switch.
// ---------------------------------------------------------------------------

/** Parses, checks the token, the org id and the org's region. */
async function systemRequest<T extends { orgId: string }>(
	c: Context,
	schema: {
		safeParse: (
			value: unknown,
		) => { success: true; data: T } | { success: false }
	},
	message: string,
): Promise<{ data: T } | { error: Response }> {
	const denied = checkSystemAuth(c)
	if (denied) return { error: denied }
	const parsed = schema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return { error: c.json({ error: 'invalid_request', message }, 400) }
	}
	if (!orgIdSchema.test(parsed.data.orgId)) {
		return {
			error: c.json(
				{ error: 'invalid_request', message: 'Invalid orgId' },
				400,
			),
		}
	}
	const regionDenied = await assertOrgRegion(c, parsed.data.orgId)
	if (regionDenied) return { error: regionDenied }
	return { data: parsed.data }
}

/**
 * Books a `pending` provider refund of a paid online order (or of one online
 * payment of a QR tab: `orderId = 'tab:<id>'`, `tabPaymentId` for a payment
 * kept for review). Answers the refund (`orderRefundIntentResponseSchema`),
 * 201 when new and 200 for a replay of the same key and body. With
 * `locationIds` (a member limited to some locations) an order or tab at any
 * other location is the uniform 404, and the answer carries
 * `locationScoped: true`.
 */
orderSystemRoutes.post('/refund-intent', async (c) => {
	const request = await systemRequest(
		c,
		orderRefundIntentRequestSchema,
		'Invalid refund request',
	)
	if ('error' in request) return request.error
	const body = request.data
	try {
		const result = await createProviderRefundIntent({
			orgId: body.orgId,
			orderRef: body.orderId,
			tabPaymentId: body.tabPaymentId,
			amount:
				body.full === true
					? { full: true }
					: {
							amountCents: body.amountCents ?? 0,
							...(body.includeServiceFee ? { includeServiceFee: true } : {}),
						},
			note: body.note,
			idempotencyKey: body.idempotencyKey,
			origin: body.actor.origin,
			actorId: body.actor.actorId ?? body.actor.origin,
			locationIds: body.locationIds ?? null,
			// The member's loyalty grant (the App never sends an impersonated
			// refund): an order loyalty tracks needs it, as a recorded refund does.
			...(body.loyaltyAccess
				? {
						loyaltyAccess: {
							refundLoyalty: body.loyaltyAccess.refundLoyalty,
							impersonated: false,
						},
					}
				: {}),
		})
		if (!result.ok) return failureResponse(c, result.failure)
		return c.json(
			{
				...result.data.refund,
				replayed: result.data.replayed,
				// Tells the App the location limit was checked here: a region
				// that predates `locationIds` never says so, and the App then
				// refuses to refund for a member limited to some locations.
				...(body.locationIds != null ? { locationScoped: true } : {}),
				// Likewise for the loyalty grant.
				...(result.data.loyaltyChecked ? { loyaltyChecked: true } : {}),
			},
			result.data.replayed ? 200 : 201,
		)
	} catch (error) {
		console.error(
			`Order refund intent failed for org ${body.orgId}:`,
			error instanceof Error ? error.name : 'unknown',
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})

/**
 * The provider's answer for one refund, by `refundId` or `providerRefundId`.
 * Idempotent: `applied` is true only for the write that moved it.
 */
orderSystemRoutes.post('/refund-status', async (c) => {
	const request = await systemRequest(
		c,
		orderRefundStatusRequestSchema,
		'Invalid refund status',
	)
	if ('error' in request) return request.error
	const body = request.data
	try {
		const result = await applyProviderRefundStatus({
			orgId: body.orgId,
			orderId: body.orderId,
			refundId: body.refundId,
			providerRefundId: body.providerRefundId,
			processor: body.processor,
			status: body.status,
			failureCode: body.failureCode,
			amountCents: body.amountCents,
			currency: body.currency,
		})
		if (!result.ok) return failureResponse(c, result.failure)
		return c.json(result.data)
	} catch (error) {
		console.error(
			`Order refund status failed for org ${body.orgId}:`,
			error instanceof Error ? error.name : 'unknown',
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})

/** A dispute on an order or tab payment opened, was won or was lost. */
orderSystemRoutes.post('/dispute-status', async (c) => {
	const request = await systemRequest(
		c,
		orderDisputeStatusRequestSchema,
		'Invalid dispute status',
	)
	if ('error' in request) return request.error
	const body = request.data
	try {
		// A disputed gift card purchase freezes its card at once, whatever the
		// kill switch says: money already moved must stay protected.
		const giftCardId = body.orderId ? parseGiftCardOrderRef(body.orderId) : null
		if (giftCardId || (!body.orderId && body.sessionId)) {
			const frozen = await applyGiftCardDispute({
				orgId: body.orgId,
				cardId: giftCardId ?? undefined,
				sessionId: giftCardId ? undefined : body.sessionId,
				processor: body.processor,
				status: body.status,
			})
			if (frozen.ok) {
				return c.json({
					orderId: giftCardOrderRefOf(frozen.cardId),
					disputeStatus: body.status,
					disputed: body.status === 'open' || body.status === 'lost',
					applied: frozen.changed,
				})
			}
			if (giftCardId) {
				return failureResponse(c, {
					status: 404,
					code: 'order_not_found',
					message: 'Order not found.',
				})
			}
		}
		const result = await applyDisputeStatus({
			orgId: body.orgId,
			orderId: body.orderId,
			sessionId: body.sessionId,
			processor: body.processor,
			status: body.status,
			feeCents: body.feeCents,
		})
		if (!result.ok) return failureResponse(c, result.failure)
		return c.json(result.data)
	} catch (error) {
		console.error(
			`Order dispute status failed for org ${body.orgId}:`,
			error instanceof Error ? error.name : 'unknown',
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})

/** Provider refunds still pending, oldest first (execute and reconcile). */
orderSystemRoutes.post('/refunds-pending', async (c) => {
	const request = await systemRequest(
		c,
		orderRefundsPendingRequestSchema,
		'Invalid pending refunds request',
	)
	if ('error' in request) return request.error
	const body = request.data
	try {
		const refunds = await listPendingProviderRefunds({
			orgId: body.orgId,
			refundId: body.refundId,
			olderThanMs: body.olderThanMs,
			limit: body.limit,
		})
		return c.json({ refunds })
	} catch (error) {
		console.error(
			`Pending order refunds failed for org ${body.orgId}:`,
			error instanceof Error ? error.name : 'unknown',
		)
		return c.json({ error: 'internal_error' }, 500)
	}
})
