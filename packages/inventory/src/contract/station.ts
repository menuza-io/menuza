import { z } from 'zod'
import { inventoryItemKindSchema, wasteReasonSchema } from '../vocabulary.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	clientIdSchema,
	inventoryIdSchema,
	isoDateSchema,
	unitRefSchema,
} from './common.ts'
import {
	countEntriesResultSchema,
	countEntrySchema,
	countSheetSchema,
	countSummarySchema,
} from './counts.ts'
import { itemUnitSchema } from './items.ts'
import { orderStatusSchema } from '../records.ts'
import {
	deliveryLineInputSchema,
	recordDeliveryBaseSchema,
} from './purchasing.ts'
import {
	INVOICE_PHOTO_MAX_BYTES,
	invoicePhotoRequestSchema,
	invoicePhotoUploadSchema,
	receivePrefillLineSchema,
} from './receiving.ts'
import { undoWasteSchema, wasteEntryInputSchema } from './waste.ts'

/**
 * Phase 2, the Station "Stock" app: the wire contract of `/pos/inventory/*`.
 *
 * ## Envelope (same as `/pos/timeclock` and `/pos/reservations`)
 *
 * - `Authorization: Bearer <device secret>` (the paired terminal) AND
 *   `Pos-Staff-Session: <token>` (`POS_STAFF_SESSION_HEADER` from
 *   `@repo/common/pos-orders`, a signed-in person on this terminal). Every
 *   call verifies the device, its server-bound location (a `locationId` in a
 *   request must equal it, else 403 `wrong_location`) and the session, in
 *   that order; the terminal must have the Stock app switched on and
 *   staff sign-in required, the organization's `inventory.enabled` flag must
 *   be on and `INVENTORY_ENABLED` / `POS_ENABLED` not false (the gate codes
 *   below). The permission to count and log waste is simply being signed in.
 * - `Pos-Inventory-Contract: <INVENTORY_POS_CONTRACT_VERSION>` on every call.
 *   Missing means 1. Older than `INVENTORY_POS_MIN_CONTRACT_VERSION`: 400
 *   `contract_too_old` (a pause code: the tablet needs an update). Newer than
 *   `INVENTORY_POS_CONTRACT_VERSION` (the region has not been deployed yet) or
 *   not a plain positive number: 400 `contract_unsupported` (a pause code: the
 *   tablet keeps its queue and waits for the region). Every field added after
 *   version 1 has a default or is optional, requests stay strict, and the
 *   deploy order is App, then tenant-api, then Station.
 *
 *   Version 2 changed the meaning of `send` (see `stationSendCountSchema`):
 *   the region serves versions 1 and 2 and gives a version 1 tablet the same
 *   per-device semantics, so no tablet ever closes a count for the others.
 * - Responses are `Cache-Control: private, no-store` and carry NO money (no
 *   `*Minor`, `*Micro`, prices or costs: a test over these schemas keeps
 *   it so) and no supplier contacts. Errors are `{ error: <code>, ... }`
 *   (`INVENTORY_POS_ERROR_CODES`). CORS allows `POS_ORIGINS` on `/pos/*`.
 * - Writes go through `withInventoryWrite`; the tablet makes its own ids
 *   (`clientId`), so every write is idempotent (see `stationIdempotencySchema`).
 *
 * ## Who is the actor
 *
 * The actor is the signed-in person of the `Pos-Staff-Session`. A queued item
 * may name another person, `madeBy` (the staff id the till knew when the item
 * was made, e.g. offline), accepted only when that person is still active on
 * this terminal's roster; the audit trail then also records who synced it.
 * Trust is at the tablet level, as for the till's cashier attribution and
 * punches. The device clock when it was made is `madeAt` (epoch ms).
 * Waste and deliveries made more than `STATION_LATE_SYNC_MS` before they
 * arrive are accepted and flagged `lateSync` for a manager.
 */

/**
 * Version of the Station inventory contract the tablet speaks. Bump when a
 * route's meaning or the set of routes changes; the region keeps serving every
 * version from `INVENTORY_POS_MIN_CONTRACT_VERSION`.
 *
 * 1: first contract. 2: `send` is a per-device "I'm done" (it no longer moves
 * the count to `in_review`), a count in `in_review` is not joined by a start,
 * entries are taken while the count is `counting` or `in_review` and refused
 * per entry (`count_closed`) afterwards, stable per-entry refusal codes, and
 * `madeAt` is bounded (`clampMadeAt`).
 */
