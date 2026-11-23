import {
	COUNT_OVERDUE_ALERT_AFTER_MS,
	type CountAssignee,
	type CountRun,
	type CountSchedule,
	type CreateCountSchedule,
	type UpdateCountSchedule,
} from '@repo/inventory'
import { addDays, dayOfWeek, localToInstant } from '@repo/reservations'
import {
	invCountLists,
	invCountScheduleRuns,
	invCountSchedules,
	invCounts,
	staffMembers,
} from '@repo/tenant-db'
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	locationBusinessDate,
	newId,
	notFound,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { resolveLocationTime } from './inventory-location-settings.ts'

/**
 * Count schedules and their runs (#490, #491): several scheduled counts per
 * location ("daily at close", "weekdays at opening"), each a full count, a
 * quick count of the key items, or a saved count list, with the person
 * responsible. The older single weekly count day (`inv_settings`) keeps working
 * beside these; nothing here replaces it.
 *
 * A schedule is a template. A run is one occurrence on one business day. Runs
 * are projected on read (`projectRuns`: a schedule due that day with no stored
 * run is shown as it would be stored) and stored when something needs them to
 * stay put: the hourly tick, a count started for the run, and an edit (the
 * day's runs are stored first, so a change applies from tomorrow and never to a
 * day already planned or a count already started).
 */

const MAX_SCHEDULES_PER_LOCATION = 30
/** A quick count looks this many days ahead for "its next scheduled time". */
const LOOKAHEAD_DAYS = 8

type ScheduleRow = typeof invCountSchedules.$inferSelect
type RunRow = typeof invCountScheduleRuns.$inferSelect

function assigneeOf(
	kind: string | null,
	id: string | null,
): CountAssignee | null {
	if ((kind === 'staff' || kind === 'member') && id) return { kind, id }
	return null
}

function slotOf(value: string): 'opening' | 'close' | 'custom' {
	return value === 'opening' || value === 'close' ? value : 'custom'
}

function toSchedule(row: ScheduleRow, listName: string | null): CountSchedule {
	return {
		id: row.id,
		locationId: row.locationId,
		kind: row.kind,
		listId: row.listId,
		listName,
		slot: slotOf(row.slot),
		timeLocal: row.timeLocal,
		weekdays: row.weekdays,
		assignee: assigneeOf(row.assigneeKind, row.assigneeId),
		effectiveFrom: row.effectiveFrom,
		version: row.version,
	}
}

async function listNames(
	db: InventoryReader,
	ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((id): id is string => id !== null))]
	const rows = await queryInChunks(unique, (chunk) =>
		db
			.select({ id: invCountLists.id, name: invCountLists.name })
			.from(invCountLists)
			.where(inArray(invCountLists.id, chunk)),
	)
	return new Map(rows.map((row) => [row.id, row.name]))
}

/** The clock of a location: its zone, and the minute its business day starts. */
async function locationTimes(db: InventoryReader, locationId: string) {
	const time = await resolveLocationTime(db, locationId)
	return { timeZone: time.timeZone ?? 'UTC', dayStartMin: time.dayStartMin }
}

/**
 * When a schedule's `HH:MM` falls on a business date. A time before the day
 * start (01:00 with a 04:00 day start) is after midnight of that business day.
 */
export function dueAtFor(
	date: string,
	timeLocal: string,
	time: { timeZone: string; dayStartMin: number },
): number {
	const [hour, minute] = timeLocal.split(':').map(Number) as [number, number]
	let minutes = hour * 60 + minute
	if (minutes < time.dayStartMin) minutes += 24 * 60
	return Number(localToInstant(date, minutes, time.timeZone))
}

/** Whether a schedule applies on a business date. */
export function scheduleDueOn(row: ScheduleRow, date: string): boolean {
	return (
		row.archivedAt === null &&
		row.effectiveFrom <= date &&
		row.weekdays.includes(dayOfWeek(date))
	)
}

// ── Schedules ───────────────────────────────────────────────────────────────

export async function listCountSchedules(
	db: InventoryReader,
	locationId: string,
): Promise<CountSchedule[]> {
	const rows = await db
		.select()
		.from(invCountSchedules)
		.where(
			and(
				eq(invCountSchedules.locationId, locationId),
				isNull(invCountSchedules.archivedAt),
			),
		)
		.orderBy(asc(invCountSchedules.timeLocal), asc(invCountSchedules.id))
	const names = await listNames(
		db,
		rows.map((row) => row.listId),
	)
	return rows.map((row) =>
		toSchedule(row, row.listId ? (names.get(row.listId) ?? null) : null),
	)
}

