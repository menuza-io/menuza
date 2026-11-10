import {
	INVENTORY_PERMISSIONS,
	type InventoryErrorCode,
	type InventoryPermission,
} from '@repo/inventory'
import { type Context } from 'hono'
import { HttpError, NO_STORE } from './http.ts'
import { readIdempotencyKey } from './reservations-public-auth.ts'

/**
 * Shared HTTP plumbing for `/operator/inventory/*`: one error type whose
 * codes come from `INVENTORY_ERROR_CODES`, one error mapping, the optional
 * idempotency key, and the rule that money never reaches a token without
 * the cost grant. Every response is `private, no-store`; nothing here logs
 * or echoes request data.
 */

export class InventoryError extends Error {
	readonly status: number
	readonly code: InventoryErrorCode
	readonly details: Record<string, unknown>

	constructor(
		code: InventoryErrorCode,
		status: number,
		details: Record<string, unknown> = {},
	) {
		super(code)
		this.name = 'InventoryError'
		this.code = code
		this.status = status
		this.details = details
	}
}

export function inventoryDeny(
	status: number,
	code: InventoryErrorCode,
	details: Record<string, unknown> = {},
): Response {
	return Response.json(
		{ error: code, code, ...details },
		{ status, headers: NO_STORE },
	)
}

export function inventoryErrorResponse(error: unknown): Response {
	if (error instanceof Response) return error
	if (error instanceof InventoryError) {
		return inventoryDeny(error.status, error.code, error.details)
	}
	if (error instanceof HttpError) return error.toResponse()
	// Cost math throws a plain RangeError for a number outside the safe integer
	// range (`@repo/inventory` cost.ts). Requests are capped by the contract,
	// so this is a last net: an absurd amount is the caller's 400, not a 500.
	if (
		error instanceof RangeError &&
		/safe integer|out of range/.test(error.message)
	) {
		return inventoryDeny(400, 'invalid_request', {
			reason: 'amount_out_of_range',
		})
	}
	throw error
}

/**
 * The `Idempotency-Key` header when one was sent. Optional on routes that
 * already carry `expectedVersion`; a malformed key is a 400, never ignored.
 */
export function readOptionalIdempotencyKey(
	c: Context,
): { key: string | null } | { error: Response } {
	const raw = c.req.header('Idempotency-Key')
	if (raw === undefined) return { key: null }
	const key = readIdempotencyKey(c)
	if (!key) {
		return {
			error: inventoryDeny(400, 'invalid_request', {
				message: 'Malformed Idempotency-Key header',
			}),
		}
	}
	return { key }
}

/** Whether a token may see money (`read:inventory_cost:any`). */
export function canSeeInventoryCost(
	grants: readonly InventoryPermission[],
): boolean {
	return grants.includes(INVENTORY_PERMISSIONS.READ_INVENTORY_COST)
}

/**
 * Leaves money out of a response for a token without the cost grant: the
 * named fields are removed (not zeroed or nulled, so a client can never
 * mistake them for a real 0), recursively through arrays and nested
 * objects. Money stays in for tokens that hold the grant.
 */
export function omitInventoryMoney<T>(
	value: T,
	grants: readonly InventoryPermission[],
	moneyFields: readonly string[],
): T {
	if (canSeeInventoryCost(grants)) return value
	const fields = new Set(moneyFields)
	const strip = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(strip)
		if (input && typeof input === 'object') {
			const out: Record<string, unknown> = {}
			for (const [key, child] of Object.entries(input)) {
				if (fields.has(key)) continue
				out[key] = strip(child)
			}
			return out
		}
		return input
	}
	return strip(value) as T
}
