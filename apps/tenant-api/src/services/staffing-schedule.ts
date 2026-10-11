import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	sql,
} from 'drizzle-orm'
import {
	addDays,
	daysBetween,
	type ShiftInput,
	type ShiftState,
	shiftInstants,
	type StaffingTokenClaims,
	staffingTokenAllowsLocation,
	staffingTokenLocationZone,
} from '@repo/staffing'
import {
	getTenantDb,
	type PublishedShift,
	schedulePublications,
	type SchedulePublication,
	type Shift,
	shifts,
	staffAssignments,
	staffMembers,
	staffPositions,
} from '@repo/tenant-db'

import { type StaffingAuth } from '../lib/staffing-auth.ts'
import {
	onStaffTerminated,
	readStaffingSettings,
	recordStaffEvent,
	type ServiceResult,
	StaffingAbort,
	withAbort,
} from './staffing-roster.ts'

type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
type Transaction = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]
type Writer = TenantDatabase | Transaction

const failure = (status: 400 | 404 | 409, code: string) =>
	({ ok: false, status, code }) as const

const WRITE_CHUNK = 100

export function shiftSnapshot(row: Shift): PublishedShift {
	return {
		staffId: row.staffId,
		positionId: row.positionId,
		localDate: row.localDate,
		startTime: row.startTime,
		endTime: row.endTime,
		unpaidBreakMinutes: row.unpaidBreakMinutes,
		note: row.note,
	}
}

function sameSnapshot(a: PublishedShift, b: PublishedShift) {
	return (
		a.staffId === b.staffId &&
		a.positionId === b.positionId &&
		a.localDate === b.localDate &&
		a.startTime === b.startTime &&
		a.endTime === b.endTime &&
		a.unpaidBreakMinutes === b.unpaidBreakMinutes &&
		a.note === b.note
	)
}

export function shiftState(row: Shift): ShiftState {
	if (row.deletedAt) return 'removed'
	if (!row.published) return 'draft'
	return sameSnapshot(row.published, shiftSnapshot(row))
		? 'published'
		: 'changed'
}

function serializeShift(row: Shift) {
	return {
		id: row.id,
		locationId: row.locationId,
		staffId: row.staffId,
		positionId: row.positionId,
		localDate: row.localDate,
		startTime: row.startTime,
		endTime: row.endTime,
		startAt: row.startAt.toISOString(),
		endAt: row.endAt.toISOString(),
		timeZone: row.timeZone,
		unpaidBreakMinutes: row.unpaidBreakMinutes,
		note: row.note,
		state: shiftState(row),
		published: row.published ?? null,
		publishedAt: row.publishedAt?.toISOString() ?? null,
	}
}
export type ShiftView = ReturnType<typeof serializeShift>

function serializePublication(row: SchedulePublication) {
	return {
		id: row.id,
		weekStart: row.weekStart,
		publishedBy: row.publishedBy,
		publishedAt: row.publishedAt.toISOString(),
		shiftCount: row.shiftCount,
		changedCount: row.changedCount,
		notifiedCount: row.notifiedCount,
		notNotifiedCount: row.notNotifiedCount,
	}
}

function locationZone(claims: StaffingTokenClaims, locationId: string) {
	if (!staffingTokenAllowsLocation(claims, locationId)) return null
	return staffingTokenLocationZone(claims, locationId) ?? null
}

function weekRange(weekStart: string) {
	return { from: weekStart, to: addDays(weekStart, 7) }
}

async function weekRows(db: Writer, locationId: string, weekStart: string) {
	const { from, to } = weekRange(weekStart)
	return db
		.select()
		.from(shifts)
		.where(
			and(
				eq(shifts.locationId, locationId),
				gte(shifts.localDate, from),
				lt(shifts.localDate, to),
			),
		)
		.orderBy(asc(shifts.startAt))
}

