import {
	type PosAvailabilityCommand,
	type PosPauseCommand,
	type PosStationControls,
} from '@repo/common/pos-station-controls'
import { type TenantDatabase, invItems, invSoldOut } from '@repo/tenant-db'
import { and, asc, eq } from 'drizzle-orm'
import { getNodeRegion } from '../lib/region.ts'
import {
	postStationControls,
	type StationControlsOutcome,
} from '../lib/station-controls.ts'
import { undoSoldOut } from './inventory-sold-out-service.ts'

/**
 * Station's manager controls at the terminal's location: online ordering's
 * pause and a dish's sold-out switch. The route checked the device, the Orders
 * switch, its server-bound location, the sign-in and the manager role; this
 * asks the App with ids only (`postStationControls`) and never queues.
 */
export type StationControlsActor = {
	orgId: string
	locationId: string
	deviceId: string
	staffId: string
}

export type StationControlsFailure = {
	status: 404 | 409 | 503
	code: 'controls_unavailable' | 'location_not_found' | 'held_by_stock'
}

type Post = typeof postStationControls
type Result<T> =
	{ ok: true; data: T } | { ok: false; failure: StationControlsFailure }

function failed(outcome: Extract<StationControlsOutcome, { ok: false }>) {
	return {
		ok: false as const,
		failure: {
			status:
				outcome.code === 'location_not_found' ? (404 as const) : (503 as const),
			code: outcome.code,
		},
	}
}

/** What stock (inventory auto sold out) holds off the menu here right now. */
async function heldByStock(db: TenantDatabase, locationId: string) {
	return db
		.select({
			id: invSoldOut.id,
			entityType: invSoldOut.entityType,
			entityId: invSoldOut.entityId,
			causeItemName: invItems.name,
		})
		.from(invSoldOut)
		.innerJoin(invItems, eq(invItems.id, invSoldOut.causeItemId))
		.where(
			and(eq(invSoldOut.locationId, locationId), eq(invSoldOut.state, 'out')),
		)
		.orderBy(asc(invSoldOut.soldAt), asc(invSoldOut.id))
		.limit(500)
}

async function controls(
	db: TenantDatabase,
	actor: StationControlsActor,
	pause: PosStationControls['pause'],
): Promise<PosStationControls> {
	return {
		locationId: actor.locationId,
		pause,
		heldByStock: await heldByStock(db, actor.locationId),
		serverNow: Date.now(),
	}
}

export async function stationControlsState(
	db: TenantDatabase,
	actor: StationControlsActor,
	post: Post = postStationControls,
): Promise<Result<PosStationControls>> {
	const outcome = await post({
		kind: 'state',
		orgId: actor.orgId,
		locationId: actor.locationId,
	})
	if (!outcome.ok) return failed(outcome)
	return { ok: true, data: await controls(db, actor, outcome.result.pause) }
}

/** Pauses or resumes online ordering at this location only, with the App's presets. */
export async function stationPause(
	db: TenantDatabase,
	actor: StationControlsActor,
	command: PosPauseCommand,
	post: Post = postStationControls,
): Promise<Result<PosStationControls>> {
	const who = { deviceId: actor.deviceId, staffId: actor.staffId }
	const outcome = await post(
		command.action === 'pause'
			? {
					kind: 'pause',
					orgId: actor.orgId,
					locationId: actor.locationId,
					duration: command.duration,
					actor: who,
				}
			: {
					kind: 'resume',
					orgId: actor.orgId,
					locationId: actor.locationId,
					actor: who,
				},
	)
	if (!outcome.ok) return failed(outcome)
	return { ok: true, data: await controls(db, actor, outcome.result.pause) }
}

/**
 * Marks a dish or option sold out here, or brings it back. One that stock
 * took off comes back only with `overrideStock`, and then through
 * inventory's own undo, so the next stock sync leaves it on until the
 * ingredient has been in stock again.
 */
export async function stationAvailability(
	db: TenantDatabase,
	actor: StationControlsActor,
	command: PosAvailabilityCommand,
	options: {
		post?: Post
		undo?: typeof undoSoldOut
	} = {},
): Promise<Result<PosStationControls & { changed: boolean }>> {
	const post = options.post ?? postStationControls
	let undone = false
	if (command.available) {
		const [held] = await db
			.select({ id: invSoldOut.id })
			.from(invSoldOut)
			.where(
				and(
					eq(invSoldOut.locationId, actor.locationId),
					eq(invSoldOut.entityType, command.entityType),
					eq(invSoldOut.entityId, command.entityId),
					eq(invSoldOut.state, 'out'),
				),
			)
			.limit(1)
		if (held) {
			if (!command.overrideStock)
				return {
					ok: false,
					failure: { status: 409, code: 'held_by_stock' },
				}
			try {
				await (options.undo ?? undoSoldOut)(
					{
						orgId: actor.orgId,
						region: getNodeRegion(),
						actor: { kind: 'staff', id: actor.staffId },
						locationIds: [actor.locationId],
						cost: false,
						purchasing: false,
					},
					{ id: held.id },
				)
				undone = true
			} catch {
				return {
					ok: false,
					failure: { status: 503, code: 'controls_unavailable' },
				}
			}
		}
	}
	// Recorded as the person's own change too (the activity log), and it brings
	// back a dish this location's setting still holds off after the undo.
	const outcome = await post({
		kind: 'availability',
		orgId: actor.orgId,
		locationId: actor.locationId,
		entityType: command.entityType,
		entityId: command.entityId,
		available: command.available,
		actor: { deviceId: actor.deviceId, staffId: actor.staffId },
	})
	if (!outcome.ok) return failed(outcome)
	return {
		ok: true,
		data: {
			...(await controls(db, actor, outcome.result.pause)),
			changed: undone || outcome.result.changed === true,
		},
	}
}