export const INVENTORY_POS_CONTRACT_VERSION = 2
/** Oldest version the region still serves. */
export const INVENTORY_POS_MIN_CONTRACT_VERSION = 1
export const INVENTORY_POS_CONTRACT_HEADER = 'Pos-Inventory-Contract'

/** The catalogue is refreshed this often while the app is open and on focus. */
export const STATION_CATALOG_REFRESH_MS = 5 * 60 * 1000
/** An older catalogue still counts, with a warning. */
export const STATION_CATALOG_STALE_MS = 24 * 60 * 60 * 1000
/** Waste and deliveries older than this on arrival are flagged `lateSync`. */
export const STATION_LATE_SYNC_MS = 48 * 60 * 60 * 1000
/** The undo toast on the tablet lasts one minute … */
export const STATION_WASTE_UNDO_UI_MS = 60 * 1000
/** … and the region accepts a tablet's undo for five (clock skew, a slow signal). */
export const STATION_WASTE_UNDO_SERVER_MS = 5 * 60 * 1000
/** Photos are queued as blobs up to this size (`INVOICE_PHOTO_MAX_BYTES`). */
export const STATION_PHOTO_MAX_BYTES = INVOICE_PHOTO_MAX_BYTES
/** Items waiting in the Dexie queue before the app stops taking new ones ("Sync first"). */
export const STATION_QUEUE_LIMIT = 2000
/** Recent waste chips the catalogue offers. */
export const STATION_RECENT_WASTE_ITEMS = 8

/**
 * The app key in `PosDeviceApps`, the operator token's `stationApps` claim,
 * the terminal setting `pos_devices.inventory_enabled` and `/pos/me`'s
 * `apps`. The Station launcher tile and `StationApp` are called `stock`.
 *
 * Done (phase 2 foundations): `PosDeviceApps` in
 * `packages/common/src/pos-orders.ts` is `{ timeclock; reservations;
 * inventory }` with `NO_POS_DEVICE_APPS.inventory = false`; `deviceApps()` in
 * `apps/tenant-api/src/services/pos-apps-service.ts` uses
 * `inventoryGate(orgId, device)`, which returns `{ ok: true, locationId }` or
 * `{ ok: false, code }` with `STATION_INVENTORY_GATE_CODES` (plus
 * `inventory_unavailable` for the node kill switch), mapped like the
 * reservations gate (a gate that cannot be read leaves `apps.inventory` out
 * so the till keeps what it knew). The terminal setting is
 * `pos_devices.inventory_enabled` (tenant migration 0034); the `stationApps`
 * claim carries `inventory` and `inventoryLocationIds` (needs
 * `update:inventory:any`; a token without them reads as false, so deploy App
 * before tenant-api) and the Terminals page has a "Stock" toggle.
 */
export const STATION_INVENTORY_APP_KEY = 'inventory' as const

export const STATION_INVENTORY_GATE_CODES = [
	'inventory_not_enabled',
	'inventory_disabled',
	'inventory_needs_location',
	'inventory_needs_sign_in',
	'service_unavailable',
] as const

/** Routes, for clients and tests. `:id` is a server id. */
export const INVENTORY_POS_PATHS = {
	catalog: '/pos/inventory/catalog',
	startCount: '/pos/inventory/counts',
	count: (id: string) => `/pos/inventory/counts/${id}`,
	countEntries: (id: string) => `/pos/inventory/counts/${id}/entries`,
	sendCount: (id: string) => `/pos/inventory/counts/${id}/send`,
	waste: '/pos/inventory/waste',
	dishWaste: '/pos/inventory/waste/dishes',
	undoWaste: (id: string) => `/pos/inventory/waste/${id}/undo`,
	deliveries: '/pos/inventory/deliveries',
	deliveryPhoto: (id: string) => `/pos/inventory/deliveries/${id}/photo`,
	deliveryPhotoConfirm: (id: string) =>
		`/pos/inventory/deliveries/${id}/photo/confirm`,
} as const

// ── Error codes ─────────────────────────────────────────────────────────────