export async function getSchedule(
	orgId: string,
	claims: StaffingTokenClaims,
	input: { locationId: string; weekStart: string },
) {
	const zone = locationZone(claims, input.locationId)
	if (!zone) return failure(400, 'unknown_location')
	const db = await getTenantDb(orgId)
	const rows = await weekRows(db, input.locationId, input.weekStart)

	const assigned = await db
		.select({
			staffId: staffAssignments.staffId,
			positionId: staffAssignments.positionId,
			isPrimary: staffAssignments.isPrimary,
		})
		.from(staffAssignments)
		.where(eq(staffAssignments.locationId, input.locationId))
	const staffIds = new Set(assigned.map((row) => row.staffId))
	for (const row of rows) {
		if (row.staffId) staffIds.add(row.staffId)
		if (row.published?.staffId) staffIds.add(row.published.staffId)
	}
	const members = staffIds.size
		? await db
				.select()
				.from(staffMembers)
				.where(inArray(staffMembers.id, [...staffIds]))
				.orderBy(asc(staffMembers.firstName), asc(staffMembers.lastName))
		: []
	const scheduled = new Set(
		rows.flatMap((row) => (row.staffId && !row.deletedAt ? [row.staffId] : [])),
	)
	const positionsByStaff = new Map<string, string[]>()
	for (const row of assigned) {
		const list = positionsByStaff.get(row.staffId) ?? []
		if (row.isPrimary) list.unshift(row.positionId)
		else list.push(row.positionId)
		positionsByStaff.set(row.staffId, list)
	}
	const staff = members
		// Terminated people stay visible only while they still hold shifts here.
		.filter((member) => member.status === 'active' || scheduled.has(member.id))
		.map((member) => ({
			id: member.id,
			firstName: member.firstName,
			lastName: member.lastName,
			status: member.status,
			hasEmail: Boolean(member.email),
			positionIds: positionsByStaff.get(member.id) ?? [],
			assignedHere: positionsByStaff.has(member.id),
		}))

	// Shifts the same people hold at other visible locations, as bare intervals,
	// so the grid can warn about double-booking across locations.
	const { from, to } = weekRange(input.weekStart)
	const visibleStaffIds = staff.map((member) => member.id)
	const elsewhere = visibleStaffIds.length
		? (
				await db
					.select({
						id: shifts.id,
						staffId: shifts.staffId,
						locationId: shifts.locationId,
						startAt: shifts.startAt,
						endAt: shifts.endAt,
					})
					.from(shifts)
					.where(
						and(
							inArray(shifts.staffId, visibleStaffIds),
							isNull(shifts.deletedAt),
							gte(shifts.localDate, addDays(from, -1)),
							lt(shifts.localDate, addDays(to, 1)),
						),
					)
			)
				.filter(
					(row) =>
						row.locationId !== input.locationId &&
						staffingTokenAllowsLocation(claims, row.locationId),
				)
				.map((row) => ({
					id: row.id,
					staffId: row.staffId,
					startAt: row.startAt.toISOString(),
					endAt: row.endAt.toISOString(),
				}))
		: []

	const [settings, positions, publications] = await Promise.all([
		readStaffingSettings(db),
		db
			.select()
			.from(staffPositions)
			.orderBy(asc(staffPositions.sortOrder), asc(staffPositions.name)),
		db
			.select()
			.from(schedulePublications)
			.where(
				and(
					eq(schedulePublications.locationId, input.locationId),
					eq(schedulePublications.weekStart, input.weekStart),
				),
			)
			.orderBy(desc(schedulePublications.publishedAt))
			.limit(20),
	])
	const serialized = rows.map(serializeShift)
	return {
		ok: true as const,
		data: {
			locationId: input.locationId,
			timeZone: zone,
			weekStart: input.weekStart,
			settings,
			positions: positions.map((position) => ({
				id: position.id,
				name: position.name,
				colorKey: position.colorKey,
				archived: position.archivedAt !== null,
			})),
			staff,
			shifts: serialized,
			elsewhere,
			unpublishedCount: serialized.filter((row) => row.state !== 'published')
				.length,
			publications: publications.map(serializePublication),
		},
	}
}

