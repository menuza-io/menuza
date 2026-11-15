import { getUserId, isImpersonating } from '@repo/auth'
import {
	ORDER_REFUND_ERROR_CODES,
	orderProviderRefundRequestSchema,
	refundIdempotencyKeySchema,
	type OrderRefundIntentResponse,
} from '@repo/common/restaurant-orders'
import { LOYALTY_PERMISSIONS } from '@repo/loyalty'
import { type ActionFunctionArgs } from 'react-router'
import {
	getUserLoyaltyGrants,
	resolveLoyaltyLocationIds,
} from '#app/utils/loyalty/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	executeRestaurantOrderRefund,
	logRestaurantRefundFailure,
	RestaurantOrderRefundError,
} from '#app/utils/restaurant-orders/refunds.server.ts'
import {
	RegionalOrderApiError,
	requestRestaurantOrderRefundIntent,
} from '#app/utils/restaurant-orders/regional-order-api.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function refuse(status: number, error: string, extra: object = {}) {
	return Response.json({ error, ...extra }, { status, headers: NO_STORE })
}

/** Region refusals passed through with their own code and status. */
const PASS_THROUGH_CODES = new Set<string>(ORDER_REFUND_ERROR_CODES)

function regionalRefusal(error: RegionalOrderApiError): Response {
	if (error.retryable) {
		return refuse(503, 'regional_unavailable', { retryable: true })
	}
	if (error.httpStatus === 404) return refuse(404, 'order_not_found')
	// The region could not check a location-limited member's scope (an older
	// region): nothing was refunded.
	if (error.code === 'location_scope_unsupported') {
		return refuse(403, 'location_scope_unsupported')
	}
	// The member may not move loyalty points and the region could not check
	// whether the order carries any (an older region): nothing was refunded.
	if (error.code === 'loyalty_check_unsupported') {
		return refuse(403, 'loyalty_check_unsupported')
	}
	if (PASS_THROUGH_CODES.has(error.code)) {
		const status = error.httpStatus >= 400 && error.httpStatus < 500
		return refuse(
			status ? error.httpStatus : 409,
			error.code,
			error.code === 'refund_exceeds_payment' &&
				error.refundableCents !== undefined
				? { refundableCents: error.refundableCents }
				: {},
		)
	}
	if (error.httpStatus === 400) return refuse(400, 'invalid_request')
	return refuse(502, 'refund_unavailable', { retryable: true })
}

type RefundView = {
	refundId: string
	orderId: string
	amountCents: number
	currency: string
	status: 'pending' | 'succeeded' | 'failed'
	failureCode: string | null
}

function view(intent: OrderRefundIntentResponse): RefundView {
	return {
		refundId: intent.refundId,
		orderId: intent.orderId,
		amountCents: intent.amountCents,
		currency: intent.currency,
		status: intent.status,
		failureCode: null,
	}
}

