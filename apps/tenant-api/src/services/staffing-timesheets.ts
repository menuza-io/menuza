import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
} from 'drizzle-orm'
import {
	addDays,
	entryPaidMinutes,
	shiftInstants,
	startOfWeek,
	type StaffingTokenClaims,
	staffingTokenAllowsLocation,
	staffingTokenLocationZone,
	type TimeEntryCreateInput,
	timeEntryInstants,
	timeEntryIssues,
	type TimeEntryUpdateInput,
	weeklyTotals,
} from '@repo/staffing'
import {
	getTenantDb,
	kioskDevices,
	shifts,
	staffAssignments,
	staffMembers,
	staffPositions,
	type TimeEntry,
	timeEntries,
	timeEntryEvents,
} from '@repo/tenant-db'

import { type StaffingAuth } from '../lib/staffing-auth.ts'
import {
	loadVisibleStaff,
	readStaffingSettings,
	type ServiceResult,
	StaffingAbort,
	withAbort,
} from './staffing-roster.ts'

type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
type Transaction = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]
type Writer = TenantDatabase | Transaction

const failure = (status: 400 | 404 | 409, code: string) =>
	({ ok: false, status, code }) as const

/** Clocks drift; allow a little slack before calling a time "in the future". */
const FUTURE_SLACK_MS = 5 * 60_000
const OPEN_LOOKBACK_LIMIT = 50

function isUniqueViolation(error: unknown) {
	const text = error instanceof Error ? `${error.message} ${error.cause}` : ''
	return /UNIQUE constraint failed/i.test(text)
}

function locationZone(claims: StaffingTokenClaims, locationId: string) {
	if (!staffingTokenAllowsLocation(claims, locationId)) return null
	return staffingTokenLocationZone(claims, locationId) ?? null
}

/** The fields a correction can change, as stored in the edit trail. */
function entrySnapshot(entry: TimeEntry) {
	return {
		positionId: entry.positionId,
		localDate: entry.localDate,
		clockInAt: entry.clockInAt.toISOString(),
		clockOutAt: entry.clockOutAt?.toISOString() ?? null,
		unpaidBreakMinutes: entry.unpaidBreakMinutes,
		note: entry.note,
	}
}

type Scheduled = {
	id: string
	startAt: Date
	endAt: Date
	positionId: string | null
}

function serializeEntry(
	entry: TimeEntry,
	scheduled: Scheduled | null,
	options: { lateGraceMinutes: number; now: Date; edited: boolean },
) {
	return {
		id: entry.id,
		staffId: entry.staffId,
		locationId: entry.locationId,
		positionId: entry.positionId,
		shiftId: entry.shiftId,
		localDate: entry.localDate,
		timeZone: entry.timeZone,
		clockInAt: entry.clockInAt.toISOString(),
		clockOutAt: entry.clockOutAt?.toISOString() ?? null,
		source: entry.source,
		deviceId: entry.deviceId,
		unpaidBreakMinutes: entry.unpaidBreakMinutes,
		note: entry.note,
		approvedAt: entry.approvedAt?.toISOString() ?? null,
		approvedBy: entry.approvedBy,
		paidMinutes: entryPaidMinutes(entry),
		issues: timeEntryIssues(entry, scheduled, options),
		scheduled: scheduled
			? {
					startAt: scheduled.startAt.toISOString(),
					endAt: scheduled.endAt.toISOString(),
					positionId: scheduled.positionId,
				}
			: null,
		edited: options.edited,
	}
}
export type TimeEntryView = ReturnType<typeof serializeEntry>

/**
 * Pairs each card with the published shift it worked: the linked shift when
 * the kiosk found one, otherwise the same person's published shift on that
 * day at this location whose start is closest to the clock-in.
 */