async function assertShiftRefs(
	db: Writer,
	input: Pick<ShiftInput, 'locationId' | 'staffId' | 'positionId'>,
	existing?: Pick<Shift, 'staffId' | 'positionId'>,
) {
	if (input.staffId) {
		const [member] = await db
			.select({ id: staffMembers.id, status: staffMembers.status })
			.from(staffMembers)
			.where(eq(staffMembers.id, input.staffId))
			.limit(1)
		if (!member) throw new StaffingAbort(failure(400, 'unknown_staff'))
		const unchanged = existing?.staffId === input.staffId
		if (member.status !== 'active' && !unchanged) {
			throw new StaffingAbort(failure(400, 'staff_inactive'))
		}
		const [assignment] = await db
			.select({ staffId: staffAssignments.staffId })
			.from(staffAssignments)
			.where(
				and(
					eq(staffAssignments.staffId, input.staffId),
					eq(staffAssignments.locationId, input.locationId),
				),
			)
			.limit(1)
		if (!assignment && !unchanged) {
			throw new StaffingAbort(failure(400, 'staff_not_assigned'))
		}
	}
	if (input.positionId) {
		const [position] = await db
			.select({ archivedAt: staffPositions.archivedAt })
			.from(staffPositions)
			.where(eq(staffPositions.id, input.positionId))
			.limit(1)
		if (!position) throw new StaffingAbort(failure(400, 'unknown_position'))
		if (position.archivedAt && existing?.positionId !== input.positionId) {
			throw new StaffingAbort(failure(400, 'position_archived'))
		}
	}
}

function shiftValues(input: ShiftInput, timeZone: string) {
	const { startAt, endAt } = shiftInstants({ ...input, timeZone })
	return {
		locationId: input.locationId,
		staffId: input.staffId,
		positionId: input.positionId,
		localDate: input.localDate,
		startTime: input.startTime,
		endTime: input.endTime,
		startAt,
		endAt,
		timeZone,
		unpaidBreakMinutes: input.unpaidBreakMinutes,
		note: input.note,
	}
}

export async function createShifts(
	orgId: string,
	auth: StaffingAuth,
	input: { shift: ShiftInput; alsoOn: string[] },
): Promise<ServiceResult<ShiftView[]>> {
	const zone = locationZone(auth.claims, input.shift.locationId)
	if (!zone) return failure(400, 'unknown_location')
	const dates = [...new Set([input.shift.localDate, ...input.alsoOn])]
	if (
		dates.some((date) => Math.abs(daysBetween(input.shift.localDate, date)) > 6)
	) {
		return failure(400, 'invalid_dates')
	}
	const db = await getTenantDb(orgId)
	return withAbort(() =>
		db.transaction(async (tx) => {
			await assertShiftRefs(tx, input.shift)
			const rows = await tx
				.insert(shifts)
				.values(
					dates.map((localDate) => ({
						...shiftValues({ ...input.shift, localDate }, zone),
						createdBy: auth.actorRef,
					})),
				)
				.returning()
			return { ok: true as const, data: rows.map(serializeShift) }
		}),
	)
}

async function loadEditableShift(
	db: Writer,
	claims: StaffingTokenClaims,
	shiftId: string,
) {
	const [row] = await db
		.select()
		.from(shifts)
		.where(eq(shifts.id, shiftId))
		.limit(1)
	if (!row || row.deletedAt) return null
	if (!staffingTokenAllowsLocation(claims, row.locationId)) return null
	return row
}

