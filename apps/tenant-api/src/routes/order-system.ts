import { Hono, type Context } from 'hono'

import {
	orderPaymentSessionRequestSchema,
	orderPaymentStatusRequestSchema,
	orderQuoteRequestSchema,
} from '@repo/common/restaurant-orders'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	getOrderQuote,
} from '../services/order-service.ts'

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
	},
) {
	return c.json(
		{ error: failure.code, message: failure.message },
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

	try {
		const result = await getOrderQuote(
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

	try {
		const result = await bindPaymentSession({
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

	try {
		const result = await applyPaymentEvent({
			orgId: parsed.data.orgId,
			orderId: parsed.data.orderId,
			sessionId: parsed.data.sessionId,
			processor: parsed.data.processor,
			status: parsed.data.status,
			amountCents: parsed.data.amountCents,
			currency: parsed.data.currency,
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