/** What the outbox does with a failure. */
export const STATION_FAILURE_ACTIONS = [
	/** Mark the item failed, show it to the person, go on with the next. */
	'permanent',
	/** Stop the run, keep every item, and wait for a person (sign in, a manager, an update, a switch). */
	'pause',
	/** Back off and try again (an outage; never drops an entry). */
	'retry',
	/** The terminal is unpaired: forget the secret (existing till behaviour). */
	'unpair',
] as const
export type StationFailureAction = (typeof STATION_FAILURE_ACTIONS)[number]

/**
 * Every code `/pos/inventory/*` answers with, its HTTP status and what the
 * outbox does (the punch-queue rule: an outage stops the run and never
 * drops an entry).
 */
export const STATION_ERROR_HANDLING = {
	invalid_request: { status: 400, action: 'permanent' },
	contract_too_old: { status: 400, action: 'pause' },
	/** The tablet speaks a newer contract than this region: wait for the region to be deployed. */
	contract_unsupported: { status: 400, action: 'pause' },
	invalid_device: { status: 401, action: 'unpair' },
	device_revoked: { status: 401, action: 'unpair' },
	staff_session_required: { status: 401, action: 'pause' },
	staff_session_invalid: { status: 401, action: 'pause' },
	inventory_not_enabled: { status: 403, action: 'pause' },
	inventory_disabled: { status: 403, action: 'pause' },
	inventory_needs_location: { status: 403, action: 'pause' },
	inventory_needs_sign_in: { status: 403, action: 'pause' },
	/** Receiving needs a till manager unless the location allows any staff. */
	receive_needs_manager: { status: 403, action: 'pause' },
	wrong_location: { status: 403, action: 'permanent' },
	not_found: { status: 404, action: 'permanent' },
	/**
	 * The count was approved or cancelled. Entries answer this per entry in
	 * `refused` (status 200); at request level it answers `send` on nothing.
	 */
	count_closed: { status: 409, action: 'permanent' },
	idempotency_conflict: { status: 409, action: 'permanent' },
	/** Prep: someone else changed the task (reload the board). */
	stale_version: { status: 409, action: 'permanent' },
	/** Prep: the task is already done or skipped. */
	task_closed: { status: 409, action: 'permanent' },
	/** Prep: the made item has no recipe, so a batch cannot be recorded. */
	recipe_empty: { status: 409, action: 'permanent' },
	undo_expired: { status: 409, action: 'permanent' },
	already_undone: { status: 409, action: 'permanent' },
	/** At request level; per-entry refusals come back in `refused` with 200. */
	reason_not_allowed: { status: 400, action: 'permanent' },
	unit_mismatch: { status: 400, action: 'permanent' },
	payload_too_large: { status: 413, action: 'permanent' },
	/** Photos only: the node has no storage; keep the delivery, drop the photo. */
	upload_not_configured: { status: 503, action: 'permanent' },
	rate_limited: { status: 429, action: 'retry' },
	service_unavailable: { status: 503, action: 'retry' },
	internal_error: { status: 500, action: 'retry' },
	pos_disabled: { status: 503, action: 'pause' },
	inventory_unavailable: { status: 503, action: 'pause' },
} as const satisfies Record<
	string,
	{ status: number; action: StationFailureAction }
>
export type InventoryPosErrorCode = keyof typeof STATION_ERROR_HANDLING
export const INVENTORY_POS_ERROR_CODES = Object.keys(
	STATION_ERROR_HANDLING,
) as InventoryPosErrorCode[]

/**
 * What to do with a failed attempt. An unknown code follows its status: 5xx
 * and 429 and 408 retry; a network failure (`status` 0) retries; any other
 * 4xx is permanent for that item.
 */
export function classifyStationFailure(input: {
	status: number
	code?: string | null
}): StationFailureAction {
	const known =
		input.code && input.code in STATION_ERROR_HANDLING
			? STATION_ERROR_HANDLING[input.code as InventoryPosErrorCode]
			: null
	if (known) return known.action
	if (input.status === 0 || input.status === 408 || input.status === 429) {
		return 'retry'
	}
	if (input.status >= 500) return 'retry'
	return 'permanent'
}

/** 5xx with nothing answered, 502, 503, 504, 429 and a dropped network: stop the run. */
export function isStationOutage(status: number): boolean {
	return status === 0 || status === 429 || (status >= 500 && status <= 599)
}

/** Seconds between attempts, as the till's order queue. */
export const STATION_BACKOFF_MS = [
	5_000,
	15_000,
	60_000,
	5 * 60_000,
	15 * 60_000,
] as const