export async function updateShift(
	orgId: string,
	auth: StaffingAuth,
	shiftId: string,
	input: ShiftInput,
): Promise<ServiceResult<ShiftView>> {
	const db = await getTenantDb(orgId)
	return withAbort(() =>
		db.transaction(async (tx) => {
			const existing = await loadEditableShift(tx, auth.claims, shiftId)
			if (!existing) return failure(404, 'not_found')
			if (existing.locationId !== input.locationId) {
				return failure(400, 'location_change')
			}
			const zone = locationZone(auth.claims, input.locationId)
			if (!zone) return failure(400, 'unknown_location')
			await assertShiftRefs(tx, input, existing)
			const [row] = await tx
				.update(shifts)
				.set({ ...shiftValues(input, zone), updatedAt: new Date() })
				.where(eq(shifts.id, shiftId))
				.returning()
			return { ok: true as const, data: serializeShift(row!) }
		}),
	)
}

/** Unpublished shifts disappear; published ones wait for the next publish. */
async function removeShifts(db: Writer, rows: readonly Shift[]) {
	const now = new Date()
	const hard = rows.filter((row) => !row.published).map((row) => row.id)
	const soft = rows.filter((row) => row.published).map((row) => row.id)
	for (let index = 0; index < hard.length; index += WRITE_CHUNK) {
		await db
			.delete(shifts)
			.where(inArray(shifts.id, hard.slice(index, index + WRITE_CHUNK)))
	}
	for (let index = 0; index < soft.length; index += WRITE_CHUNK) {
		await db
			.update(shifts)
			.set({ deletedAt: now, updatedAt: now })
			.where(inArray(shifts.id, soft.slice(index, index + WRITE_CHUNK)))
	}
}

export async function deleteShift(
	orgId: string,
	auth: StaffingAuth,
	shiftId: string,
): Promise<ServiceResult<{ id: string; pendingPublish: boolean }>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const existing = await loadEditableShift(tx, auth.claims, shiftId)
		if (!existing) return failure(404, 'not_found')
		await removeShifts(tx, [existing])
		return {
			ok: true as const,
			data: { id: shiftId, pendingPublish: existing.published !== null },
		}
	})
}

/** Brings back a removed shift before the removal is published. */
export async function restoreShift(
	orgId: string,
	auth: StaffingAuth,
	shiftId: string,
): Promise<ServiceResult<ShiftView>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const [existing] = await tx
			.select()
			.from(shifts)
			.where(eq(shifts.id, shiftId))
			.limit(1)
		if (
			!existing ||
			!existing.deletedAt ||
			!staffingTokenAllowsLocation(auth.claims, existing.locationId)
		) {
			return failure(404, 'not_found')
		}
		const [row] = await tx
			.update(shifts)
			.set({ deletedAt: null, updatedAt: new Date() })
			.where(eq(shifts.id, shiftId))
			.returning()
		return { ok: true as const, data: serializeShift(row!) }
	})
}

export async function copyWeek(
	orgId: string,
	auth: StaffingAuth,
	input: {
		locationId: string
		fromWeekStart: string
		toWeekStart: string
		positionId: string | null
		replace: boolean
	},
): Promise<
	ServiceResult<{ created: number; opened: number; removed: number }>