async function matchScheduled(
	db: Writer,
	locationId: string,
	entries: TimeEntry[],
) {
	const matched = new Map<string, Scheduled>()
	if (entries.length === 0) return matched
	const dates = [...new Set(entries.map((entry) => entry.localDate))].sort()
	const rows = await db
		.select()
		.from(shifts)
		.where(
			and(
				eq(shifts.locationId, locationId),
				isNull(shifts.deletedAt),
				isNotNull(shifts.published),
				gte(shifts.localDate, addDays(dates[0]!, -1)),
				lte(shifts.localDate, addDays(dates.at(-1)!, 1)),
			),
		)
	const published = rows.map((row) => {
		const snapshot = row.published!
		const { startAt, endAt } = shiftInstants({
			...snapshot,
			timeZone: row.timeZone,
		})
		return {
			id: row.id,
			staffId: snapshot.staffId,
			localDate: snapshot.localDate,
			positionId: snapshot.positionId,
			startAt,
			endAt,
		}
	})
	const used = new Set<string>()
	const byId = new Map(published.map((shift) => [shift.id, shift]))
	for (const entry of entries) {
		const linked = entry.shiftId ? byId.get(entry.shiftId) : undefined
		if (linked && linked.staffId === entry.staffId) {
			matched.set(entry.id, linked)
			used.add(linked.id)
		}
	}
	for (const entry of entries) {
		if (matched.has(entry.id)) continue
		let best: (typeof published)[number] | null = null
		for (const shift of published) {
			if (used.has(shift.id) || shift.staffId !== entry.staffId) continue
			if (shift.localDate !== entry.localDate) continue
			const distance = Math.abs(
				shift.startAt.getTime() - entry.clockInAt.getTime(),
			)
			if (
				!best ||
				distance < Math.abs(best.startAt.getTime() - entry.clockInAt.getTime())
			) {
				best = shift
			}
		}
		if (best) {
			matched.set(entry.id, best)
			used.add(best.id)
		}
	}
	return matched
}

async function editedEntryIds(db: Writer, entryIds: string[]) {
	const edited = new Set<string>()
	for (let index = 0; index < entryIds.length; index += 500) {
		const rows = await db
			.select({ entryId: timeEntryEvents.entryId })
			.from(timeEntryEvents)
			.where(
				and(
					inArray(timeEntryEvents.entryId, entryIds.slice(index, index + 500)),
					inArray(timeEntryEvents.kind, ['edit', 'manual_create', 'reopen']),
				),
			)
		for (const row of rows) edited.add(row.entryId)
	}
	return edited
}

async function deviceNames(db: Writer, deviceIds: string[]) {
	const ids = [...new Set(deviceIds)]
	if (ids.length === 0) return {}
	const rows = await db
		.select({ id: kioskDevices.id, name: kioskDevices.name })
		.from(kioskDevices)
		.where(inArray(kioskDevices.id, ids))
	return Object.fromEntries(rows.map((row) => [row.id, row.name])) as Record<
		string,
		string
	>
}

export async function getTimesheet(
	orgId: string,
	claims: StaffingTokenClaims,
	query: { locationId: string; from: string; to: string },
	now = new Date(),
) {
	const timeZone = locationZone(claims, query.locationId)
	if (!timeZone) return failure(400, 'unknown_location')
	const db = await getTenantDb(orgId)
	const settings = await readStaffingSettings(db)
	const weekFrom = startOfWeek(query.from, settings.weekStart)
	const weekTo = addDays(startOfWeek(query.to, settings.weekStart), 6)

	const [weekRows, olderOpen, positions, assigned] = await Promise.all([
		db
			.select()
			.from(timeEntries)
			.where(
				and(
					isNull(timeEntries.deletedAt),
					gte(timeEntries.localDate, weekFrom),
					lte(timeEntries.localDate, weekTo),
				),
			)
			.orderBy(asc(timeEntries.clockInAt)),
		// Missing clock-outs from before the range still need attention here.
		db
			.select()
			.from(timeEntries)
			.where(
				and(
					eq(timeEntries.locationId, query.locationId),
					isNull(timeEntries.deletedAt),
					isNull(timeEntries.clockOutAt),
					lt(timeEntries.localDate, query.from),
				),
			)
			.orderBy(asc(timeEntries.clockInAt))
			.limit(OPEN_LOOKBACK_LIMIT),
		db
			.select()
			.from(staffPositions)
			.orderBy(asc(staffPositions.sortOrder), asc(staffPositions.name)),
		db
			.select()
			.from(staffAssignments)
			.where(eq(staffAssignments.locationId, query.locationId)),
	])

	const allowed = weekRows.filter((entry) =>
		staffingTokenAllowsLocation(claims, entry.locationId),
	)
	const listed = [
		...olderOpen,
		...allowed.filter(
			(entry) =>
				entry.locationId === query.locationId &&
				entry.localDate >= query.from &&
				entry.localDate <= query.to,
		),
	]

	const staffIds = [
		...new Set([
			...listed.map((entry) => entry.staffId),
			...assigned.map((row) => row.staffId),
		]),
	]
	const members = staffIds.length
		? await db
				.select({
					id: staffMembers.id,
					firstName: staffMembers.firstName,
					lastName: staffMembers.lastName,
					status: staffMembers.status,
				})
				.from(staffMembers)
				.where(inArray(staffMembers.id, staffIds))
				.orderBy(asc(staffMembers.firstName), asc(staffMembers.lastName))
		: []
	const positionsHere = new Map<string, string[]>()
	for (const row of assigned) {
		const list = positionsHere.get(row.staffId) ?? []
		if (row.isPrimary) list.unshift(row.positionId)
		else list.push(row.positionId)
		positionsHere.set(row.staffId, list)
	}

	const [scheduled, edited, devices] = await Promise.all([
		matchScheduled(db, query.locationId, listed),
		editedEntryIds(
			db,
			listed.map((entry) => entry.id),
		),
		deviceNames(
			db,
			listed.flatMap((entry) => (entry.deviceId ? [entry.deviceId] : [])),
		),
	])
	const listedStaff = new Set(listed.map((entry) => entry.staffId))

	return {
		ok: true as const,
		data: {
			locationId: query.locationId,
			timeZone,
			from: query.from,
			to: query.to,
			settings,
			positions: positions.map((position) => ({
				id: position.id,
				name: position.name,
				colorKey: position.colorKey,
				archived: position.archivedAt !== null,
			})),
			staff: members.map((member) => ({
				...member,
				positionIds: positionsHere.get(member.id) ?? [],
				assignedHere: positionsHere.has(member.id),
			})),
			entries: listed.map((entry) =>
				serializeEntry(entry, scheduled.get(entry.id) ?? null, {
					lateGraceMinutes: settings.lateGraceMinutes,
					now,
					edited: edited.has(entry.id),
				}),
			),
			// Whole weeks across every location this token can see, so a
			// person's weekly threshold counts all of their hours.
			weeks: weeklyTotals(
				allowed.map((entry) => ({
					staffId: entry.staffId,
					localDate: entry.localDate,
					paidMinutes: entryPaidMinutes(entry),
				})),
				settings,
			).filter((week) => listedStaff.has(week.staffId)),
			devices,
		},
	}
}