/** Wait after `attempts` failed tries (1 = the first failure). */
export function stationBackoffMs(attempts: number): number {
	const index = Math.min(
		Math.max(Math.trunc(attempts), 1),
		STATION_BACKOFF_MS.length,
	)
	return STATION_BACKOFF_MS[index - 1]!
}

/** Whether something made at `madeAt` is old enough on arrival to be flagged `lateSync`. */
export function isLateSync(madeAt: number, now: number): boolean {
	return now - madeAt > STATION_LATE_SYNC_MS
}

/** The oldest `madeAt` the region believes (a dead tablet clock books to 1970 otherwise). */
export const STATION_MADE_AT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** The furthest `madeAt` may be ahead of the region's clock (skew), never more. */
export const STATION_MADE_AT_MAX_AHEAD_MS = 5 * 60 * 1000

/**
 * What the region does with a tablet's `madeAt` (device clock, epoch ms):
 *
 * - absent, or ahead of the region's clock by any amount: the region's `now`
 *   (a far-future value is never trusted; up to 5 minutes ahead is clock skew
 *   and clamps to `now` as well, flagged nothing);
 * - within the last 7 days: believed as sent, `late` when older than
 *   `STATION_LATE_SYNC_MS`;
 * - older than 7 days: not believed. It is booked as `now` and `late` is true,
 *   so a manager sees it among the late syncs; `reason` says why.
 */
export function clampMadeAt(
	madeAt: number | undefined,
	now: number,
): {
	at: number
	late: boolean
	reason: 'ok' | 'absent' | 'future' | 'too_old'
} {
	if (madeAt === undefined) return { at: now, late: false, reason: 'absent' }
	if (madeAt > now) {
		return { at: now, late: false, reason: 'future' }
	}
	if (now - madeAt > STATION_MADE_AT_MAX_AGE_MS) {
		return { at: now, late: true, reason: 'too_old' }
	}
	return { at: madeAt, late: isLateSync(madeAt, now), reason: 'ok' }
}

// ── Idempotency ─────────────────────────────────────────────────────────────

/**
 * Every write carries a client-made id (`crypto.randomUUID()` fits): the
 * outbox item's own id, kept across retries. The region records
 * `(scope = pos-inventory:<deviceId>:<kind>, key = clientId)` with a hash of
 * the request: the same id and body answers the first result (a batch lists
 * such entries in `duplicates`), the same id with a different body answers
 * 409 `idempotency_conflict`. Entries inside a batch are keyed individually
 * by their own `clientId`.
 */
export const stationIdempotencySchema = z
	.object({ clientId: clientIdSchema })
	.strict()
export type StationIdempotency = z.infer<typeof stationIdempotencySchema>

const staffIdSchema = inventoryIdSchema

/** Who made it and when, for an item sent later than it happened. */
const madeShape = {
	/**
	 * The staff id the till knew (absent: the session's person). Honoured only
	 * for the session's own id or a person active on this terminal's roster;
	 * any other id is ignored and the item is the session person's. The audit
	 * trail names the session person (`syncedBy`) whenever they differ.
	 */
	madeBy: staffIdSchema.optional(),
	/** Device clock when made, epoch ms (absent: now). Bounded by `clampMadeAt`. */
	madeAt: z.number().int().positive().optional(),
}

// ── Catalogue ───────────────────────────────────────────────────────────────

/**
 * `GET /pos/inventory/catalog?locationId=`: everything the tablet needs to
 * work offline at one location. NO money, NO on-hand, expected or last count
 * figures (nobody copies a number), no supplier contacts. Cacheable by
 * `version`: the answer carries `ETag: "<version>"`, and a request with
 * `If-None-Match: "<version>"` gets 304 with no body (and no-store). The
 * tablet refreshes every `STATION_CATALOG_REFRESH_MS` and on focus, and warns
 * after `STATION_CATALOG_STALE_MS` while still counting. Needs a session
 * like every call.
 */
/** A count as the tablet sees it: no money field exists. */
export const stationCountSummarySchema = countSummarySchema.omit({
	differenceValueMinor: true,
	currency: true,
})
export type StationCountSummary = z.infer<typeof stationCountSummarySchema>

export const stationCatalogQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()

