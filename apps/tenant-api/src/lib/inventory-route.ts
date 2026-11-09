import {
	hasInventoryGrant,
	INVENTORY_PERMISSIONS,
	inventoryIdSchema,
	type InventoryPermission,
} from '@repo/inventory'
import { type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'
import { json, validationBody } from './http.ts'
import { type InventoryOperatorContext } from './inventory-auth.ts'
import { requireInventoryLocation } from './inventory-auth.ts'
import {
	canSeeInventoryCost,
	InventoryError,
	inventoryDeny,
	omitInventoryMoney,
} from './inventory-http.ts'
import {
	hashInventoryRequest,
	type InventoryIdempotency,
} from './inventory-write.ts'
import { type InventoryCaller } from '../services/inventory-items-service.ts'
import { operatorActor } from '../services/inventory-common.ts'

/**
 * Small helpers the `/operator/inventory/*` route files share: the caller a
 * service acts for, path ids, the optional `?locationId=` of item mutations,
 * `clientId` idempotency and the money filter every response passes through.
 */

/** Every response field that carries money (or a figure derived from it). */
const MONEY_FIELDS = [
	'valueMinor',
	'totalValueMinor',
	'differenceValueMinor',
	'costMicro',
	'previousCostMicro',
	'lastCostMicro',
	'avgCostMicro',
	'priceMinor',
	'packPriceMinor',
	'lineTotalMinor',
	'linesTotalMinor',
	'vatMinor',
	'totalMinor',
	'unpaidMinor',
	'purchasesMinor',
	'valueAtStakeMinor',
	'stockValueMinor',
	'wasteWeekMinor',
	'wasteWeekShareBp',
	'minimumOrderMinor',
	'shortOfMinimumMinor',
	'belowMinimum',
	'unpricedLines',
	'previousPackPriceMinor',
	'priceChangeBp',
	'priceChanges',
	'foodCost',
	'cost',
	'openingMinor',
	'closingMinor',
	'salesMinor',
] as const

export function inventoryCaller(
	ctx: InventoryOperatorContext,
): InventoryCaller {
	return {
		orgId: ctx.orgId,
		region: ctx.region,
		actor: operatorActor(ctx.userId),
		locationIds: ctx.locationIds,
		cost: canSeeInventoryCost(ctx.grants),
		purchasing: hasInventoryGrant(
			ctx.grants,
			INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
		),
	}
}

/**
 * The JSON answer. Services already build money only for the cost grant;
 * this removes any money field that slipped through, as a second gate.
 */
export function respond(
	ctx: InventoryOperatorContext,
	body: unknown,
	status: 200 | 201 = 200,
) {
	return json(omitInventoryMoney(body, ctx.grants, MONEY_FIELDS), status)
}

/** A path id; anything that cannot be an id is a 404 like an unknown one. */
export function idParam(c: Context, name = 'id'): string {
	const parsed = inventoryIdSchema.safeParse(c.req.param(name))
	if (!parsed.success) throw new InventoryError('not_found', 404)
	return parsed.data
}

/** The optional `?locationId=` of an item mutation (checked against the token). */
export function optionalLocation(
	c: Context,
	ctx: InventoryOperatorContext,
): { ok: true; locationId: string | null } | { ok: false; response: Response } {
	const raw = c.req.query('locationId')
	if (raw === undefined) return { ok: true, locationId: null }
	return requireInventoryLocation(ctx, raw)
}

/**
 * Durable idempotency for a create that carries a client-made id: a replay
 * answers the first result. The cost grant is part of the scope so a replay
 * never hands money to a token that may not see it.
 */
export function clientIdempotency(
	ctx: InventoryOperatorContext,
	scope: string,
	clientId: string,
	body: unknown,
): InventoryIdempotency {
	return {
		scope: `${scope}:${canSeeInventoryCost(ctx.grants) ? 'c1' : 'c0'}`,
		key: clientId,
		requestHash: hashInventoryRequest(body),
	}
}

/** The grant that approving a count needs on top of the route's own. */
export const APPROVE_EXTRA_GRANT: InventoryPermission =
	INVENTORY_PERMISSIONS.READ_INVENTORY_COST

/** 400 `invalid_request` with the issues (paths and codes, never the rejected values). */
function invalidRequest(error?: z.ZodError): Response {
	return inventoryDeny(
		400,
		'invalid_request',
		error ? { issues: validationBody(error).issues } : {},
	)
}

/** The JSON body parsed with a strict schema; failures are `invalid_request`. */
export async function parseBody<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return { error: invalidRequest() }
	}
	const parsed = schema.safeParse(raw)
	return parsed.success
		? { data: parsed.data }
		: { error: invalidRequest(parsed.error) }
}

/** The query string parsed with a strict schema; failures are `invalid_request`. */
export function parseQuery<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): { data: z.infer<S> } | { error: Response } {
	const raw = Object.fromEntries(new URL(c.req.url).searchParams)
	const parsed = schema.safeParse(raw)
	return parsed.success
		? { data: parsed.data }
		: { error: invalidRequest(parsed.error) }
}

/**
 * Like `parseBody` for a request whose fields are all optional: an empty body
 * (or none) reads as `{}`. A body that is present must still be valid JSON
 * and pass the strict schema.
 */
export async function parseOptionalBody<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	const text = await c.req.text().catch(() => '')
	let raw: unknown = {}
	if (text.trim() !== '') {
		try {
			raw = JSON.parse(text)
		} catch {
			return { error: invalidRequest() }
		}
	}
	const parsed = schema.safeParse(raw)
	return parsed.success
		? { data: parsed.data }
		: { error: invalidRequest(parsed.error) }
}
