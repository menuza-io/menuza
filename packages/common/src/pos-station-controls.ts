import { z } from 'zod'
import { ORDERING_PAUSE_DURATIONS } from './location-availability.ts'

/**
 * Manager controls on Station (`/pos/online-orders/controls`): pause and
 * resume online ordering at the terminal's location, and mark a dish or an
 * option sold out there (and back). Station talks only to its regional
 * tenant-api; the region asks the US App to make the change with ids and a
 * duration only (`STATION_CONTROLS_PATH`, internal token). The App owns the
 * pause math, the menu, the site cache purge and the activity log.
 *
 * Only a signed-in manager may use them (the same till role as cancel and
 * refund); the region refuses everyone else with 403 `permission_required`.
 * Nothing is queued offline.
 */

export {
	ORDERING_PAUSE_DURATIONS,
	type OrderingPauseDuration,
} from './location-availability.ts'

/** Whether a signed-in person may pause ordering and mark dishes sold out on Station. */
export function posStationControlsAllowed(person: {
	role: 'cashier' | 'manager'
}): boolean {
	return person.role === 'manager'
}

export const POS_SOLD_OUT_ENTITY_TYPES = ['item', 'modifier_option'] as const
export type PosSoldOutEntityType = (typeof POS_SOLD_OUT_ENTITY_TYPES)[number]

const id = z.string().min(1).max(64)

/** The pause at this location now, as the App reports it. */
const pauseSchema = z.strictObject({
	/** Epoch ms the pause began. */
	pausedAt: z.number().int().nullable(),
	/** Epoch ms it ends (null: until someone resumes it). */
	until: z.number().int().nullable(),
})

/** A dish or option that stock (inventory auto sold out) took off here. */
const heldByStockSchema = z.strictObject({
	/** The sold-out entry (`inv_sold_out.id`): bringing the dish back undoes it. */
	id,
	entityType: z.enum(POS_SOLD_OUT_ENTITY_TYPES),
	entityId: id,
	/** The ingredient that ran out (an inventory item name, never guest data). */
	causeItemName: z.string().max(200),
})

export const posStationControlsSchema = z.strictObject({
	locationId: id,
	/** Null when online ordering is not paused. */
	pause: pauseSchema.nullable(),
	heldByStock: z.array(heldByStockSchema),
	/** After a sold-out change: whether the menu changed (false: it already was so). */
	changed: z.boolean().optional(),
	serverNow: z.number().int(),
})
export type PosStationControls = z.infer<typeof posStationControlsSchema>
export type PosHeldByStock = z.infer<typeof heldByStockSchema>

export const posPauseCommandSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('pause'),
		duration: z.enum(ORDERING_PAUSE_DURATIONS),
	}),
	z.strictObject({ action: z.literal('resume') }),
])
export type PosPauseCommand = z.infer<typeof posPauseCommandSchema>

export const posAvailabilityCommandSchema = z.strictObject({
	entityType: z.enum(POS_SOLD_OUT_ENTITY_TYPES),
	entityId: id,
	/** False marks it sold out here; true brings it back. */
	available: z.boolean(),
	/**
	 * Bring it back although stock took it off: undoes the stock entry, so
	 * inventory leaves it on until the ingredient has been in stock again.
	 * Without it, such a dish answers 409 `held_by_stock`.
	 */
	overrideStock: z.boolean().optional(),
})
export type PosAvailabilityCommand = z.infer<
	typeof posAvailabilityCommandSchema
>

// ── Region to App (internal token, ids only) ─────────────────────────────────

export const STATION_CONTROLS_PATH = '/resources/pos/station-controls'

/** Who did it, for the activity log: opaque regional ids, never a name. */
const actorSchema = z.strictObject({ deviceId: id, staffId: id })

export const stationControlsRequestSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('state'), orgId: id, locationId: id }),
	z.strictObject({
		kind: z.literal('pause'),
		orgId: id,
		locationId: id,
		duration: z.enum(ORDERING_PAUSE_DURATIONS),
		actor: actorSchema,
	}),
	z.strictObject({
		kind: z.literal('resume'),
		orgId: id,
		locationId: id,
		actor: actorSchema,
	}),
	z.strictObject({
		kind: z.literal('availability'),
		orgId: id,
		locationId: id,
		entityType: z.enum(POS_SOLD_OUT_ENTITY_TYPES),
		entityId: id,
		available: z.boolean(),
		actor: actorSchema,
	}),
])
export type StationControlsRequest = z.infer<
	typeof stationControlsRequestSchema
>

export const stationControlsResultSchema = z.strictObject({
	pause: pauseSchema.nullable(),
	/** For `availability`: whether the App changed the menu (false: it already was). */
	changed: z.boolean().optional(),
})
export type StationControlsResult = z.infer<typeof stationControlsResultSchema>