export const stationItemSchema = z.object({
	id: z.string(),
	/** One plain name, as typed. */
	name: z.string(),
	category: z.string(),
	kind: inventoryItemKindSchema,
	baseUnit: inventoryBaseUnitSchema,
	/** How it is counted at this location. */
	countUnit: unitRefSchema,
	/** The item's named units (active only), so a unit switch can offer them. */
	units: z.array(itemUnitSchema),
	/** Storage areas at this location (empty: "Not in an area"). */
	areaIds: z.array(z.string()),
})
export type StationItem = z.infer<typeof stationItemSchema>

export const stationAreaSchema = z.object({
	id: z.string(),
	name: z.string(),
	sortOrder: z.number().int(),
	/** Shelf order. */
	itemIds: z.array(z.string()),
})

export const stationCountListSchema = z.object({
	id: z.string(),
	name: z.string(),
	itemIds: z.array(z.string()),
})

/** How the supplier sells an item: pack name and size, never a price. */
export const stationSupplierProductSchema = z.object({
	id: z.string(),
	itemId: z.string(),
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	pricedByWeight: z.boolean(),
})

export const stationSupplierSchema = z.object({
	id: z.string(),
	name: z.string(),
	products: z.array(stationSupplierProductSchema),
})

/** An open order the delivery tile can receive ("Today's expected deliveries"). */
export const stationExpectedDeliverySchema = z.object({
	orderId: z.string(),
	number: z.number().int(),
	supplierId: z.string(),
	supplierName: z.string(),
	status: orderStatusSchema,
	expectedDate: isoDateSchema.nullable(),
	lines: z.array(
		receivePrefillLineSchema.omit({
			packPriceMinor: true,
			lineTotalMinor: true,
		}),
	),
})
export type StationExpectedDelivery = z.infer<
	typeof stationExpectedDeliverySchema
>

export const stationCatalogSchema = z.object({
	contractVersion: z.number().int(),
	/** Opaque; equals the ETag. Changes when anything below changes. */
	version: z.string().min(8).max(64),
	generatedAt: z.number().int(),
	locationId: z.string(),
	settings: z.object({
		/** True: only a till manager (`pos_managers`) may receive a delivery. */
		receiveRequiresManager: z.boolean(),
		/** Largest invoice photo the region accepts, bytes. */
		photoMaxBytes: z.number().int(),
		/** The order feature is on (`inventory.purchasing`): expected deliveries are listed. */
		ordersEnabled: z.boolean(),
	}),
	items: z.array(stationItemSchema),
	areas: z.array(stationAreaSchema),
	countLists: z.array(stationCountListSchema),
	/** Counts in progress at the location (`counting`): "In progress" cards. */
	counts: z.array(stationCountSummarySchema),
	/** Reasons a person may pick (`PICKABLE_WASTE_REASONS`), so the region can narrow the list later. */
	wasteReasons: z.array(wasteReasonSchema),
	/** Items most recently wasted at this terminal, newest first (at most `STATION_RECENT_WASTE_ITEMS`). */
	recentWasteItemIds: z.array(z.string()),
	suppliers: z.array(stationSupplierSchema),
	/** Open orders for this location (sent and partly received, and drafts the office has not sent are left out). */
	expectedDeliveries: z.array(stationExpectedDeliverySchema),
})
export type StationCatalog = z.infer<typeof stationCatalogSchema>

// ── Counts ──────────────────────────────────────────────────────────────────

/**
 * `POST /pos/inventory/counts`: start a count, or join the one being counted
 * (`counting`) for the same location and list: unlike the operator route (409
 * `count_in_progress`), this answers that count with `joined: true`, so two
 * tablets share one count. A count in `in_review` is never joined: while the
 * office has not approved last week's count, a start makes a new count (its
 * approval is independent). Idempotent by `clientId`.
 */
export const stationStartCountSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		listId: inventoryIdSchema.nullable(),
		...madeShape,
	})
	.strict()

export const stationStartCountResultSchema = z.object({
	count: stationCountSummarySchema,
	joined: z.boolean(),
})

/** `GET /pos/inventory/counts/:id`: the counting sheet (`countSheetSchema` without the money fields: no expected figures; `mine` is this person's last typed amounts). */
export const stationCountSheetSchema = countSheetSchema.extend({
	count: stationCountSummarySchema,
})