async function loadSchedule(
	db: InventoryReader,
	id: string,
): Promise<ScheduleRow> {
	const row = await db
		.select()
		.from(invCountSchedules)
		.where(eq(invCountSchedules.id, id))
		.get()
	if (!row || row.archivedAt !== null) throw notFound()
	return row
}

async function assertListAtLocation(
	db: InventoryReader,
	listId: string | null,
	locationId: string,
): Promise<void> {
	if (listId === null) return
	const list = await db
		.select()
		.from(invCountLists)
		.where(eq(invCountLists.id, listId))
		.get()
	if (!list || list.archivedAt !== null || list.locationId !== locationId) {
		throw notFound()
	}
}

/** A staff assignee must be someone on the roster; a member is a login id (the App checks membership). */
async function assertAssignee(
	db: InventoryReader,
	assignee: CountAssignee | null | undefined,
): Promise<void> {
	if (!assignee || assignee.kind !== 'staff') return
	const staff = await db
		.select({ id: staffMembers.id, terminatedAt: staffMembers.terminatedAt })
		.from(staffMembers)
		.where(eq(staffMembers.id, assignee.id))
		.get()
	if (!staff || staff.terminatedAt !== null) {
		throw new InventoryError('schedule_invalid', 400, {
			reason: 'assignee_not_on_roster',
		})
	}
}

export async function createCountSchedule(
	caller: InventoryCaller,
	input: {
		body: CreateCountSchedule
		idempotency?: InventoryIdempotency | null
	},
): Promise<CountSchedule> {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			skipAutoSoldOut: true,
		},
		async (tx, ctx) => {
			await assertListAtLocation(tx, body.listId, body.locationId)
			await assertAssignee(tx, body.assignee)
			const existing = await tx
				.select({ id: invCountSchedules.id })
				.from(invCountSchedules)
				.where(
					and(
						eq(invCountSchedules.locationId, body.locationId),
						isNull(invCountSchedules.archivedAt),
					),
				)
			if (existing.length >= MAX_SCHEDULES_PER_LOCATION) {
				throw new InventoryError('limit_reached', 409)
			}
			// A schedule applies from tomorrow: today's plan is already made.
			const today = await locationBusinessDate(tx, body.locationId, ctx.now)
			const id = newId()
			await tx.insert(invCountSchedules).values({
				id,
				locationId: body.locationId,
				kind: body.kind,
				listId: body.listId,
				slot: body.slot,
				timeLocal: body.timeLocal,
				weekdays: body.weekdays,
				assigneeKind: body.assignee?.kind ?? null,
				assigneeId: body.assignee?.id ?? null,
				effectiveFrom: addDays(today, 1),
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'count_schedule.create',
				resourceType: 'count_schedule',
				resourceId: id,
				locationId: body.locationId,
				detail: { kind: body.kind, slot: body.slot, timeLocal: body.timeLocal },
				at: ctx.now,
			})
			const row = await loadSchedule(tx, id)
			const names = await listNames(tx, [row.listId])
			return toSchedule(
				row,
				row.listId ? (names.get(row.listId) ?? null) : null,
			)
		},
	)
}

export async function updateCountSchedule(
	caller: InventoryCaller,
	input: { id: string; body: UpdateCountSchedule },
): Promise<CountSchedule> {
	return withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const row = await loadSchedule(tx, input.id)
			assertLocationAllowed(caller.locationIds, row.locationId)
			assertVersion(row.version, input.body.expectedVersion)
			const { body } = input
			if (body.listId !== undefined) {
				await assertListAtLocation(tx, body.listId, row.locationId)
			}
			if (body.assignee !== undefined) await assertAssignee(tx, body.assignee)
			// Freeze today under the old plan first: a change applies from tomorrow.
			const today = await locationBusinessDate(tx, row.locationId, ctx.now)
			await materializeRuns(tx, row.locationId, today, ctx.now)
			const next = {
				listId: body.listId === undefined ? row.listId : body.listId,
				slot: body.slot ?? row.slot,
				timeLocal: body.timeLocal ?? row.timeLocal,
				weekdays: body.weekdays ?? row.weekdays,
				assigneeKind:
					body.assignee === undefined
						? row.assigneeKind
						: (body.assignee?.kind ?? null),
				assigneeId:
					body.assignee === undefined
						? row.assigneeId
						: (body.assignee?.id ?? null),
				effectiveFrom: addDays(today, 1),
				version: row.version + 1,
				updatedAt: ctx.now,
			}
			await tx
				.update(invCountSchedules)
				.set(next)
				.where(eq(invCountSchedules.id, row.id))
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'count_schedule.update',
				resourceType: 'count_schedule',
				resourceId: row.id,
				locationId: row.locationId,
				detail: { appliesFrom: next.effectiveFrom },
				at: ctx.now,
			})
			const updated = await loadSchedule(tx, row.id)
			const names = await listNames(tx, [updated.listId])
			return toSchedule(
				updated,
				updated.listId ? (names.get(updated.listId) ?? null) : null,
			)
		},
	)
}