> {
	const zone = locationZone(auth.claims, input.locationId)
	if (!zone) return failure(400, 'unknown_location')
	const offset = daysBetween(input.fromWeekStart, input.toWeekStart)
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const matches = (row: Shift) =>
			!row.deletedAt &&
			(input.positionId === null || row.positionId === input.positionId)
		const source = (
			await weekRows(tx, input.locationId, input.fromWeekStart)
		).filter(matches)
		if (source.length === 0) return failure(400, 'nothing_to_copy')
		let removed = 0
		if (input.replace) {
			const target = (
				await weekRows(tx, input.locationId, input.toWeekStart)
			).filter(matches)
			await removeShifts(tx, target)
			removed = target.length
		}
		const staffIds = [
			...new Set(source.flatMap((row) => (row.staffId ? [row.staffId] : []))),
		]
		const schedulable = new Set<string>()
		if (staffIds.length) {
			const rows = await tx
				.select({ id: staffMembers.id })
				.from(staffMembers)
				.innerJoin(
					staffAssignments,
					and(
						eq(staffAssignments.staffId, staffMembers.id),
						eq(staffAssignments.locationId, input.locationId),
					),
				)
				.where(
					and(
						inArray(staffMembers.id, staffIds),
						eq(staffMembers.status, 'active'),
					),
				)
			for (const row of rows) schedulable.add(row.id)
		}
		const archived = new Set(
			(
				await tx
					.select({
						id: staffPositions.id,
						archivedAt: staffPositions.archivedAt,
					})
					.from(staffPositions)
			)
				.filter((row) => row.archivedAt)
				.map((row) => row.id),
		)
		let opened = 0
		const values = source.map((row) => {
			const staffId =
				row.staffId && schedulable.has(row.staffId) ? row.staffId : null
			if (row.staffId && !staffId) opened++
			return {
				...shiftValues(
					{
						locationId: row.locationId,
						staffId,
						positionId:
							row.positionId && !archived.has(row.positionId)
								? row.positionId
								: null,
						localDate: addDays(row.localDate, offset),
						startTime: row.startTime,
						endTime: row.endTime,
						unpaidBreakMinutes: row.unpaidBreakMinutes,
						note: row.note,
					},
					zone,
				),
				createdBy: auth.actorRef,
			}
		})
		for (let index = 0; index < values.length; index += WRITE_CHUNK) {
			await tx.insert(shifts).values(values.slice(index, index + WRITE_CHUNK))
		}
		await recordStaffEvent(tx, auth, 'schedule.copied', null, {
			locationId: input.locationId,
			fromWeekStart: input.fromWeekStart,
			toWeekStart: input.toWeekStart,
			created: values.length,
		})
		return {
			ok: true as const,
			data: { created: values.length, opened, removed },
		}
	})
}

export type PublishedChange = {
	staffId: string
	/** The person's published shifts this week at this location, after publish. */
	current: PublishedShift[]
	/** Shifts the person no longer has. */
	removed: PublishedShift[]
}

/**
 * Publishes every draft change for one location-week in one transaction and
 * returns, per affected person, what they should be told.
 */
export async function commitPublish(
	orgId: string,
	auth: StaffingAuth,
	input: { locationId: string; weekStart: string },
): Promise<
	ServiceResult<{
		publication: SchedulePublication
		changes: PublishedChange[]
	}>
> {
	const zone = locationZone(auth.claims, input.locationId)
	if (!zone) return failure(400, 'unknown_location')
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const rows = await weekRows(tx, input.locationId, input.weekStart)
		const dirty = rows.filter((row) => shiftState(row) !== 'published')
		if (dirty.length === 0) return failure(409, 'nothing_to_publish')
		const affected = new Set<string>()
		const removedByStaff = new Map<string, PublishedShift[]>()
		for (const row of dirty) {
			const before = row.published
			const after = row.deletedAt ? null : shiftSnapshot(row)
			if (after?.staffId) affected.add(after.staffId)
			if (before?.staffId) {
				affected.add(before.staffId)
				if (!after || after.staffId !== before.staffId) {
					const list = removedByStaff.get(before.staffId) ?? []
					list.push(before)
					removedByStaff.set(before.staffId, list)
				}
			}
		}
		const now = new Date()
		const removed = dirty.filter((row) => row.deletedAt)
		for (let index = 0; index < removed.length; index += WRITE_CHUNK) {
			await tx.delete(shifts).where(
				inArray(
					shifts.id,
					removed.slice(index, index + WRITE_CHUNK).map((row) => row.id),
				),
			)
		}
		for (const row of dirty) {
			if (row.deletedAt) continue
			await tx
				.update(shifts)
				.set({ published: shiftSnapshot(row), publishedAt: now })
				.where(eq(shifts.id, row.id))
		}
		const live = rows.filter((row) => !row.deletedAt)
		const [publication] = await tx
			.insert(schedulePublications)
			.values({
				locationId: input.locationId,
				weekStart: input.weekStart,
				publishedBy: auth.actorRef,
				shiftCount: live.length,
				changedCount: dirty.length,
				publishedAt: now,
			})
			.returning()
		await recordStaffEvent(tx, auth, 'schedule.published', null, {
			locationId: input.locationId,
			weekStart: input.weekStart,
			changed: dirty.length,
		})
		const changes = [...affected].map((staffId) => ({
			staffId,
			current: live
				.filter((row) => row.staffId === staffId)
				.map(shiftSnapshot)
				.sort((a, b) =>
					`${a.localDate}${a.startTime}`.localeCompare(
						`${b.localDate}${b.startTime}`,
					),
				),
			removed: removedByStaff.get(staffId) ?? [],
		}))
		return { ok: true as const, data: { publication: publication!, changes } }
	})
}