type EntryTimes = {
	clockInAt: Date
	clockOutAt: Date | null
	unpaidBreakMinutes: number
}

function validateTimes(times: EntryTimes, now: Date) {
	const limit = now.getTime() + FUTURE_SLACK_MS
	if (times.clockInAt.getTime() > limit) return 'in_future'
	if (times.clockOutAt && times.clockOutAt.getTime() > limit) return 'in_future'
	if (times.clockOutAt) {
		const minutes =
			(times.clockOutAt.getTime() - times.clockInAt.getTime()) / 60_000
		if (minutes <= 0) return 'invalid_times'
		if (times.unpaidBreakMinutes >= minutes) return 'break_too_long'
	} else if (times.unpaidBreakMinutes > 0) {
		return 'break_needs_clock_out'
	}
	return null
}

/** Another live card for the same person whose time overlaps this one. */
async function findOverlap(
	db: Writer,
	staffId: string,
	times: EntryTimes,
	excludeId: string | null,
) {
	const end = times.clockOutAt ?? new Date(8_640_000_000_000_000)
	const rows = await db
		.select()
		.from(timeEntries)
		.where(
			and(
				eq(timeEntries.staffId, staffId),
				isNull(timeEntries.deletedAt),
				lt(timeEntries.clockInAt, end),
				excludeId ? ne(timeEntries.id, excludeId) : undefined,
			),
		)
	return rows.some(
		(row) =>
			!row.clockOutAt || row.clockOutAt.getTime() > times.clockInAt.getTime(),
	)
}

async function resolvePosition(
	db: Writer,
	staffId: string,
	locationId: string,
	requested: string | null,
	keep: string | null = null,
): Promise<ServiceResult<string | null>> {
	if (requested) {
		const [position] = await db
			.select()
			.from(staffPositions)
			.where(eq(staffPositions.id, requested))
			.limit(1)
		if (!position) return failure(400, 'unknown_position')
		if (position.archivedAt && requested !== keep) {
			return failure(400, 'position_archived')
		}
		return { ok: true, data: requested }
	}
	const [primary] = await db
		.select({ positionId: staffAssignments.positionId })
		.from(staffAssignments)
		.where(
			and(
				eq(staffAssignments.staffId, staffId),
				eq(staffAssignments.locationId, locationId),
			),
		)
		.orderBy(desc(staffAssignments.isPrimary))
	return { ok: true, data: primary?.positionId ?? null }
}

async function runEntryWrite<T>(
	db: TenantDatabase,
	work: (tx: Transaction) => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
	try {
		return await withAbort(() => db.transaction(work))
	} catch (error) {
		// The partial unique index allows one open card per person.
		if (isUniqueViolation(error)) return failure(409, 'already_clocked_in')
		throw error
	}
}