export async function archiveCountSchedule(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<{ id: string }> {
	return withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const row = await loadSchedule(tx, input.id)
			assertLocationAllowed(caller.locationIds, row.locationId)
			assertVersion(row.version, input.expectedVersion)
			const today = await locationBusinessDate(tx, row.locationId, ctx.now)
			await materializeRuns(tx, row.locationId, today, ctx.now)
			await tx
				.update(invCountSchedules)
				.set({
					archivedAt: ctx.now,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invCountSchedules.id, row.id))
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'count_schedule.archive',
				resourceType: 'count_schedule',
				resourceId: row.id,
				locationId: row.locationId,
				at: ctx.now,
			})
			return { id: row.id }
		},
	)
}

// ── Runs ────────────────────────────────────────────────────────────────────

type ProjectedRun = {
	row: RunRow | null
	id: string
	scheduleId: string
	locationId: string
	date: string
	dueAt: number
	kind: ScheduleRow['kind']
	listId: string | null
	slot: string
	assigneeKind: string | null
	assigneeId: string | null
	countId: string | null
	status: RunRow['status']
	overdueAlertedAt: number | null
}

function fromRow(row: RunRow): ProjectedRun {
	return {
		row,
		id: row.id,
		scheduleId: row.scheduleId,
		locationId: row.locationId,
		date: row.runDate,
		dueAt: row.dueAt,
		kind: row.kind,
		listId: row.listId,
		slot: row.slot,
		assigneeKind: row.assigneeKind,
		assigneeId: row.assigneeId,
		countId: row.countId,
		status: row.status,
		overdueAlertedAt: row.overdueAlertedAt,
	}
}

/** The runs of one business day: stored ones, plus schedules due that day with no stored run yet. */
async function loadDayRuns(
	db: InventoryReader,
	locationId: string,
	date: string,
): Promise<ProjectedRun[]> {
	const [schedules, stored, time] = await Promise.all([
		db
			.select()
			.from(invCountSchedules)
			.where(eq(invCountSchedules.locationId, locationId)),
		db
			.select()
			.from(invCountScheduleRuns)
			.where(
				and(
					eq(invCountScheduleRuns.locationId, locationId),
					eq(invCountScheduleRuns.runDate, date),
				),
			),
		locationTimes(db, locationId),
	])
	const bySchedule = new Map(stored.map((row) => [row.scheduleId, row]))
	const runs: ProjectedRun[] = stored.map(fromRow)
	for (const schedule of schedules) {
		if (bySchedule.has(schedule.id) || !scheduleDueOn(schedule, date)) continue
		runs.push({
			row: null,
			id: `${schedule.id}:${date}`,
			scheduleId: schedule.id,
			locationId,
			date,
			dueAt: dueAtFor(date, schedule.timeLocal, time),
			kind: schedule.kind,
			listId: schedule.listId,
			slot: schedule.slot,
			assigneeKind: schedule.assigneeKind,
			assigneeId: schedule.assigneeId,
			countId: null,
			status: 'due',
			overdueAlertedAt: null,
		})
	}
	return runs.sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : 1))
}

/** A member assignee linked to a staff member (staff keep their App login id), so a till can show it to that person. */
async function staffByMember(
	db: InventoryReader,
	memberIds: readonly string[],
): Promise<Map<string, string>> {
	const unique = [...new Set(memberIds)]
	const rows = await queryInChunks(unique, (chunk) =>
		db
			.select({ id: staffMembers.id, userId: staffMembers.userId })
			.from(staffMembers)
			.where(inArray(staffMembers.userId, chunk)),
	)
	return new Map(
		rows.flatMap((row) => (row.userId ? [[row.userId, row.id] as const] : [])),
	)
}

