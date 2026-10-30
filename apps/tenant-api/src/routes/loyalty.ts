import { QR_TAB_TOKEN_HEADER } from '@repo/common/qr-ordering'
import { restaurantOrderQuoteSchema } from '@repo/common/restaurant-orders'
import {
	LoyaltyDomainError,
	loyaltyCheckoutQuoteRequestSchema,
	loyaltyTabQuoteRequestSchema,
	type LoyaltyFeatures,
} from '@repo/loyalty'
import { getTenantDb, type TenantDatabase } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { readJsonBody, NO_STORE, validationResponse } from '../lib/http.ts'
import {
	getLoyaltyFeatures,
	getLoyaltyFlagState,
	loyaltyRefusal,
} from '../lib/loyalty-context.ts'
import {
	loyaltyErrorResponse,
	loyaltyIdempotency,
	loyaltyKillSwitchResponse,
} from '../lib/loyalty-http.ts'
import { enforceLoyaltyLimit } from '../lib/loyalty-rate-limit.ts'
import { isQrDineInDisabled } from '../lib/qr-tokens.ts'
import {
	decideCustomerApproval,
	issueMemberCode,
	listCustomerApprovals,
} from '../services/loyalty-code-service.ts'
import {
	ensureMemberForCustomer,
	getMemberHistory,
	getWallet,
} from '../services/loyalty-member-service.ts'
import { quoteCheckout, quoteTab } from '../services/loyalty-checkout-quote.ts'
import { getPublicProgram } from '../services/loyalty-program-service.ts'
import { authenticateCustomer } from './auth.ts'
import { resolveOrderingOrganization } from './orders.ts'

/**
 * Customer loyalty routes (`/loyalty/*`), called browser-direct from the
 * organization's website and from the native apps. The organization comes
 * from the browser `Origin` plus slug/host hints (never a client `orgId`),
 * the person from the verified customer token, and the two must name the same
 * organization. Responses are the member's own data only, `private, no-store`,
 * with stable machine-readable codes.
 */
export const loyaltyRoutes = new Hono()

type LoyaltyCustomer = {
	orgId: string
	customerId: string
	db: TenantDatabase
}

function queryIdentity(c: Context): { slug?: string; host?: string } {
	return { slug: c.req.query('slug'), host: c.req.query('host') }
}

/**
 * Origin-bound organization plus the verified customer behind the token. A
 * token minted for another organization answers 403, never that
 * organization's data.
 */
async function requireLoyaltyCustomer(
	c: Context,
	identity: { slug?: string; host?: string },
): Promise<{ customer: LoyaltyCustomer } | { error: Response }> {
	const resolved = await resolveOrderingOrganization(c, identity)
	if ('error' in resolved) return { error: resolved.error }
	let auth: Awaited<ReturnType<typeof authenticateCustomer>>
	try {
		auth = await authenticateCustomer(c)
	} catch (thrown) {
		// `authenticateCustomer` rejects by throwing a Response; any other
		// throw is a bug and must reach the error handler, not become a reply.
		if (thrown instanceof Response) return { error: thrown }
		throw thrown
	}
	if (auth.organization.id !== resolved.organization.id) {
		return {
			error: Response.json(
				{ error: 'organization_mismatch', code: 'organization_mismatch' },
				{ status: 403, headers: NO_STORE },
			),
		}
	}
	return {
		customer: { orgId: auth.orgId, customerId: auth.customerId, db: auth.db },
	}
}

/**
 * The flag gate for customer reads and writes: node kill switch first (503),
 * then the organization flag (403 when off, 503 while it cannot be read).
 * `GET /program` and `GET /wallet` do not use this: they answer `null`
 * payloads so a site can hide loyalty quietly.
 */
async function requireLoyaltyEnabled(
	orgId: string,
): Promise<{ features: LoyaltyFeatures } | { error: Response }> {
	const kill = loyaltyKillSwitchResponse()
	if (kill) return { error: kill }
	const flags = await getLoyaltyFlagState(orgId)
	const refusal = loyaltyRefusal(flags)
	if (refusal) {
		return { error: loyaltyErrorResponse(new LoyaltyDomainError(refusal)) }
	}
	return { features: flags.features }
}

// ---------------------------------------------------------------------------
// GET /program — the public program, or null when loyalty is off or in draft
// ---------------------------------------------------------------------------