/**
 * `POST /pos/inventory/counts/:id/entries`: up to 200 entries in the
 * operator shape (`countEntrySchema`) plus who and when. Each person's latest
 * entry per item, area and unit slot wins (the live-entry rule is on
 * `countEntrySchema`); `amount: null` clears it. Idempotent per entry
 * `clientId`: a stored or in-request repeat is in `duplicates` and keeps its
 * first result, even after the count has closed.
 *
 * Entries are taken while the count is `counting` OR `in_review` (a tablet
 * that syncs late still lands in the review). Only an `approved` or
 * `cancelled` count refuses, and only per entry: `refused` carries
 * `{ clientId, code: 'count_closed' }` with status 200 and the rest of the
 * request is handled normally (it never answers 409 for the whole request).
 * Every refusal code is one of `COUNT_ENTRY_REFUSAL_CODES`. The tablet lists
 * refused entries with their reason until a person clears them; the region
 * keeps no copy of a refused entry. Answers `countEntriesResultSchema`.
 */
export const stationCountEntrySchema = z
	.object({ ...countEntrySchema.shape, ...madeShape })
	.strict()

export const stationCountEntriesSchema = z
	.object({ entries: z.array(stationCountEntrySchema).min(1).max(200) })
	.strict()

export const stationCountEntriesResultSchema = countEntriesResultSchema

/**
 * `POST /pos/inventory/counts/:id/send` (contract 2): this tablet's "I'm done
 * counting". It is a per-device note, not a state change: the region records an
 * audit row (`count.device_done` with the device id) and answers 200 with the
 * count's UNCHANGED summary (`status` stays `counting` or `in_review`; an
 * approved or cancelled count also answers 200 with its status and records
 * nothing). One tablet therefore never closes the count for the others, and a
 * late tablet can keep sending entries. The count moves `counting` ->
 * `in_review` only through the operator route (the App's "Finish"), and is
 * approved only there. Contract 1 tablets get the same behaviour. Idempotent by
 * `clientId`. Answers `stationCountSummarySchema`.
 */
export const stationSendCountSchema = z
	.object({ clientId: clientIdSchema, ...madeShape })
	.strict()

// ── Waste ───────────────────────────────────────────────────────────────────

/**
 * `POST /pos/inventory/waste`: up to 50 entries in the operator shape
 * (`wasteEntryInputSchema`, each with its `locationId`, which must be the
 * terminal's) plus who and when. Reasons are the pickable ones only. Entries
 * made more than 48 hours before arrival are accepted and listed in
 * `lateSync`; `madeAt` follows `clampMadeAt` (never trusted into the future or
 * further back than 7 days). Entries refused individually are in `refused`
 * with 200 and one of `WASTE_ENTRY_REFUSAL_CODES`. A `clientId` repeated
 * inside one request answers `duplicates` for the later one, never a 500.
 */
export const stationWasteEntrySchema = z
	.object({ ...wasteEntryInputSchema.shape, ...madeShape })
	.strict()

export const stationWasteSchema = z
	.object({ entries: z.array(stationWasteEntrySchema).min(1).max(50) })
	.strict()

export const stationWasteResultSchema = z.object({
	accepted: z.array(
		z.object({
			clientId: z.string(),
			id: z.string(),
			quantity: z.number().int(),
		}),
	),
	duplicates: z.array(z.object({ clientId: z.string(), id: z.string() })),
	refused: z.array(z.object({ clientId: z.string(), code: z.string() })),
	/** `clientId`s accepted but flagged `late_sync`. */
	lateSync: z.array(z.string()),
})

/**
 * `POST /pos/inventory/waste/dishes` (phase 3, Kitchen "Log it as waste?"):
 * the dishes a cook had already started when the ticket was cancelled, voided
 * or refunded, recorded as waste with the reason "Cancelled after cooking".
 * Never automatic: the cook knows whether the food was saved. Online only
 * (Kitchen rules: read back after an uncertain write, never replayed blindly).
 *
 * Lines are dishes as the kitchen board knows them: a menu item id, the size
 * (variant) when there is one, and how many. The region expands each dish
 * with the recipe in force now into its ingredients (an `inv_waste` row per
 * ingredient, "Cancelled after cooking") and answers how many ingredient
 * entries it wrote and how many dishes had no recipe (nothing to take out).
 * It needs `inventory.recipes`; without it the answer is 403
 * `inventory_disabled`. `clientId` makes a repeat answer the first result
 * (`duplicate`). No money.
 */