/** The day's scheduled counts as the wire shape (Today, the till, "my schedule"). */
export async function listCountRuns(
	db: InventoryReader,
	input: { locationId: string; date: string; now: number },
): Promise<CountRun[]> {
	const runs = await loadDayRuns(db, input.locationId, input.date)
	if (runs.length === 0) return []
	const [names, linked] = await Promise.all([
		listNames(
			db,
			runs.map((run) => run.listId),
		),
		staffByMember(
			db,
			runs
				.filter((run) => run.assigneeKind === 'member' && run.assigneeId)
				.map((run) => run.assigneeId!),
		),
	])
	return runs.map((run) => {
		const assignee = assigneeOf(run.assigneeKind, run.assigneeId)
		const out: CountRun = {
			id: run.id,
			scheduleId: run.scheduleId,
			locationId: run.locationId,
			date: run.date,
			dueAt: run.dueAt,
			kind: run.kind,
			listId: run.listId,
			listName: run.listId ? (names.get(run.listId) ?? null) : null,
			slot: slotOf(run.slot),
			assignee,
			countId: run.countId,
			status: run.status,
			late:
				run.status === 'due' &&
				input.now >= run.dueAt + COUNT_OVERDUE_ALERT_AFTER_MS,
		}
		if (assignee?.kind === 'member') {
			out.assigneeStaffId = linked.get(assignee.id) ?? null
		}
		return out
	})
}

