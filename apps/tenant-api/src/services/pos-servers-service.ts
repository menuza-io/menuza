import { and, eq, inArray, isNull } from 'drizzle-orm'
import { type PosServer } from '@repo/common/pos-orders'
import {
	staffMembers,
	staffPositions,
	timeEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { queryInChunks } from '../lib/chunked-in.ts'
import { scheduleSeam } from './schedule-seam.ts'

/** At most this many people: a floor has a handful of sections, not hundreds of servers. */
const MAX_SERVERS = 100
/** A shift that started up to this long before the window still covers it. */
const SHIFT_LOOKBACK_MS = 16 * 60 * 60_000

/**
 * Who can take a section of the floor during `window` at a workplace: people
 * clocked in there now (with the time clock on) and people whose published
 * shift there overlaps the window (with scheduling on). Names are a first name
 * and a last initial; nothing else about a person is read.
 */
export async function serversOnShift(
	db: TenantDatabase,
	input: {
		scopeId: string
		window: { from: number; to: number }
		timeclock: boolean
		scheduling: boolean
	},
): Promise<PosServer[]> {
	const byStaff = new Map<string, PosServer>()
	const named = new Map<string, { firstName: string; lastName: string }>()

	if (input.timeclock) {
		const clocked = await db
			.select({
				staffId: timeEntries.staffId,
				firstName: staffMembers.firstName,
				lastName: staffMembers.lastName,
				position: staffPositions.name,
			})
			.from(timeEntries)
			.innerJoin(staffMembers, eq(staffMembers.id, timeEntries.staffId))
			.leftJoin(staffPositions, eq(staffPositions.id, timeEntries.positionId))
			.where(
				and(
					eq(timeEntries.scopeId, input.scopeId),
					isNull(timeEntries.clockOutAt),
					isNull(timeEntries.voidedAt),
					isNull(staffMembers.terminatedAt),
				),
			)
			.limit(MAX_SERVERS)
		for (const row of clocked) {
			named.set(row.staffId, row)
			byStaff.set(row.staffId, {
				staffId: row.staffId,
				firstName: row.firstName,
				lastInitial: initial(row.lastName),
				position: row.position ?? null,
				onClock: true,
				shift: null,
			})
		}
	}

	if (input.scheduling) {
		const shifts =
			(await scheduleSeam.listShifts(db, {
				startsFromMs: input.window.from - SHIFT_LOOKBACK_MS,
				startsToMs: input.window.to,
				scopeId: input.scopeId,
				limit: MAX_SERVERS * 2,
			})) ?? []
		const overlapping = shifts.filter(
			(shift) => shift.endAt > input.window.from,
		)
		const unnamed = [
			...new Set(
				overlapping
					.map((shift) => shift.staffId)
					.filter((id) => !named.has(id)),
			),
		]
		const people = await queryInChunks(unnamed, (chunk) =>
			db
				.select({
					id: staffMembers.id,
					firstName: staffMembers.firstName,
					lastName: staffMembers.lastName,
					terminatedAt: staffMembers.terminatedAt,
				})
				.from(staffMembers)
				.where(inArray(staffMembers.id, chunk)),
		)
		for (const person of people)
			if (person.terminatedAt === null) named.set(person.id, person)
		const positionIds = [
			...new Set(
				overlapping.flatMap((shift) =>
					shift.positionId ? [shift.positionId] : [],
				),
			),
		]
		const positions = new Map(
			(
				await queryInChunks(positionIds, (chunk) =>
					db
						.select({ id: staffPositions.id, name: staffPositions.name })
						.from(staffPositions)
						.where(inArray(staffPositions.id, chunk)),
				)
			).map((position) => [position.id, position.name]),
		)
		// The shift nearest the window for each person (the earliest that overlaps it).
		for (const shift of overlapping.sort((a, b) => a.startAt - b.startAt)) {
			const person = named.get(shift.staffId)
			if (!person) continue
			const known = byStaff.get(shift.staffId)
			if (known) {
				known.shift ??= { startAt: shift.startAt, endAt: shift.endAt }
				known.position ??= shift.positionId
					? (positions.get(shift.positionId) ?? null)
					: null
				continue
			}
			byStaff.set(shift.staffId, {
				staffId: shift.staffId,
				firstName: person.firstName,
				lastInitial: initial(person.lastName),
				position: shift.positionId
					? (positions.get(shift.positionId) ?? null)
					: null,
				onClock: false,
				shift: { startAt: shift.startAt, endAt: shift.endAt },
			})
		}
	}

	// On the floor already first, then by when their shift starts, then by name.
	return [...byStaff.values()]
		.sort(
			(a, b) =>
				Number(b.onClock) - Number(a.onClock) ||
				(a.shift?.startAt ?? 0) - (b.shift?.startAt ?? 0) ||
				a.firstName.localeCompare(b.firstName) ||
				a.lastInitial.localeCompare(b.lastInitial),
		)
		.slice(0, MAX_SERVERS)
}

const initial = (lastName: string) => [...lastName.trim()][0] ?? ''