export const stationDishWasteLineSchema = z
	.object({
		itemId: z.string().min(1).max(100),
		variantId: z.string().min(1).max(100).nullable().optional(),
		quantity: z.number().int().min(1).max(50),
	})
	.strict()
export const stationDishWasteSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		lines: z.array(stationDishWasteLineSchema).min(1).max(50),
	})
	.strict()
export const stationDishWasteResultSchema = z.object({
	/** Ingredient waste entries written. */
	logged: z.number().int().nonnegative(),
	/** Dishes in the request with no recipe: nothing was taken out for them. */
	withoutRecipe: z.number().int().nonnegative(),
	duplicate: z.boolean(),
})
export type StationDishWasteResult = z.infer<
	typeof stationDishWasteResultSchema
>

/**
 * `POST /pos/inventory/waste/:id/undo` (`undoWasteSchema`: the undo's own
 * `clientId`): the person's own entry from this terminal, within
 * `STATION_WASTE_UNDO_SERVER_MS` of when the region stored it (the UI offers
 * `STATION_WASTE_UNDO_UI_MS`). An entry still waiting in the queue is simply
 * removed from the queue instead. Answers `{ id }` of the reversing entry.
 */
export const stationUndoWasteSchema = undoWasteSchema
export const stationUndoWasteResultSchema = z.object({ id: z.string() })

// ── Deliveries ──────────────────────────────────────────────────────────────

/**
 * One received line, quantities only. `quantity` is what went into stock in
 * base thousandths (the tablet works it out from packs, or the typed real
 * weight for a priced-by-weight line).
 */
export const stationDeliveryLineSchema = z
	.object({
		itemId: deliveryLineInputSchema.shape.itemId,
		supplierProductId: deliveryLineInputSchema.shape.supplierProductId,
		quantity: deliveryLineInputSchema.shape.quantity,
		packs: deliveryLineInputSchema.shape.packs,
		packName: deliveryLineInputSchema.shape.packName,
		packBaseQuantity: deliveryLineInputSchema.shape.packBaseQuantity,
		realWeightQuantity: deliveryLineInputSchema.shape.realWeightQuantity,
		orderLineId: deliveryLineInputSchema.shape.orderLineId,
	})
	.strict()

/**
 * `POST /pos/inventory/deliveries`: a quantity-only delivery
 * (`quantityOnly` is implied: there is no money here and the region stores
 * `pricesPending: true`, `source: 'station'`). Needs a till manager unless
 * the location allows any staff (403 `receive_needs_manager`). `orderId`
 * receives against an order; unlike the operator route the goods arrived, so
 * an order that is closed, unknown or for another supplier does NOT refuse
 * the delivery: it is recorded unlinked and `orderLinkIgnored` says why.
 * `closeOrder` (nothing more is coming) closes a linked order as `received`.
 * Idempotent by `clientId`; the photo follows (`deliveryPhoto`).
 */
export const stationDeliverySchema = z
	.object({
		clientId: recordDeliveryBaseSchema.shape.clientId,
		locationId: recordDeliveryBaseSchema.shape.locationId,
		supplierId: recordDeliveryBaseSchema.shape.supplierId,
		orderId: recordDeliveryBaseSchema.shape.orderId,
		closeOrder: recordDeliveryBaseSchema.shape.closeOrder,
		invoiceNumber: recordDeliveryBaseSchema.shape.invoiceNumber,
		invoiceDate: recordDeliveryBaseSchema.shape.invoiceDate,
		lines: z.array(stationDeliveryLineSchema).min(1).max(200),
		...madeShape,
	})
	.strict()
export type StationDelivery = z.infer<typeof stationDeliverySchema>

export const stationDeliveryResultSchema = z.object({
	id: z.string(),
	lineCount: z.number().int(),
	receivedAt: z.number().int(),
	pricesPending: z.literal(true),
	lateSync: z.boolean(),
	/** The same `clientId` was already stored: this is the first result. */
	duplicate: z.boolean(),
	order: z.object({ id: z.string(), status: orderStatusSchema }).nullable(),
	orderLinkIgnored: z
		.enum(['closed', 'not_found', 'wrong_supplier'])
		.nullable(),
})
export type StationDeliveryResult = z.infer<typeof stationDeliveryResultSchema>

/**
 * `POST /pos/inventory/deliveries/:id/photo` asks for an upload target
 * (`invoicePhotoRequestSchema` → `invoicePhotoUploadSchema`, same limits as
 * the operator route) and `POST .../photo/confirm` (`confirmInvoicePhotoSchema`)
 * answers `{ ok: true }`. Needs the same receive permission as the delivery.
 */