export async function recordNotifications(
	orgId: string,
	publicationId: string,
	counts: { notified: number; notNotified: number },
) {
	const db = await getTenantDb(orgId)
	await db
		.update(schedulePublications)
		.set({
			notifiedCount: counts.notified,
			notNotifiedCount: counts.notNotified,
		})
		.where(eq(schedulePublications.id, publicationId))
}

export async function loadRecipients(orgId: string, staffIds: string[]) {
	if (staffIds.length === 0) return []
	const db = await getTenantDb(orgId)
	return db
		.select({
			id: staffMembers.id,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			email: staffMembers.email,
			status: staffMembers.status,
		})
		.from(staffMembers)
		.where(inArray(staffMembers.id, staffIds))
}

export async function positionNames(orgId: string) {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select({ id: staffPositions.id, name: staffPositions.name })
		.from(staffPositions)
	return new Map(rows.map((row) => [row.id, row.name]))
}

export async function listPublications(
	orgId: string,
	claims: StaffingTokenClaims,
	input: { locationId: string; weekStart: string },
) {
	if (!locationZone(claims, input.locationId)) {
		return failure(400, 'unknown_location')
	}
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(schedulePublications)
		.where(
			and(
				eq(schedulePublications.locationId, input.locationId),
				eq(schedulePublications.weekStart, input.weekStart),
			),
		)
		.orderBy(desc(schedulePublications.publishedAt))
		.limit(50)
	return { ok: true as const, data: rows.map(serializePublication) }
}

/**
 * Next published shifts for one person, for the kiosk confirmation screen.
 * Drafts are never shown to staff.
 */
export async function upcomingPublishedShifts(
	db: Writer,
	staffId: string,
	now: Date,
	limit = 3,
) {
	// A removal staff have not been told about yet still shows: the published
	// version is what they were promised until the next publish.
	const rows = await db
		.select()
		.from(shifts)
		.where(
			and(
				sql`json_extract(${shifts.published}, '$.staffId') = ${staffId}`,
				sql`json_extract(${shifts.published}, '$.localDate') >= ${addDays(
					now.toISOString().slice(0, 10),
					-1,
				)}`,
			),
		)
		.limit(100)
	return rows
		.map((row) => {
			const published = row.published!
			return {
				id: row.id,
				locationId: row.locationId,
				positionId: published.positionId,
				...shiftInstants({ ...published, timeZone: row.timeZone }),
				localDate: published.localDate,
				startTime: published.startTime,
				endTime: published.endTime,
			}
		})
		.filter((shift) => shift.endAt.getTime() > now.getTime())
		.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
		.slice(0, limit)
}

// A terminated person's shifts after their last day become open shifts. Drafts
// change immediately; published copies keep the old name until the next publish
// tells everyone else about the opening.
onStaffTerminated(async (tx, staffId, terminatedOn) => {
	const released = await tx
		.update(shifts)
		.set({ staffId: null, updatedAt: new Date() })
		.where(
			and(
				eq(shifts.staffId, staffId),
				gt(shifts.localDate, terminatedOn),
				isNull(shifts.deletedAt),
			),
		)
		.returning({ id: shifts.id })
	return released.length
})
