import { type Context } from 'hono'
import { type ZodNull, type ZodTypeAny, type z } from 'zod'
import {
	INVENTORY_POS_CONTRACT_HEADER,
	INVENTORY_POS_MIN_CONTRACT_VERSION,
	STATION_ERROR_HANDLING,
	type InventoryErrorCode,
	type InventoryPosErrorCode,
} from '@repo/inventory'
import { InventoryError } from './inventory-http.ts'
import { NO_STORE, validationBody } from './http.ts'
import {
	authenticatePosDevice,
	isPosHashUnavailable,
	posUnavailableResponse,
	type PosAuth,
} from './pos-auth.ts'
import {
	verifyPosStaffSession,
	type PosStaffSession,
} from './pos-staff-session.ts'
import { getNodeRegion } from './region.ts'
import { getInventorySettings } from '../services/inventory-settings-service.ts'
import { type InventoryCaller } from '../services/inventory-items-service.ts'
import { inventoryGate } from '../services/pos-apps-service.ts'
import { touchDevice } from '../services/pos-service.ts'

/**
 * Plumbing of `/pos/inventory/*`, the Station Stock app's regional API (wire
 * contract: `packages/inventory/src/contract/station.ts`).
 *
 * Every call checks, in this order: the paired terminal (device secret, kill
 * switch, revocation), the contract version, the Stock gate (the terminal's
 * switch, staff sign-in, a location, the organization's flag, the node kill
 * switch), the location the request names (the terminal's own, else 403
 * `wrong_location`), then the signed-in person (`Pos-Staff-Session`). A body
 * that does not parse is refused only after the person is known, so a caller
 * with no session learns nothing from the shape of an error.
 *
 * Every answer is `private, no-store` JSON and every error is
 * `{ error: <InventoryPosErrorCode> }` with the status of
 * `STATION_ERROR_HANDLING`. Nothing here echoes a request value.
 */

/** Largest request body read (a batch of 200 count entries or delivery lines is far below). */
export const POS_INVENTORY_MAX_BODY_BYTES = 256_000

export function stationError(
	code: InventoryPosErrorCode,
	extra: Record<string, unknown> = {},
): Response {
	return Response.json(
		{ error: code, ...extra },
		{ status: STATION_ERROR_HANDLING[code].status, headers: NO_STORE },
	)
}

export function stationJson(body: unknown, status: 200 | 201 = 200): Response {
	return Response.json(body, { status, headers: NO_STORE })
}

/**
 * Maps a regional inventory error onto the codes the Station contract knows.
 * A record in another location is a plain 404 (never "forbidden", which would
 * say it exists); a state conflict the tablet cannot act on is
 * `invalid_request`; anything unknown is rethrown (a 500, logged by name).
 */
const POS_CODE_OF: Partial<Record<InventoryErrorCode, InventoryPosErrorCode>> =
	{
		not_found: 'not_found',
		location_forbidden: 'not_found',
		count_closed: 'count_closed',
		idempotency_conflict: 'idempotency_conflict',
		undo_expired: 'undo_expired',
		already_undone: 'already_undone',
		reason_not_allowed: 'reason_not_allowed',
		unit_mismatch: 'unit_mismatch',
		upload_not_configured: 'upload_not_configured',
		inventory_unavailable: 'inventory_unavailable',
		inventory_disabled: 'inventory_disabled',
		invalid_request: 'invalid_request',
		// A delivery against an order is never refused on the tablet, and the
		// operator-only states cannot be reached from it; if one slips through it
		// is a request the tablet cannot fix.
		order_closed: 'invalid_request',
		supplier_mismatch: 'invalid_request',
		order_not_editable: 'invalid_request',
	}

export function stationErrorFrom(error: unknown): Response | null {
	if (!(error instanceof InventoryError)) return null
	const code = POS_CODE_OF[error.code]
	return code ? stationError(code) : null
}

function invalidRequest(error?: z.ZodError): Response {
	return stationError(
		'invalid_request',
		error
			? {
					issues: validationBody(error).issues.map(({ path, code }) => ({
						path,
						code,
					})),
				}
			: {},
	)
}

/**
 * `Pos-Inventory-Contract`: missing means 1. A tablet older than the oldest
 * version the region serves must update (400 `contract_too_old`, a pause
 * code). A tablet never runs ahead of its server (deploys go region first),
 * so a newer number is simply accepted.
 */
