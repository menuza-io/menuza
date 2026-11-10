import { z } from 'zod'
import { inventoryActorKindSchema } from '../records.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import { MAX_ENTRY_QUANTITY, standardUnitSchema } from '../units.ts'

/**
 * Shared pieces of the `/operator/inventory/*` wire contract.
 *
 * - Requests are `.strict()`: unknown fields are refused with
 *   `invalid_request`, and validation errors never echo the rejected value.
 * - Responses are parsed leniently by clients (plain `z.object`), so the region
 *   can add fields first.
 * - Money fields are OPTIONAL in every response: the region omits them for a
 *   token without `read:inventory_cost:any`. Clients must treat a missing money
 *   field as "not allowed to see", never as zero.
 * - Mutations of versioned rows send `expectedVersion` (409 `stale_version`).
 * - Creates that a person can double-submit carry a client-made `clientId`
 *   (idempotent: a replay answers the first result).
 */

export const inventoryIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid id')

export const clientIdSchema = z
	.string()
	.min(8)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid client id')

/** A plain typed name: one language, stored as typed (never a locale map). */
export const inventoryNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')

export const inventoryNoteSchema = z
	.string()
	.trim()
	.max(500)
	.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')

export const expectedVersionSchema = z.number().int().min(0)

/** Signed stored quantity (thousandths of the base unit). */
export const quantitySchema = z
	.number()
	.int()
	.min(-MAX_ENTRY_QUANTITY)
	.max(MAX_ENTRY_QUANTITY)
export const positiveQuantitySchema = quantitySchema.min(1)
export const nonNegativeQuantitySchema = quantitySchema.min(0)

/** An amount as a person typed it, in some unit (converted by the region). */
export const typedAmountSchema = z.number().finite().min(0).max(1_000_000_000)

/**
 * A unit reference: a standard unit key (`kg`, `l`, `piece`, …) or one of the
 * item's named units as `unit:<id>`.
 */
export const unitRefSchema = z.union([
	standardUnitSchema,
	z.string().regex(/^unit:[A-Za-z0-9_-]{1,64}$/, 'Invalid unit'),
])
export type UnitRef = z.infer<typeof unitRefSchema>

export function namedUnitRef(unitId: string): UnitRef {
	return `unit:${unitId}`
}

export function parseUnitRef(
	ref: UnitRef,
):
	| { kind: 'standard'; unit: z.infer<typeof standardUnitSchema> }
	| { kind: 'named'; id: string } {
	if (ref.startsWith('unit:')) return { kind: 'named', id: ref.slice(5) }
	return { kind: 'standard', unit: ref as z.infer<typeof standardUnitSchema> }
}

export const isoDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date')

export const actorSchema = z.object({
	kind: inventoryActorKindSchema,
	/** Operator user id, staff id, or null for the system. The App joins names. */
	id: z.string().nullable(),
})

export const listQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.string().max(200).optional(),
})

export const locationQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()

export const minorOut = z.number().int().optional()
export const currencyOut = z.string().optional()
