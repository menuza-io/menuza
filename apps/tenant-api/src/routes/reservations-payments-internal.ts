import {
	reservationDisputeRequestSchema,
	reservationFeeClaimRequestSchema,
	reservationFeeResultRequestSchema,
	reservationPaymentBindRequestSchema,
	reservationPaymentQuoteRequestSchema,
	reservationPaymentStatusRequestSchema,
	reservationPendingRequestSchema,
	reservationRefundClaimRequestSchema,
	reservationRefundResultRequestSchema,
} from '@repo/reservations'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { handleRouteError, json, readJsonBody } from '../lib/http.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { ensureActiveOrgInNodeRegion } from '../lib/reservations-guard.ts'
import { bearerMatches, getInternalCommandToken } from '../lib/secrets.ts'
import {
	applyPaymentStatus,
	bindPaymentSession,
	claimFee,
	claimRefunds,
	listPendingPayments,
	quoteReservationPayment,
	recordDispute,
	recordFeeResult,
	recordRefundResult,
} from '../services/rsv-payment-service.ts'

/**
 * `POST /api/reservations/payments/*`: the App's payment broker (architecture
 * 12.6). Authenticated with `INTERNAL_COMMAND_TOKEN` only; every body names its
 * `orgId`, the node refuses an organization that is not active in its region,
 * and bodies and responses carry ids, amounts and opaque provider references
 * only. The App is the only caller of a payment provider.
 */
export const reservationsPaymentsInternalRoutes = new Hono()

reservationsPaymentsInternalRoutes.use(
	'*',
	rateLimit('reservations-payments-internal', {
		windowMs: 60 * 1000,
		maxRequests: 600,
	}),
)

type Handler<S extends z.ZodTypeAny> = (
	body: z.infer<S>,
) => Promise<Response | void>

function route<S extends z.ZodType<{ orgId: string }>>(
	path: string,
	schema: S,
	handler: Handler<S>,
) {
	reservationsPaymentsInternalRoutes.post(path, async (c: Context) => {
		const token = getInternalCommandToken()
		if (token.length < 16) return json({ error: 'service_unavailable' }, 503)
		if (!bearerMatches(c.req.header('Authorization'), token, 16)) {
			return json({ error: 'unauthorized' }, 401)
		}
		const parsed = await readJsonBody(c, schema)
		if ('error' in parsed) return parsed.error
		const orgId = (parsed.data as { orgId: string }).orgId
		if (!TENANT_ORG_ID_PATTERN.test(orgId)) {
			return json({ error: 'validation_error' }, 400)
		}
		const orgErr = await ensureActiveOrgInNodeRegion({ orgId })
		if (orgErr) return orgErr
		try {
			const result = await handler(parsed.data)
			return result ?? new Response(null, { status: 204 })
		} catch (error) {
			return handleRouteError(error)
		}
	})
}

route('/quote', reservationPaymentQuoteRequestSchema, async (body) =>
	json(await quoteReservationPayment(body.orgId, body)),
)
route('/bind', reservationPaymentBindRequestSchema, async (body) => {
	await bindPaymentSession(body.orgId, body)
})
route('/status', reservationPaymentStatusRequestSchema, async (body) =>
	json(await applyPaymentStatus(body.orgId, body)),
)
route('/fee-claim', reservationFeeClaimRequestSchema, async (body) =>
	json(await claimFee(body.orgId, body)),
)
route('/fee-result', reservationFeeResultRequestSchema, async (body) => {
	await recordFeeResult(body.orgId, body)
})
route('/refund-claim', reservationRefundClaimRequestSchema, async (body) =>
	json(await claimRefunds(body.orgId, body)),
)
route('/refund-result', reservationRefundResultRequestSchema, async (body) => {
	await recordRefundResult(body.orgId, body)
})
route('/dispute', reservationDisputeRequestSchema, async (body) => {
	await recordDispute(body.orgId, body)
})
route('/pending', reservationPendingRequestSchema, async (body) =>
	json(await listPendingPayments(body.orgId)),
)