function checkContractVersion(c: Context): Response | null {
	const raw = c.req.header(INVENTORY_POS_CONTRACT_HEADER)
	if (raw === undefined) {
		return INVENTORY_POS_MIN_CONTRACT_VERSION > 1
			? stationError('contract_too_old')
			: null
	}
	if (!/^\d{1,6}$/.test(raw.trim())) return invalidRequest()
	return Number(raw) < INVENTORY_POS_MIN_CONTRACT_VERSION
		? stationError('contract_too_old')
		: null
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response }

/** A strict JSON body. Too large is 413, anything else unreadable is `invalid_request`. */
async function readJson<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<Parsed<z.infer<S>>> {
	const tooLarge = () => ({
		ok: false as const,
		response: stationError('payload_too_large'),
	})
	if (
		Number(c.req.header('content-length') ?? 0) > POS_INVENTORY_MAX_BODY_BYTES
	) {
		return tooLarge()
	}
	const text = await c.req.text().catch(() => '')
	if (text.length > POS_INVENTORY_MAX_BODY_BYTES) return tooLarge()
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return { ok: false, response: invalidRequest() }
	}
	const parsed = schema.safeParse(raw)
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, response: invalidRequest(parsed.error) }
}

/** A strict query string. */
function readQuery<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Parsed<z.infer<S>> {
	const parsed = schema.safeParse(
		Object.fromEntries(new URL(c.req.url).searchParams),
	)
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, response: invalidRequest(parsed.error) }
}

export type StationCtx = {
	c: Context
	pos: PosAuth
	/** The terminal's own (server-bound) location. */
	locationId: string
	session: PosStaffSession
	/** What the services act for: the signed-in person, this terminal's location only, no money. */
	caller: InventoryCaller
	/** Whether this person may receive a delivery here (a till manager, or anyone when the organization allows it). */
	mayReceive: boolean
}

export type StationRouteSpec<S extends ZodTypeAny> = {
	/** The strict JSON body (POST). */
	body?: S
	/** The strict query string (GET). */
	query?: S
	/** Locations the request names; every one must be the terminal's. */
	locations?: (data: z.infer<S>) => readonly string[]
	/** The route is refused for someone who may not receive a delivery. */
	receive?: boolean
}

/**
 * Wraps a handler in the envelope: device, contract version, Stock gate,
 * location, session, permission, then the parsed input. Unexpected failures
 * are logged by name only and answered `internal_error`.
 */
export function stationRoute<S extends ZodTypeAny = ZodNull>(
	spec: StationRouteSpec<S>,
	handler: (ctx: StationCtx, data: z.infer<S>) => Promise<Response>,
) {
	return async (c: Context): Promise<Response> => {
		const authed = await authenticatePosDevice(c)
		if ('error' in authed) return authed.error
		const { pos } = authed
		try {
			const contract = checkContractVersion(c)
			if (contract) return contract
			const gate = await inventoryGate(pos.orgId, pos.device)
			if (!gate.ok) return stationError(gate.code)

			const input: Parsed<z.infer<S>> = spec.body
				? await readJson(c, spec.body)
				: spec.query
					? readQuery(c, spec.query)
					: { ok: true, data: null as z.infer<S> }
			if (
				input.ok &&
				spec.locations?.(input.data).some((id) => id !== gate.locationId)
			) {
				return stationError('wrong_location')
			}

			const staff = await verifyPosStaffSession(c, pos)
			if ('error' in staff) return staff.error
			const { session } = staff

			let mayReceive = false
			if (spec.receive) {
				mayReceive =
					session.role === 'manager' ||
					(await getInventorySettings(pos.db, getNodeRegion()))
						.anyStaffCanReceive === true
				if (!mayReceive) return stationError('receive_needs_manager')
			}
			if (!input.ok) return input.response

			await touchDevice(pos.db, pos.device).catch(() => {})
			return await handler(
				{
					c,
					pos,
					locationId: gate.locationId,
					session,
					mayReceive,
					caller: {
						orgId: pos.orgId,
						region: getNodeRegion(),
						actor: { kind: 'staff', id: session.staffId },
						locationIds: [gate.locationId],
						cost: false,
						purchasing: false,
					},
				},
				input.data,
			)
		} catch (error) {
			if (isPosHashUnavailable(error)) return posUnavailableResponse()
			const mapped = stationErrorFrom(error)
			if (mapped) return mapped
			console.error(
				`Station inventory failed (${c.req.method} ${c.req.routePath})`,
				error instanceof Error ? error.name : 'unknown',
			)
			return stationError('internal_error')
		}
	}
}