/** Stores the day's runs that are not stored yet (idempotent: unique per schedule and day). */
export async function materializeRuns(
	tx: InventoryTx,
	locationId: string,
	date: string,
	now: number,
): Promise<RunRow[]> {
	const runs = await loadDayRuns(tx, locationId, date)
	for (const run of runs) {
		if (run.row) continue
		await tx
			.insert(invCountScheduleRuns)
			.values({
				id: newId(),
				scheduleId: run.scheduleId,
				locationId,
				runDate: date,
				dueAt: run.dueAt,
				kind: run.kind,
				listId: run.listId,
				slot: run.slot,
				assigneeKind: run.assigneeKind,
				assigneeId: run.assigneeId,
				status: 'due',
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
	}
	return tx
		.select()
		.from(invCountScheduleRuns)
		.where(
			and(
				eq(invCountScheduleRuns.locationId, locationId),
				eq(invCountScheduleRuns.runDate, date),
			),
		)
}

/**
 * A count was started: find today's open run of the same kind and list, store
 * it, and mark it started. Returns the run id (the count remembers it) or null
 * when no schedule asked for this count.
 */
export async function claimRunForCount(
	tx: InventoryTx,
	input: {
		locationId: string
		kind: 'full' | 'quick'
		listId: string | null
		countId: string
		now: number
	},
): Promise<string | null> {
	const date = await locationBusinessDate(tx, input.locationId, input.now)
	const runs = await materializeRuns(tx, input.locationId, date, input.now)
	const match = runs
		.filter(
			(run) =>
				run.status === 'due' &&
				run.countId === null &&
				run.kind === input.kind &&
				(run.listId ?? null) === input.listId,
		)
		.sort((a, b) => a.dueAt - b.dueAt)[0]
	if (!match) return null
	await tx
		.update(invCountScheduleRuns)
		.set({ status: 'started', countId: input.countId, updatedAt: input.now })
		.where(eq(invCountScheduleRuns.id, match.id))
	return match.id
}

/**
 * A quick count still being counted when its next scheduled time arrives is
 * closed as "not finished": cancelled, never merged into stock (#490).
 */
export async function closeStaleQuickCounts(
	tx: InventoryTx,
	input: { locationId: string; now: number },
): Promise<number> {
	const open = await tx
		.select()
		.from(invCounts)
		.where(
			and(
				eq(invCounts.locationId, input.locationId),
				eq(invCounts.kind, 'quick'),
				eq(invCounts.status, 'counting'),
			),
		)
	if (open.length === 0) return 0
	const [schedules, time] = await Promise.all([
		tx
			.select()
			.from(invCountSchedules)
			.where(
				and(
					eq(invCountSchedules.locationId, input.locationId),
					eq(invCountSchedules.kind, 'quick'),
					isNull(invCountSchedules.archivedAt),
				),
			),
		locationTimes(tx, input.locationId),
	])
	if (schedules.length === 0) return 0
	let closed = 0
	for (const count of open) {
		const next = nextQuickDueAfter(schedules, count, time)
		if (next === null || next > input.now) continue
		await tx
			.update(invCounts)
			.set({
				status: 'cancelled',
				cancelledAt: input.now,
				version: count.version + 1,
				updatedAt: input.now,
			})
			.where(eq(invCounts.id, count.id))
		if (count.scheduleRunId) {
			await tx
				.update(invCountScheduleRuns)
				.set({ status: 'not_finished', updatedAt: input.now })
				.where(eq(invCountScheduleRuns.id, count.scheduleRunId))
		}
		await recordInventoryAudit(tx, {
			actorKind: 'system',
			actorId: null,
			action: 'count.not_finished',
			resourceType: 'count',
			resourceId: count.id,
			locationId: count.locationId,
			at: input.now,
		})
		closed += 1
	}
	return closed
}

/** The first scheduled quick-count time after `count` was started, for its list. */
function nextQuickDueAfter(
	schedules: readonly ScheduleRow[],
	count: typeof invCounts.$inferSelect,
	time: { timeZone: string; dayStartMin: number },
): number | null {
	let best: number | null = null
	for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset++) {
		const date = addDays(count.businessDate, offset)
		for (const schedule of schedules) {
			if ((schedule.listId ?? null) !== (count.listId ?? null)) continue
			if (!scheduleDueOn(schedule, date)) continue
			const due = dueAtFor(date, schedule.timeLocal, time)
			// The count's own scheduled time is not "the next one".
			if (due <= count.createdAt) continue
			if (best === null || due < best) best = due
		}
		if (best !== null) break
	}
	return best
}

/** Runs due an hour ago or more with no count started and no alert yet (#491). */
export async function overdueRunsToAlert(
	db: InventoryReader,
	input: { locationId: string; now: number },
): Promise<RunRow[]> {
	return db
		.select()
		.from(invCountScheduleRuns)
		.where(
			and(
				eq(invCountScheduleRuns.locationId, input.locationId),
				eq(invCountScheduleRuns.status, 'due'),
				isNull(invCountScheduleRuns.countId),
				isNull(invCountScheduleRuns.overdueAlertedAt),
				lte(
					invCountScheduleRuns.dueAt,
					input.now - COUNT_OVERDUE_ALERT_AFTER_MS,
				),
			),
		)
		.orderBy(asc(invCountScheduleRuns.dueAt))
}

/** The alert reached the App (or was refused for good): never again for this run. */
export async function markOverdueAlerted(
	db: InventoryReader | InventoryTx,
	runId: string,
	now: number,
): Promise<void> {
	await (db as InventoryTx)
		.update(invCountScheduleRuns)
		.set({ overdueAlertedAt: now, updatedAt: now })
		.where(eq(invCountScheduleRuns.id, runId))
}

/**
 * The counts a person has to do over the next days: assigned to this staff
 * member, or to the member who is this staff member (the staff keep their App
 * login id). Locations are the ones that have a schedule; each uses its own
 * business date.
 */
export async function listCountRunsForStaff(
	db: InventoryReader,
	input: {
		staffId: string
		userId: string | null
		now: number
		/** How many business days to look at, starting today (default 7). */
		days?: number
	},
): Promise<CountRun[]> {
	const out: CountRun[] = []
	const days = input.days ?? 7
	for (const locationId of await scheduledLocationIds(db)) {
		const today = await locationBusinessDate(db, locationId, input.now)
		for (let offset = 0; offset < days; offset++) {
			const runs = await listCountRuns(db, {
				locationId,
				date: addDays(today, offset),
				now: input.now,
			})
			for (const run of runs) {
				if (run.status === 'not_finished') continue
				const mine =
					(run.assignee?.kind === 'staff' &&
						run.assignee.id === input.staffId) ||
					(run.assignee?.kind === 'member' &&
						input.userId !== null &&
						run.assignee.id === input.userId)
				if (mine) out.push(run)
			}
		}
	}
	return out.sort((a, b) => a.dueAt - b.dueAt)
}

/** Locations that have a schedule (the tick works on these). */
export async function scheduledLocationIds(
	db: InventoryReader,
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ id: invCountSchedules.locationId })
		.from(invCountSchedules)
		.where(isNull(invCountSchedules.archivedAt))
	return rows.map((row) => row.id)
}