/**
 * `POST /:orgSlug/orders/:orderId/refund`: return money on an order paid
 * online through its payment provider (#80). No UI here; the order page's
 * refund dialog posts JSON.
 *
 * Checks, in this order, before anything reaches the region or a provider:
 * signed in (401), member of the organization (404), `update:order_refund:any`
 * (403), not impersonating (403 `impersonation_forbidden`), an
 * `Idempotency-Key` header (400 `idempotency_key_required`) and the body (400
 * `invalid_request`, never echoing what was sent).
 *
 * A member limited to some locations sends their location ids with the
 * intent: the region answers the uniform 404 for an order elsewhere and
 * confirms the check (`locationScoped`). A region that cannot confirm it (an
 * older one) gets 403 `location_scope_unsupported` and nothing is refunded.
 * Likewise a member without `update:loyalty_redemption:any`: the region
 * refuses an order loyalty tracks (403 `loyalty_refund_forbidden`) and
 * confirms the check (`loyaltyChecked`); an older region gets 403
 * `loyalty_check_unsupported`.
 *
 * Then: the region books the refund (`pending`), the App refunds at the
 * provider with the refund's own key, and reports the answer. A replayed key
 * returns the same refund. After a `failed` refund, a new key is a new refund.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const userId = await getUserId(request)
	if (!userId) return refuse(401, 'unauthorized')
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true, dataRegion: true, hasProvisionedDb: true },
	)
	const organizationId = organization.id
	await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.UPDATE_ORDER_REFUND_ANY,
	)
	if (await isImpersonating(request)) {
		return refuse(403, 'impersonation_forbidden')
	}
	// Null: every location. A list (possibly empty) limits the refund to
	// orders at those locations; the region enforces it.
	const locationIds = await resolveLoyaltyLocationIds(userId, organizationId)
	// A refund on an order loyalty tracks takes points back, so it also needs
	// the loyalty redemption grant (as a recorded refund does): the region
	// refuses such an order (403 `loyalty_refund_forbidden`) without it.
	const refundLoyalty = (
		await getUserLoyaltyGrants(userId, organizationId)
	).includes(LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION)

	const key = refundIdempotencyKeySchema.safeParse(
		request.headers.get('Idempotency-Key') ?? undefined,
	)
	if (!key.success) return refuse(400, 'idempotency_key_required')
	const orderId = params.orderId ?? ''
	if (orderId.length < 1 || orderId.length > 100) {
		return refuse(404, 'order_not_found')
	}
	const body = orderProviderRefundRequestSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!body.success) return refuse(400, 'invalid_request')
	if (!organization.hasProvisionedDb) return refuse(404, 'order_not_found')

	let intent: OrderRefundIntentResponse
	const book = () =>
		requestRestaurantOrderRefundIntent({
			dataRegion: organization.dataRegion,
			orgId: organizationId,
			orderId,
			...('full' in body.data
				? { full: true as const }
				: {
						amountCents: body.data.amountCents,
						// Also the service fee (#123), on top of the amount.
						...(body.data.includeServiceFee
							? { includeServiceFee: true as const }
							: {}),
					}),
			note: body.data.note,
			idempotencyKey: key.data,
			actor: { origin: 'operator', actorId: userId },
			...(locationIds !== null ? { locationIds } : {}),
			loyaltyAccess: { refundLoyalty },
		})
	try {
		intent = await book()
	} catch (error) {
		if (error instanceof RegionalOrderApiError) return regionalRefusal(error)
		logRestaurantRefundFailure('refund intent', error)
		return refuse(503, 'regional_unavailable', { retryable: true })
	}

	// A replay of a refund that is already final: nothing left to execute.
	if (intent.status !== 'pending') {
		return Response.json(
			{ refund: view(intent), replayed: intent.replayed },
			{ headers: NO_STORE },
		)
	}

	try {
		const result = await executeRestaurantOrderRefund({
			orgId: organizationId,
			refundId: intent.refundId,
		})
		if (result.outcome === 'executed') {
			return Response.json(
				{
					refund: {
						...view(intent),
						status: result.status,
						failureCode: result.failureCode,
					},
					replayed: intent.replayed,
				},
				{ headers: NO_STORE },
			)
		}
		// Finished meanwhile (a webhook or a concurrent run): read it back.
		const current = await book()
		return Response.json(
			{ refund: view(current), replayed: intent.replayed },
			{ headers: NO_STORE },
		)
	} catch (error) {
		// Booked, but not yet at the provider (or not yet reported): the refund
		// stays pending, and the reconcile job (or a webhook) finishes it.
		if (
			!(error instanceof RestaurantOrderRefundError) &&
			!(error instanceof RegionalOrderApiError)
		) {
			logRestaurantRefundFailure('refund execute', error)
		}
		return Response.json(
			{ refund: view(intent), replayed: intent.replayed, delayed: true },
			{ status: 202, headers: NO_STORE },
		)
	}
}