loyaltyRoutes.get('/program', async (c) => {
	try {
		const resolved = await resolveOrderingOrganization(c, queryIdentity(c))
		if ('error' in resolved) return resolved.error
		const features = await getLoyaltyFeatures(resolved.organization.id)
		const program = await getPublicProgram(
			await getTenantDb(resolved.organization.id),
			features,
		)
		return Response.json({ program }, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// GET /wallet — program, points account, balance, next reward, pending approvals
// ---------------------------------------------------------------------------

/**
 * A customer is the member: the first wallet read of a signed-in verified
 * customer opens their points account (the sign-in did it already when
 * loyalty was on then; this covers a customer who signed in before the
 * program went live). Nothing is opened while loyalty is off or unknown.
 */

loyaltyRoutes.get('/wallet', async (c) => {
	try {
		const auth = await requireLoyaltyCustomer(c, queryIdentity(c))
		if ('error' in auth) return auth.error
		const flags = await getLoyaltyFlagState(auth.customer.orgId)
		const features = flags.features
		if (flags.status === 'on') {
			await ensureMemberForCustomer(auth.customer.orgId, {
				customerId: auth.customer.customerId,
			})
		}
		const wallet = await getWallet(auth.customer.db, {
			customerId: auth.customer.customerId,
			features,
		})
		return Response.json({ wallet }, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /checkout/quote — every reward priced on the cart, totals with the pick
// ---------------------------------------------------------------------------

/**
 * A quote body read leniently, so a request without a valid customer token
 * answers 401 before its body is validated. Slug and host hints come from
 * the body only (a POST never reads them from the URL).
 */
async function readQuoteBody(
	c: Context,
): Promise<{ raw: unknown; identity: { slug?: string; host?: string } }> {
	const raw: unknown = await c.req.json().catch(() => undefined)
	const fields =
		raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
	const text = (value: unknown) =>
		typeof value === 'string' ? value : undefined
	return {
		raw,
		identity: { slug: text(fields.slug), host: text(fields.host) },
	}
}

const checkoutQuoteBodySchema = loyaltyCheckoutQuoteRequestSchema.extend({
	slug: z.string().max(253).optional(),
	host: z.string().max(253).optional(),
})

loyaltyRoutes.post('/checkout/quote', async (c) => {
	try {
		const { raw, identity } = await readQuoteBody(c)
		const auth = await requireLoyaltyCustomer(c, identity)
		if ('error' in auth) return auth.error
		const body = checkoutQuoteBodySchema.safeParse(raw)
		if (!body.success) return validationResponse(body.error)
		// The quote schema: a read needs no idempotency key or contact.
		const order = restaurantOrderQuoteSchema.safeParse(body.data.order)
		if (!order.success) {
			return loyaltyErrorResponse(new LoyaltyDomainError('invalid_request'))
		}
		const gate = await requireLoyaltyEnabled(auth.customer.orgId)
		if ('error' in gate) return gate.error
		if (!gate.features.redemption) {
			return loyaltyErrorResponse(new LoyaltyDomainError('redemption_disabled'))
		}
		await enforceLoyaltyLimit(
			auth.customer.db,
			'quote',
			auth.customer.customerId,
		)
		const result = await quoteCheckout({
			orgId: auth.customer.orgId,
			customerId: auth.customer.customerId,
			request: order.data,
			selection: body.data.selection,
		})
		if (!result.ok) {
			const { status, code, message } = result.failure
			return Response.json(
				{ error: code, code, message },
				{ status, headers: NO_STORE },
			)
		}
		return Response.json(result.data, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /tab/quote — every reward priced on an open QR tab (X-Tab-Token)
// ---------------------------------------------------------------------------

const tabQuoteBodySchema = loyaltyTabQuoteRequestSchema.extend({
	slug: z.string().max(253).optional(),
	host: z.string().max(253).optional(),
})

loyaltyRoutes.post('/tab/quote', async (c) => {
	try {
		// The tab is dine-in context: the QR kill switch closes it too.
		if (isQrDineInDisabled()) {
			return Response.json(
				{
					error: 'dine_in_unavailable',
					code: 'dine_in_unavailable',
					message: 'Ordering at the table is unavailable right now.',
				},
				{ status: 503, headers: NO_STORE },
			)
		}
		const { raw, identity } = await readQuoteBody(c)
		const auth = await requireLoyaltyCustomer(c, identity)
		if ('error' in auth) return auth.error
		const body = tabQuoteBodySchema.safeParse(raw)
		if (!body.success) return validationResponse(body.error)
		const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim()
		if (!tabToken) {
			return Response.json(
				{
					error: 'tab_not_found',
					code: 'tab_not_found',
					message: 'A tab code is required.',
				},
				{ status: 404, headers: NO_STORE },
			)
		}
		const gate = await requireLoyaltyEnabled(auth.customer.orgId)
		if ('error' in gate) return gate.error
		if (!gate.features.redemption) {
			return loyaltyErrorResponse(new LoyaltyDomainError('redemption_disabled'))
		}
		await enforceLoyaltyLimit(
			auth.customer.db,
			'quote',
			auth.customer.customerId,
		)
		const result = await quoteTab({
			orgId: auth.customer.orgId,
			customerId: auth.customer.customerId,
			tabToken,
			tipPercent: body.data.tipPercent,
			selection: body.data.selection,
		})
		if (!result.ok) {
			const { status, code, message } = result.failure
			return Response.json(
				{ error: code, code, message },
				{ status, headers: NO_STORE },
			)
		}
		return Response.json(result.data, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})
// ---------------------------------------------------------------------------
// GET /history — the member's ledger pages (newest first)
// ---------------------------------------------------------------------------

const historyQuerySchema = z.object({
	slug: z.string().max(253).optional(),
	host: z.string().max(253).optional(),
	cursor: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
})

loyaltyRoutes.get('/history', async (c) => {
	try {
		const query = historyQuerySchema.safeParse(
			Object.fromEntries(new URL(c.req.url).searchParams),
		)
		if (!query.success) {
			return loyaltyErrorResponse(new LoyaltyDomainError('invalid_request'))
		}
		const auth = await requireLoyaltyCustomer(c, {
			slug: query.data.slug,
			host: query.data.host,
		})
		if ('error' in auth) return auth.error
		const gate = await requireLoyaltyEnabled(auth.customer.orgId)
		if ('error' in gate) return gate.error
		const member = await ensureMemberForCustomer(auth.customer.orgId, {
			customerId: auth.customer.customerId,
		})
		if (!member || member.status === 'erased') {
			return loyaltyErrorResponse(new LoyaltyDomainError('member_not_found'))
		}
		const page = await getMemberHistory(auth.customer.db, {
			memberId: member.id,
			cursor: query.data.cursor ?? null,
			limit: query.data.limit,
		})
		return Response.json(page, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /member-code — a short-lived code for till identification
// ---------------------------------------------------------------------------

loyaltyRoutes.post('/member-code', async (c) => {
	try {
		const auth = await requireLoyaltyCustomer(c, queryIdentity(c))
		if ('error' in auth) return auth.error
		const gate = await requireLoyaltyEnabled(auth.customer.orgId)
		if ('error' in gate) return gate.error
		await enforceLoyaltyLimit(
			auth.customer.db,
			'memberCode',
			auth.customer.customerId,
		)
		const issued = await issueMemberCode(auth.customer.orgId, {
			customerId: auth.customer.customerId,
			features: gate.features,
		})
		return Response.json(issued, { status: 201, headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// GET /approvals — till spend requests waiting on this customer
// ---------------------------------------------------------------------------

loyaltyRoutes.get('/approvals', async (c) => {
	try {
		const auth = await requireLoyaltyCustomer(c, queryIdentity(c))
		if ('error' in auth) return auth.error
		const gate = await requireLoyaltyEnabled(auth.customer.orgId)
		if ('error' in gate) return gate.error
		const approvals = await listCustomerApprovals(auth.customer.db, {
			customerId: auth.customer.customerId,
		})
		return Response.json({ approvals }, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /approvals/:approvalId/decide — approve or decline a spend request
// ---------------------------------------------------------------------------

const decideBodySchema = z
	.object({
		decision: z.enum(['approve', 'decline']),
		slug: z.string().max(253).optional(),
		host: z.string().max(253).optional(),
	})
	.strict()

loyaltyRoutes.post('/approvals/:approvalId/decide', async (c) => {
	try {
		const body = await readJsonBody(c, decideBodySchema)
		if ('error' in body) return body.error
		const auth = await requireLoyaltyCustomer(c, {
			slug: body.data.slug,
			host: body.data.host,
		})
		if ('error' in auth) return auth.error
		const gate = await requireLoyaltyEnabled(auth.customer.orgId)
		if ('error' in gate) return gate.error
		await enforceLoyaltyLimit(
			auth.customer.db,
			'customerWrite',
			auth.customer.customerId,
		)
		const approvalId = c.req.param('approvalId')
		const idem = loyaltyIdempotency(
			c,
			`approval-decide:${auth.customer.customerId}`,
			{ approvalId, decision: body.data.decision },
		)
		if ('error' in idem) return idem.error
		const approval = await decideCustomerApproval(auth.customer.orgId, {
			customerId: auth.customer.customerId,
			approvalId,
			decision: body.data.decision,
			features: gate.features,
			idempotency: idem.idempotency,
		})
		return Response.json({ approval }, { headers: NO_STORE })
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})
