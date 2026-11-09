import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'

/**
 * Phase 2, notifications and the tick: the two internal (machine to machine)
 * contracts between the regional tenant-api and the US App. Neither carries a
 * name, a phone, an item name or an amount of money: ids and counts only.
 */

// ── Region → App: `POST /resources/inventory/notify` ────────────────────────

/** Path on the App (`INVENTORY_NOTIFY_PATH`), next to `/resources/inventory/context`. */
export const INVENTORY_NOTIFY_PATH = '/resources/inventory/notify'

/**
 * What a manager is told:
 * - `inventory_low_stock`: a daily digest at the location's morning; `count`
 *   is items below their level (only items with levels set).
 * - `inventory_count_review`: counts are waiting for approval; `count` is how
 *   many.
 * - `inventory_delivery_due`: open orders due today or overdue; `count` is
 *   how many.
 * - `inventory_price_rise`: items whose latest delivery rose by more than 5%;
 *   `count` is how many items.
 */
export const INVENTORY_NOTIFY_KINDS = [
	'inventory_low_stock',
	'inventory_count_review',
	'inventory_delivery_due',
	'inventory_price_rise',
] as const
export type InventoryNotifyKind = (typeof INVENTORY_NOTIFY_KINDS)[number]
export const inventoryNotifyKindSchema = z.enum(INVENTORY_NOTIFY_KINDS)

/**
 * The event the region posts, authenticated with
 * `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` (same as staffing and
 * reservations alerts). Strict: a field that could carry a person or money is
 * a 400 and the rejected value is never echoed. `eventId` is a lowercase hex
 * digest (16 to 64 characters) of `inventoryNotifyDedupeKey(...)`, so the
 * App can drop a retry (idempotent per event id and member); the region
 * hashes with SHA-256 (no I/O here). Recipients come from the App's
 * permissions (`read:inventory:any`, the cost grant is NOT needed: counts
 * only) and each member's location scope and notification preferences.
 */
export const inventoryNotifyEventSchema = z
	.object({
		orgId: z.string().min(1).max(64),
		eventId: z.string().regex(/^[a-f0-9]{16,64}$/, 'Invalid event id'),
		kind: inventoryNotifyKindSchema,
		locationId: inventoryLocationIdSchema,
		count: z.number().int().min(1).max(10_000),
	})
	.strict()
export type InventoryNotifyEvent = z.infer<typeof inventoryNotifyEventSchema>

/**
 * The App's answer (counts only), 200 also when nothing was delivered
 * (`skipped`: flag off, unknown location, nobody to tell) so the node stops
 * retrying what cannot succeed. 401 bad token, 400 invalid event; the node
 * retries only 401/408/425/429/5xx and network errors.
 */
export const inventoryNotifyResultSchema = z
	.object({
		inApp: z.number().int().nonnegative(),
		emailed: z.number().int().nonnegative(),
		skipped: z.string().max(64).optional(),
	})
	.strict()
export type InventoryNotifyResult = z.infer<typeof inventoryNotifyResultSchema>

/**
 * The string the region hashes into `eventId`. One event per thing that can
 * happen once: a digest per location and day, a count awaiting review, a day's
 * due deliveries, a delivery that carried a price rise. `key` is a business
 * date (`YYYY-MM-DD`) for the digests and due deliveries, a count id for
 * review, a delivery id for a price rise.
 */
export function inventoryNotifyDedupeKey(input: {
	orgId: string
	kind: InventoryNotifyKind
	locationId: string
	key: string
}): string {
	return `inventory:${input.orgId}:${input.kind}:${input.locationId}:${input.key}`
}

// ── Cron → region: `POST /api/inventory/tick` ───────────────────────────────

/** The route on every tenant-api node, driven by the hourly jobs-cron fan-out, the Durable Object alarm and the Node interval. */
export const INVENTORY_TICK_PATH = '/api/inventory/tick'

/**
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only (as
 * `/api/loyalty/tick`). With `orgId` it runs that organization; without one,
 * every organization on the node within the 50-second budget. Idempotent.
 */
export const inventoryTickRequestSchema = z
	.object({ orgId: z.string().min(1).max(64).optional() })
	.strict()
export type InventoryTickRequest = z.infer<typeof inventoryTickRequestSchema>

/** What one organization's tick did. Counts only. */
export const inventoryTickResultSchema = z.object({
	/** Alerts handed to the App (new events). */
	alertsSent: z.number().int().nonnegative(),
	/** Alerts the App could not take yet; they stay due for the next tick. */
	alertsDeferred: z.number().int().nonnegative(),
	/** Alerts already sent earlier (deduplicated). */
	alertsSkipped: z.number().int().nonnegative(),
	lowStockDigests: z.number().int().nonnegative(),
	countReviewAlerts: z.number().int().nonnegative(),
	deliveryDueAlerts: z.number().int().nonnegative(),
	priceRiseAlerts: z.number().int().nonnegative(),
	/** Phase 3: sale-usage outbox rows settled (0 before). */
	salesSettled: z.number().int().nonnegative(),
	errors: z.number().int().nonnegative(),
	/**
	 * Additive (region only, read by the Durable Object alarm and left out of
	 * the cross-node totals): an alert still waits for the App, so the object
	 * should wake again, and when. Ids and times only.
	 */
	needsFollowUp: z.boolean().optional(),
	nextDueAt: z.number().int().nullable().optional(),
})
export type InventoryTickResult = z.infer<typeof inventoryTickResultSchema>

/**
 * The route's answer: `{ success, result }` for one `orgId`, else
 * `{ success, orgs, orgsDeferred, ...totals }` for the whole node
 * (`success` is false when `errors > 0`), like loyalty. Also answers 401 for a
 * bad token, 400 `validation_error`, 503 `service_unavailable` without a
 * token configured.
 */
export const inventoryTickAnswerSchema = z.union([
	z.object({ success: z.boolean(), result: inventoryTickResultSchema }),
	inventoryTickResultSchema.extend({
		success: z.boolean(),
		orgs: z.number().int().nonnegative(),
		orgsDeferred: z.number().int().nonnegative(),
	}),
])
export type InventoryTickAnswer = z.infer<typeof inventoryTickAnswerSchema>
