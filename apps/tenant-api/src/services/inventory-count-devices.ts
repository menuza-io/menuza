import { COUNT_DEVICE_SILENT_MS, type CountDevice } from '@repo/inventory'
import { invCountDevices, staffMembers } from '@repo/tenant-db'
import { eq, inArray } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import {
	type InventoryReader,
	type InventoryTx,
} from '../lib/inventory-write.ts'
import { type InventoryActor } from './inventory-common.ts'

/**
 * Who is still counting (#474). Each device (a Station terminal, a browser, a
 * phone) and person that joins a count is one row with the last time it synced
 * and how many entries it said it still holds. A device is "not responding"
 * after two hours without a sync; it is "done" once it said so. Nothing here
 * blocks counting: the review warns, and "Approve anyway" is the manager's call.
 */

type DeviceRow = typeof invCountDevices.$inferSelect

export function deviceState(
	row: Pick<DeviceRow, 'doneAt' | 'lastSyncAt'>,
	now: number,
): CountDevice['state'] {
	if (row.doneAt !== null) return 'done'
	return now - row.lastSyncAt > COUNT_DEVICE_SILENT_MS
		? 'not_responding'
		: 'counting'
}

export type DeviceReport = {
	id: string
	kind: 'station' | 'app' | 'phone'
	name?: string | null
	/** Entries still unsent after this request; null = not reported. */
	unsent: number | null
	/** The person said they are done. */
	done?: boolean
}

/** Records one sync from a device (insert or update); a report without `done` means counting again. */
export async function recordCountDevice(
	tx: InventoryTx,
	input: {
		countId: string
		device: DeviceReport
		person: InventoryActor
		now: number
	},
): Promise<void> {
	const { device, person } = input
	const done = device.done === true
	await tx
		.insert(invCountDevices)
		.values({
			countId: input.countId,
			deviceId: device.id,
			deviceKind: device.kind,
			deviceName: device.name?.slice(0, 60) ?? null,
			personKind: person.kind,
			personId: person.id,
			joinedAt: input.now,
			lastSyncAt: input.now,
			unsentCount: device.unsent,
			doneAt: done ? input.now : null,
		})
		.onConflictDoUpdate({
			target: [invCountDevices.countId, invCountDevices.deviceId],
			set: {
				deviceName: device.name?.slice(0, 60) ?? null,
				personKind: person.kind,
				personId: person.id,
				lastSyncAt: input.now,
				unsentCount: device.unsent,
				doneAt: done ? input.now : null,
			},
		})
}

export async function listCountDevices(
	db: InventoryReader,
	countId: string,
	now: number,
): Promise<CountDevice[]> {
	const rows = await db
		.select()
		.from(invCountDevices)
		.where(eq(invCountDevices.countId, countId))
		.orderBy(invCountDevices.joinedAt, invCountDevices.deviceId)
	return rows.map((row) => ({
		deviceId: row.deviceId,
		name: row.deviceName,
		kind: row.deviceKind,
		person: { kind: row.personKind, id: row.personId },
		joinedAt: row.joinedAt,
		lastSyncAt: row.lastSyncAt,
		unsentCount: row.unsentCount,
		state: deviceState(row, now),
	}))
}

/** Devices that joined and have not said they are done, per count. */
export async function countDevicesStillCounting(
	db: InventoryReader,
	countIds: readonly string[],
): Promise<Map<string, number>> {
	const rows = await queryInChunks(countIds, (chunk) =>
		db
			.select({
				countId: invCountDevices.countId,
				doneAt: invCountDevices.doneAt,
			})
			.from(invCountDevices)
			.where(inArray(invCountDevices.countId, chunk)),
	)
	const result = new Map<string, number>()
	for (const row of rows) {
		if (row.doneAt === null) {
			result.set(row.countId, (result.get(row.countId) ?? 0) + 1)
		}
	}
	return result
}

/**
 * One person, whatever they signed in with: a staff member who also has an App
 * login is that login's person (staff keep the control-plane user id). Used by
 * the second-person check so nobody checks their own count under another name.
 */
export async function personKeys(
	db: InventoryReader,
	actors: ReadonlyArray<InventoryActor>,
): Promise<Map<string, string>> {
	const staffIds = [
		...new Set(
			actors
				.filter((actor) => actor.kind === 'staff' && actor.id)
				.map((actor) => actor.id!),
		),
	]
	const rows = await queryInChunks(staffIds, (chunk) =>
		db
			.select({ id: staffMembers.id, userId: staffMembers.userId })
			.from(staffMembers)
			.where(inArray(staffMembers.id, chunk)),
	)
	const userOfStaff = new Map(rows.map((row) => [row.id, row.userId]))
	const out = new Map<string, string>()
	for (const actor of actors) {
		out.set(actorKey(actor), canonicalKey(actor, userOfStaff))
	}
	return out
}

export const actorKey = (actor: InventoryActor): string =>
	`${actor.kind}|${actor.id ?? ''}`

function canonicalKey(
	actor: InventoryActor,
	userOfStaff: ReadonlyMap<string, string | null>,
): string {
	if (actor.kind === 'staff' && actor.id) {
		const user = userOfStaff.get(actor.id)
		return user ? `person|${user}` : `person|staff:${actor.id}`
	}
	if (actor.kind === 'operator' && actor.id) return `person|${actor.id}`
	return `person|${actorKey(actor)}`
}