export async function createTimeEntry(
	orgId: string,
	auth: StaffingAuth,
	input: TimeEntryCreateInput,
	now = new Date(),
): Promise<ServiceResult<{ id: string }>> {
	const timeZone = locationZone(auth.claims, input.locationId)
	if (!timeZone) return failure(400, 'unknown_location')
	const db = await getTenantDb(orgId)
	const visible = await loadVisibleStaff(db, auth.claims, input.staffId)
	if (!visible) return failure(400, 'unknown_staff')
	if (
		!visible.assignments.some(
			(assignment) => assignment.locationId === input.locationId,
		)
	) {
		return failure(400, 'staff_not_assigned')
	}
	const times = {
		...timeEntryInstants(input, timeZone),
		unpaidBreakMinutes: input.unpaidBreakMinutes,
	}
	const problem = validateTimes(times, now)
	if (problem) return failure(400, problem)
	return runEntryWrite(db, async (tx) => {
		const position = await resolvePosition(
			tx,
			input.staffId,
			input.locationId,
			input.positionId,
		)
		if (!position.ok) return position
		if (await findOverlap(tx, input.staffId, times, null)) {
			return failure(409, 'entry_overlap')
		}
		const [entry] = await tx
			.insert(timeEntries)
			.values({
				staffId: input.staffId,
				locationId: input.locationId,
				positionId: position.data,
				clockInAt: times.clockInAt,
				clockOutAt: times.clockOutAt,
				timeZone,
				localDate: input.localDate,
				source: 'manager',
				unpaidBreakMinutes: input.unpaidBreakMinutes,
				note: input.note,
			})
			.returning()
		await tx.insert(timeEntryEvents).values({
			entryId: entry!.id,
			kind: 'manual_create',
			actorType: 'operator',
			actorRef: auth.actorRef,
			after: entrySnapshot(entry!),
			reason: input.reason || null,
		})
		return { ok: true, data: { id: entry!.id } }
	})
}

async function loadEditableEntry(
	tx: Writer,
	claims: StaffingTokenClaims,
	entryId: string,
) {
	const [entry] = await tx
		.select()
		.from(timeEntries)
		.where(and(eq(timeEntries.id, entryId), isNull(timeEntries.deletedAt)))
		.limit(1)
	if (!entry || !staffingTokenAllowsLocation(claims, entry.locationId)) {
		throw new StaffingAbort(failure(404, 'not_found'))
	}
	return entry
}

export async function updateTimeEntry(
	orgId: string,
	auth: StaffingAuth,
	entryId: string,
	input: TimeEntryUpdateInput,
	now = new Date(),
): Promise<ServiceResult<{ id: string }>> {
	const db = await getTenantDb(orgId)
	return runEntryWrite(db, async (tx) => {
		const before = await loadEditableEntry(tx, auth.claims, entryId)
		if (before.approvedAt) return failure(409, 'entry_locked')
		const times = {
			...timeEntryInstants(input, before.timeZone),
			unpaidBreakMinutes: input.unpaidBreakMinutes,
		}
		const problem = validateTimes(times, now)
		if (problem) return failure(400, problem)
		const position = await resolvePosition(
			tx,
			before.staffId,
			before.locationId,
			input.positionId,
			before.positionId,
		)
		if (!position.ok) return position
		if (await findOverlap(tx, before.staffId, times, before.id)) {
			return failure(409, 'entry_overlap')
		}
		const [after] = await tx
			.update(timeEntries)
			.set({
				positionId: position.data,
				localDate: input.localDate,
				clockInAt: times.clockInAt,
				clockOutAt: times.clockOutAt,
				unpaidBreakMinutes: input.unpaidBreakMinutes,
				note: input.note,
				updatedAt: now,
			})
			.where(and(eq(timeEntries.id, entryId), isNull(timeEntries.approvedAt)))
			.returning()
		if (!after) throw new StaffingAbort(failure(409, 'entry_locked'))
		await tx.insert(timeEntryEvents).values({
			entryId,
			kind: 'edit',
			actorType: 'operator',
			actorRef: auth.actorRef,
			before: entrySnapshot(before),
			after: entrySnapshot(after),
			reason: input.reason,
		})
		return { ok: true, data: { id: entryId } }
	})
}

