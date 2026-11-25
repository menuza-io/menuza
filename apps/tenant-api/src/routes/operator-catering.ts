import { Hono, type Context } from 'hono'
import { z } from 'zod'

import {
	operatorBalanceActionSchema,
	operatorQuoteWriteSchema,
} from '@repo/common/catering'

import { errorLogFields } from '../lib/error-log.ts'
import { NO_STORE, readJsonBody } from '../lib/http.ts'
import {
	addBalanceCharge,
	applyBalanceAction,
	getCateringOrder,
	listCateringOrders,
	updateCateringEventDetails,
} from '../services/catering-balance.ts'
import {
	cancelOperatorQuote,
	createOperatorQuote,
	getOperatorQuote,
	listOperatorQuotes,
	operatorQuoteView,
	sendOperatorQuote,
	updateOperatorQuote,
} from '../services/catering-quotes.ts'
import {
	type OrderServiceFailure,
	type OrderServiceResult,
} from '../services/order-service.ts'
import {
	assertOperatorOrg,
	authenticateOrdersOperator,
	type OperatorOrderAuth,
} from './operator-orders.ts'

/**
 * Operator catering routes (`/operator/catering/*`, #124, #361): the Catering
 * tab's orders and quotes, the quote editor and the balance actions. Same
 * operator token as the Orders page (`orders:read` to read, `orders:write` to
 * change), with the member's `locationIds` enforced: a quote or order at a
 * location the member cannot reach is the same 404 as one that does not exist.
 * Refunds and cancels go through the order's own routes. Responses are
 * `private, no-store`.
 */
export const operatorCateringRoutes = new Hono()

const BODY_LIMIT = { maxBytes: 100_000 }
const ID = /^[A-Za-z0-9_-]{8,64}$/

function failure(f: OrderServiceFailure): Response {
	return Response.json(
		{
			error: f.code,
			code: f.code,
			message: f.message,
			...(f.details ? { details: f.details } : {}),
		},
		{ status: f.status, headers: NO_STORE },
	)
}

function answer<T, V>(
	result: OrderServiceResult<T>,
	view: (data: T) => V,
	status: 200 | 201 = 200,
) {
	return result.ok
		? Response.json(view(result.data), { status, headers: NO_STORE })
		: failure(result.failure)
}

async function operator(
	c: Context,
	required: 'orders:read' | 'orders:write',
): Promise<
	| {
			auth: OperatorOrderAuth
			scope: { userId: string; locationIds: string[] | null }
	  }
	| { error: Response }
> {
	const authed = await authenticateOrdersOperator(c, required)
	if ('error' in authed) return authed
	const org = await assertOperatorOrg(authed.auth.orgId)
	if (org) return org
	return {
		auth: authed.auth,
		scope: {
			userId: authed.auth.userId,
			locationIds: authed.auth.locationIds,
		},
	}
}

const idParam = (c: Context, name = 'id') => {
	const value = c.req.param(name)
	return value && ID.test(value) ? value : null
}

const NOT_FOUND = () =>
	Response.json(
		{ error: 'not_found', code: 'not_found' },
		{ status: 404, headers: NO_STORE },
	)

/** The Catering tab: confirmed and pending catering orders, and quotes and requests. */
operatorCateringRoutes.get('/', async (c) => {
	const op = await operator(c, 'orders:read')
	if ('error' in op) return op.error
	try {
		const [orders, quotes] = await Promise.all([
			listCateringOrders(op.auth.orgId, op.scope),
			listOperatorQuotes(op.auth.orgId, op.scope),
		])
		return Response.json(
			{ orders, quotes: quotes.map(operatorQuoteView) },
			{ headers: NO_STORE },
		)
	} catch (error) {
		console.error('Catering list failed', op.auth.orgId, errorLogFields(error))
		return Response.json({ error: 'internal_error' }, { status: 500 })
	}
})

operatorCateringRoutes.get('/quotes/:id', async (c) => {
	const op = await operator(c, 'orders:read')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	return answer(
		await getOperatorQuote(op.auth.orgId, id, op.scope),
		operatorQuoteView,
	)
})

operatorCateringRoutes.post('/quotes', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const body = await readJsonBody(c, operatorQuoteWriteSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	return answer(
		await createOperatorQuote({
			orgId: op.auth.orgId,
			scope: op.scope,
			body: body.data,
		}),
		operatorQuoteView,
		201,
	)
})

operatorCateringRoutes.patch('/quotes/:id', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	const body = await readJsonBody(c, operatorQuoteWriteSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	return answer(
		await updateOperatorQuote({
			orgId: op.auth.orgId,
			quoteId: id,
			scope: op.scope,
			body: body.data,
		}),
		operatorQuoteView,
	)
})

/** Sends the quote link by email. When no email could go out the link comes back for the operator to share. */
operatorCateringRoutes.post('/quotes/:id/send', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	return answer(
		await sendOperatorQuote({
			orgId: op.auth.orgId,
			quoteId: id,
			scope: op.scope,
		}),
		(data) => ({
			quote: operatorQuoteView(data.quote),
			emailed: data.emailed,
			link: data.link,
		}),
	)
})

operatorCateringRoutes.post('/quotes/:id/cancel', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	return answer(
		await cancelOperatorQuote({
			orgId: op.auth.orgId,
			quoteId: id,
			scope: op.scope,
		}),
		operatorQuoteView,
	)
})

operatorCateringRoutes.get('/orders/:id', async (c) => {
	const op = await operator(c, 'orders:read')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	return answer(
		await getCateringOrder(op.auth.orgId, id, op.scope),
		(view) => view,
	)
})

const eventPatchSchema = z.strictObject({
	guestCount: z.number().int().min(1).max(5000).optional(),
	notes: z.string().trim().max(500).nullable().optional(),
	eventAt: z.string().datetime({ offset: true }).max(40).optional(),
})

/** Event details; a fully paid order is locked (409 `order_locked`). */
operatorCateringRoutes.patch('/orders/:id', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	const body = await readJsonBody(c, eventPatchSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	return answer(
		await updateCateringEventDetails({
			orgId: op.auth.orgId,
			orderId: id,
			scope: op.scope,
			body: body.data,
		}),
		(view) => view,
	)
})

/** Void, reopen, move the due date of, or re-send the link of a balance. */
operatorCateringRoutes.post('/orders/:id/balance', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	const body = await readJsonBody(c, operatorBalanceActionSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	return answer(
		await applyBalanceAction({
			orgId: op.auth.orgId,
			orderId: id,
			scope: op.scope,
			action: body.data,
		}),
		(view) => view,
	)
})

const chargeSchema = z.strictObject({
	label: z.string().trim().min(1).max(120),
	amountCents: z.number().int().min(1).max(100_000_000),
})

/** Adds a charge to a paid order and reopens its balance for it. */
operatorCateringRoutes.post('/orders/:id/charges', async (c) => {
	const op = await operator(c, 'orders:write')
	if ('error' in op) return op.error
	const id = idParam(c)
	if (!id) return NOT_FOUND()
	const body = await readJsonBody(c, chargeSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	return answer(
		await addBalanceCharge({
			orgId: op.auth.orgId,
			orderId: id,
			scope: op.scope,
			label: body.data.label,
			amountCents: body.data.amountCents,
		}),
		(view) => view,
		201,
	)
})