export const stationPhotoRequestSchema = invoicePhotoRequestSchema
export const stationPhotoUploadSchema = invoicePhotoUploadSchema
export const stationPhotoConfirmResultSchema = z.object({ ok: z.literal(true) })

// ── The tablet's outbox (Dexie `stockQueue`, version 7) ─────────────────────

export const STATION_OUTBOX_KINDS = [
	'count_start',
	'count_entry',
	'count_send',
	'waste',
	'waste_undo',
	'delivery',
	'delivery_photo',
] as const
export type StationOutboxKind = (typeof STATION_OUTBOX_KINDS)[number]

/**
 * A count, as the tablet knows it: the server id once it has one, or the
 * `clientId` of the start item still waiting in the queue. The runner sends
 * oldest first and replaces a `{ clientId }` reference with the server id the
 * earlier item returned before it sends the dependent one (entries for a
 * count started offline). The same for a delivery (`delivery_photo`) and a
 * waste entry (`waste_undo`).
 */
export const stationRefSchema = z.union([
	z.object({ id: inventoryIdSchema }).strict(),
	z.object({ clientId: clientIdSchema }).strict(),
])
export type StationRef = z.infer<typeof stationRefSchema>

const outboxBase = {
	/** The item's own id and its idempotency key (`clientId` of the request it becomes). */
	id: clientIdSchema,
	locationId: inventoryLocationIdSchema,
	/** The staff id the till knew when it was made. */
	madeBy: staffIdSchema.nullable(),
	/** Device clock when made, epoch ms. */
	madeAt: z.number().int().positive(),
	createdAt: z.number().int().positive(),
	/** Failed tries so far (drives `stationBackoffMs`). */
	attempts: z.number().int().min(0),
	/** Earliest next try, epoch ms, or null for now. */
	nextAttemptAt: z.number().int().nullable(),
	/**
	 * `queued` waiting, `syncing` claimed by one tab (a claim older than 20 s
	 * belongs to a dead tab), `failed` refused for good and listed to the
	 * person until cleared. A settled item is deleted.
	 */
	status: z.enum(['queued', 'syncing', 'failed']),
	/** `InventoryPosErrorCode` (or an unknown code) of the last refusal; shown to the person. */
	failure: z.string().max(64).nullable(),
}

/**
 * One row of the tablet's `stockQueue` store. The payload is exactly what the
 * server takes for that kind, without the envelope fields the runner adds
 * (`clientId` = `id`, `madeBy`, `madeAt`, `locationId`).
 */
export const stationOutboxItemSchema = z.discriminatedUnion('kind', [
	z.object({
		...outboxBase,
		kind: z.literal('count_start'),
		payload: z.object({ listId: inventoryIdSchema.nullable() }).strict(),
	}),
	z.object({
		...outboxBase,
		kind: z.literal('count_entry'),
		payload: z
			.object({
				count: stationRefSchema,
				/** `entry.clientId` equals the item's `id`. */
				entry: countEntrySchema,
			})
			.strict(),
	}),
	z.object({
		...outboxBase,
		kind: z.literal('count_send'),
		payload: z.object({ count: stationRefSchema }).strict(),
	}),
	z.object({
		...outboxBase,
		kind: z.literal('waste'),
		payload: z.object({ entry: wasteEntryInputSchema }).strict(),
	}),
	z.object({
		...outboxBase,
		kind: z.literal('waste_undo'),
		payload: z.object({ waste: stationRefSchema }).strict(),
	}),
	z.object({
		...outboxBase,
		kind: z.literal('delivery'),
		payload: stationDeliverySchema
			.omit({ clientId: true, locationId: true, madeBy: true, madeAt: true })
			.strict(),
	}),
	z.object({
		...outboxBase,
		kind: z.literal('delivery_photo'),
		payload: z
			.object({
				delivery: stationRefSchema,
				contentType: invoicePhotoRequestSchema.shape.contentType,
				sizeBytes: invoicePhotoRequestSchema.shape.sizeBytes,
				/** Key of the blob in the tablet's IndexedDB blob store. */
				blobKey: z.string().min(1).max(100),
			})
			.strict(),
	}),
])
export type StationOutboxItem = z.infer<typeof stationOutboxItemSchema>