export async function deleteTimeEntry(
	orgId: string,
	auth: StaffingAuth,
	entryId: string,
	reason: string,
	now = new Date(),
): Promise<ServiceResult<{ id: string }>> {
	const db = await getTenantDb(orgId)
	return runEntryWrite(db, async (tx) => {
		const before = await loadEditableEntry(tx, auth.claims, entryId)
		if (before.approvedAt) return failure(409, 'entry_locked')
		// Soft delete: raw punches and the trail survive a correction.
		await tx
			.update(timeEntries)
			.set({ deletedAt: now, updatedAt: now })
			.where(eq(timeEntries.id, entryId))
		await tx.insert(timeEntryEvents).values({
			entryId,
			kind: 'delete',
			actorType: 'operator',
			actorRef: auth.actorRef,
			before: entrySnapshot(before),
			reason,
		})
		return { ok: true, data: { id: entryId } }
	})
}

export type ApproveSkip = {
	id: string
	reason: 'not_found' | 'open' | 'already_approved'
}

export async function approveTimeEntries(
	orgId: string,
	auth: StaffingAuth,
	input: { locationId: string; entryIds: string[] },
	now = new Date(),
): Promise<ServiceResult<{ approved: number; skipped: ApproveSkip[] }>> {
	if (!locationZone(auth.claims, input.locationId)) {
		return failure(400, 'unknown_location')
	}
	const db = await getTenantDb(orgId)
	const ids = [...new Set(input.entryIds)]
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(timeEntries)
			.where(
				and(
					inArray(timeEntries.id, ids),
					eq(timeEntries.locationId, input.locationId),
					isNull(timeEntries.deletedAt),
				),
			)
		const byId = new Map(rows.map((row) => [row.id, row]))
		const skipped: ApproveSkip[] = []
		const approvable: TimeEntry[] = []
		for (const entryId of ids) {
			const row = byId.get(entryId)
			if (!row) skipped.push({ id: entryId, reason: 'not_found' })
			else if (!row.clockOutAt) skipped.push({ id: entryId, reason: 'open' })
			else if (row.approvedAt) {
				skipped.push({ id: entryId, reason: 'already_approved' })
			} else approvable.push(row)
		}
		if (approvable.length) {
			await tx
				.update(timeEntries)
				.set({ approvedAt: now, approvedBy: auth.actorRef, updatedAt: now })
				.where(
					inArray(
						timeEntries.id,
						approvable.map((row) => row.id),
					),
				)
			await tx.insert(timeEntryEvents).values(
				approvable.map((row) => ({
					entryId: row.id,
					kind: 'approve',
					actorType: 'operator' as const,
					actorRef: auth.actorRef,
				})),
			)
		}
		return {
			ok: true as const,
			data: { approved: approvable.length, skipped },
		}
	})
}

export async function reopenTimeEntry(
	orgId: string,
	auth: StaffingAuth,
	entryId: string,
	reason: string,
	now = new Date(),
): Promise<ServiceResult<{ id: string }>> {
	const db = await getTenantDb(orgId)
	return runEntryWrite(db, async (tx) => {
		const entry = await loadEditableEntry(tx, auth.claims, entryId)
		if (!entry.approvedAt) return failure(409, 'not_approved')
		await tx
			.update(timeEntries)
			.set({ approvedAt: null, approvedBy: null, updatedAt: now })
			.where(eq(timeEntries.id, entryId))
		await tx.insert(timeEntryEvents).values({
			entryId,
			kind: 'reopen',
			actorType: 'operator',
			actorRef: auth.actorRef,
			reason,
		})
		return { ok: true, data: { id: entryId } }
	})
}

export async function timeEntryHistory(
	orgId: string,
	claims: StaffingTokenClaims,
	entryId: string,
) {
	const db = await getTenantDb(orgId)
	const [entry] = await db
		.select()
		.from(timeEntries)
		.where(eq(timeEntries.id, entryId))
		.limit(1)
	if (!entry || !staffingTokenAllowsLocation(claims, entry.locationId)) {
		return failure(404, 'not_found')
	}
	const events = await db
		.select()
		.from(timeEntryEvents)
		.where(eq(timeEntryEvents.entryId, entryId))
		.orderBy(asc(timeEntryEvents.at))
	const devices = await deviceNames(
		db,
		events.flatMap((event) =>
			event.actorType === 'kiosk'
				? [event.actorRef.replace(/^kiosk:/, '')]
				: [],
		),
	)
	return {
		ok: true as const,
		data: {
			events: events.map((event) => ({
				id: event.id,
				kind: event.kind,
				actorType: event.actorType,
				actorRef: event.actorRef,
				before: event.before ?? null,
				after: event.after ?? null,
				reason: event.reason,
				at: event.at.toISOString(),
			})),
			devices,
		},
	}
}
