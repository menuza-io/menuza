import { and, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm'
import {
	breakIsPaid,
	businessDateOf,
	hasBlockingIssue,
	resolveLocalBreakTimes,
	resolveLocalCardTimes,
	STAFFING_PERMISSIONS as P,
	statusAfterClose,
	type LaborPolicyView,
	type TimeCardBreakInput,
	type TimeCardCreate,
	type TimeCardReview,
	type TimeCardUpdate,
	type TimeCardVoid,
	type TimesheetBatchResult,
	type TimesheetErrorCode,
	type TimesheetStatus,
} from '@repo/staffing'
import {
	notificationOutbox,
	staffScopeAssignments,
	staffMembers,
	timeBreaks,
	timeEntries,
	timeEntryEdits,
	type TenantDatabase,
	type TimeBreakRow,
	type TimeEntry,
	type TimeEntryEdit,
	runTenantTransaction,
} from '@repo/tenant-db'
import { getScopeFacts } from '../lib/scope-context.ts'
import { OPAQUE_ID_PATTERN } from '../lib/staff-http.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { hasGrant } from '../lib/staff-auth.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import {
	activeJobs,
	positionOptions,
	type JobWithPosition,
} from './punch-service.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import {
	issuesForEntry,
	loadBreaks,
	refreshStaffCaches,
	snapshotCard,
} from './time-entry-calc.ts'
import {
	fail,
	ok,
	type TimesheetContext,
	type TimesheetFailure,
	type TimesheetResult,
} from './timesheet-shared.ts'

/**
 * Write side of the timesheets. Every change goes through one SQLite
 * transaction that (1) checks the card is editable (locked cards are immutable
 * until unlocked, approved cards must be reopened first), (2) validates the
 * times, (3) writes the change, (4) recomputes issues and cached figures with
 * the shared time math, and (5) appends to the edit log, the staff
 * notification outbox and the audit log. No path writes a card without an
 * edit-log row, and the log refuses blank reasons and any later change.
 *
 * The database triggers are the last line of defence (overlap, locked
 * immutability, append-only log); the checks here exist so a caller gets a
 * stable code instead of a constraint error.
 */

export type WriteContext = Omit<TimesheetContext, 'db'> & { db: TenantDatabase }

export type WriteOutcome = {
	entryId: string
	edit: TimeEntryEdit
	/** The edit cut the person's paid hours. */
	reducedHours: boolean
}

/** A card is never longer than the longest long-shift limit a policy can set. */
export const MAX_CARD_MINUTES = 48 * 60
const MS_PER_MINUTE = 60_000

function rootMessage(error: unknown): string {
	let root: unknown = error
	while (root instanceof Error && (root as { cause?: unknown }).cause) {
		root = (root as { cause?: unknown }).cause
	}
	return root instanceof Error ? root.message : ''
}

/** Turns a constraint the triggers raised into the code the caller should see. */
function mapWriteError(error: unknown): TimesheetFailure | null {
	const message = rootMessage(error)
	if (/time entries overlap/i.test(message))
		return fail(409, 'overlaps_existing')
	if (/time entry is locked/i.test(message)) return fail(409, 'card_locked')
	if (/UNIQUE constraint failed: time_entries\.staff_id/i.test(message)) {
		return fail(409, 'overlaps_existing')
	}
	return null
}

async function transact<T>(
	ctx: WriteContext,
	run: (tx: StaffDb) => Promise<TimesheetResult<T>>,
): Promise<TimesheetResult<T>> {
	try {
		return await retryOnSqliteBusy(() =>
			runTenantTransaction(ctx.db, (tx) => run(tx)),
		)
	} catch (error) {
		const mapped = mapWriteError(error)
		if (mapped) return mapped
		throw error
	}
}

// ---------------------------------------------------------------------------
// Snapshots (what the edit log keeps)
// ---------------------------------------------------------------------------

async function readEntry(
	db: StaffDb,
	id: string,
): Promise<{ entry: TimeEntry; breaks: TimeBreakRow[] } | null> {
	const [entry] = await db
		.select()
		.from(timeEntries)
		.where(eq(timeEntries.id, id))
		.limit(1)
	if (!entry) return null
	const breaks = (await loadBreaks(db, [id])).get(id) ?? []
	return { entry, breaks }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type PlannedBreak = {
	kind: 'meal' | 'rest'
	paid: boolean
	startAt: number
	endAt: number
}

/** Pure checks on a card's times; returns the first problem or null. */
export function validateCardWindow(input: {
	clockInAt: number
	clockOutAt: number | null
	breaks: readonly { startAt: number; endAt: number }[]
	now: number
}): TimesheetFailure | null {
	const { clockInAt, clockOutAt, now } = input
	if (clockInAt > now) return fail(422, 'in_future', { field: 'clockInAt' })
	if (clockOutAt !== null) {
		if (clockOutAt <= clockInAt) return fail(422, 'ends_before_start')
		if (clockOutAt > now) return fail(422, 'in_future', { field: 'clockOutAt' })
		if ((clockOutAt - clockInAt) / MS_PER_MINUTE > MAX_CARD_MINUTES) {
			return fail(422, 'too_long')
		}
	}
	const sorted = [...input.breaks].sort((a, b) => a.startAt - b.startAt)
	for (const [index, brk] of sorted.entries()) {
		if (brk.endAt <= brk.startAt) return fail(422, 'break_outside_card')
		if (brk.startAt < clockInAt) return fail(422, 'break_outside_card')
		if (clockOutAt !== null && brk.endAt > clockOutAt) {
			return fail(422, 'break_outside_card')
		}
		if (brk.endAt > now) return fail(422, 'in_future', { field: 'breaks' })
		const next = sorted[index + 1]
		if (next && next.startAt < brk.endAt) return fail(422, 'breaks_overlap')
	}
	return null
}

/** Any other live card of the person that overlaps the window (an open card runs to now and beyond). */
async function findOverlap(
	db: StaffDb,
	staffId: string,
	clockInAt: number,
	clockOutAt: number | null,
	exceptId: string | null,
) {
	const FOREVER = Number.MAX_SAFE_INTEGER
	const rows = await db
		.select({
			id: timeEntries.id,
			clockInAt: timeEntries.clockInAt,
			clockOutAt: timeEntries.clockOutAt,
		})
		.from(timeEntries)
		.where(
			and(
				eq(timeEntries.staffId, staffId),
				isNull(timeEntries.voidedAt),
				exceptId ? ne(timeEntries.id, exceptId) : undefined,
				lt(timeEntries.clockInAt, clockOutAt ?? FOREVER),
				or(
					isNull(timeEntries.clockOutAt),
					gt(timeEntries.clockOutAt, clockInAt),
				),
				// Two open cards are the unique index's business; an open card being
				// edited is only compared with closed ones here.
				clockOutAt === null
					? sql`${timeEntries.clockOutAt} is not null`
					: undefined,
			),
		)
		.limit(1)
	return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Resolving inputs
// ---------------------------------------------------------------------------

/** Scope time zone: control-plane facts, then the policy snapshot, then what the scope already recorded. */
async function resolveTimeZone(
	ctx: WriteContext,
	scopeId: string,
	policy: LaborPolicyView,
): Promise<string | null> {
	const facts = await getScopeFacts(ctx.auth.orgId, scopeId, ctx.now)
	if (facts) return facts.timeZone
	if (policy.timeZone) return policy.timeZone
	const [latest] = await ctx.db
		.select({ timeZone: timeEntries.timeZone })
		.from(timeEntries)
		.where(eq(timeEntries.scopeId, scopeId))
		.orderBy(sql`${timeEntries.clockInAt} desc`)
		.limit(1)
	return latest?.timeZone ?? null
}

function resolveBreaks(
	inputs: readonly TimeCardBreakInput[],
	clockInAt: number,
	timeZone: string,
	policy: LaborPolicyView,
): PlannedBreak[] {
	return inputs.map((input) => {
		const kind = input.kind ?? 'meal'
		const times =
			'startAt' in input
				? { startAt: input.startAt, endAt: input.endAt }
				: resolveLocalBreakTimes(input, clockInAt, timeZone)
		return {
			kind,
			// Paid or unpaid comes from the scope's break rules for the kind,
			// never from the caller.
			paid: breakIsPaid(policy.breakRules.rules, kind),
			startAt: Math.floor(times.startAt / MS_PER_MINUTE) * MS_PER_MINUTE,
			endAt: Math.floor(times.endAt / MS_PER_MINUTE) * MS_PER_MINUTE,
		}
	})
}

type JobChoice =
	| { ok: true; pick: JobWithPosition | null }
	| { ok: false; failure: TimesheetFailure }

function chooseJob(
	jobs: readonly JobWithPosition[],
	positionId: string | undefined,
): JobChoice {
	if (positionId !== undefined) {
		const pick = jobs.find((j) => j.position.id === positionId)
		if (!pick) return { ok: false, failure: fail(422, 'invalid_position') }
		return { ok: true, pick }
	}
	const options = positionOptions(jobs)
	if (options.length > 1) {
		return {
			ok: false,
			failure: fail(422, 'position_required', { positions: options }),
		}
	}
	return { ok: true, pick: jobs[0] ?? null }
}

/** Rate snapshot of a pay row, taken as the kiosk takes it at clock-in. */
function jobSnapshot(pick: JobWithPosition | null) {
	if (!pick) {
		return {
			jobId: null,
			positionId: null,
			rateMinor: null,
			currency: null,
			overtimeExempt: false,
		}
	}
	const { job, position } = pick
	return {
		jobId: job.id,
		positionId: position.id,
		rateMinor:
			job.payType === 'hourly'
				? (job.rateMinor ?? position.defaultRateMinor ?? null)
				: null,
		currency: job.currency ?? position.currency ?? null,
		overtimeExempt: job.overtimeExempt,
	}
}

function payGrantFailure(): TimesheetFailure {
	return fail(403, 'Forbidden', { required: P.READ_STAFF_PAY })
}

// ---------------------------------------------------------------------------
// Recompute and log
// ---------------------------------------------------------------------------

/** Re-judges a card after a change and refreshes cached figures around it. */
async function settleCard(
	tx: StaffDb,
	id: string,
	policy: LaborPolicyView,
	now: number,
	extraFlags: readonly string[] = [],
) {
	const current = await readEntry(tx, id)
	if (!current) throw new Error('Card vanished inside its own transaction')
	const { entry, breaks } = current
	const issues = issuesForEntry(entry, breaks, policy, extraFlags, now)
	const closed = entry.clockOutAt !== null
	await tx
		.update(timeEntries)
		.set({
			issues,
			status: closed ? statusAfterClose(issues) : 'open',
			updatedAt: now,
		})
		.where(eq(timeEntries.id, id))
	if (closed) {
		await refreshStaffCaches(
			tx,
			entry.staffId,
			{ clockInAt: entry.clockInAt },
			now,
		)
	}
	const settled = await readEntry(tx, id)
	return settled!
}

async function appendEdit(
	tx: StaffDb,
	ctx: WriteContext,
	input: {
		entry: TimeEntry
		action: string
		reason: string
		before: Record<string, unknown> | null
		after: Record<string, unknown> | null
		hoursDeltaMinutes: number | null
	},
): Promise<TimeEntryEdit> {
	const [edit] = await tx
		.insert(timeEntryEdits)
		.values({
			entryId: input.entry.id,
			staffId: input.entry.staffId,
			scopeId: input.entry.scopeId,
			editorId: ctx.auth.userId,
			via: 'manager',
			action: input.action,
			reason: input.reason,
			before: input.before,
			after: input.after,
			hoursDeltaMinutes: input.hoursDeltaMinutes,
			createdAt: ctx.now,
		})
		.returning()
	return edit!
}

/** Queues the message that tells the person their card changed; ids and facts, never pay. */
async function notifyStaff(
	tx: StaffDb,
	ctx: WriteContext,
	edit: TimeEntryEdit,
	entry: TimeEntry,
	reducedHours: boolean,
) {
	await tx
		.insert(notificationOutbox)
		.values({
			kind: 'time_card_edited',
			staffId: entry.staffId,
			scopeId: entry.scopeId,
			dedupeKey: `time_card_edited:${edit.id}`,
			payload: {
				entryId: entry.id,
				editId: edit.id,
				action: edit.action,
				localDate: entry.localDate,
				hoursDeltaMinutes: edit.hoursDeltaMinutes,
				reducedHours,
			},
			nextAttemptAt: ctx.now,
			createdAt: ctx.now,
		})
		.onConflictDoNothing()
}

function auditFor(
	tx: StaffDb,
	ctx: WriteContext,
	action: string,
	entry: TimeEntry,
	changes: Record<string, unknown>,
) {
	return writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
		action,
		entityType: 'time_entry',
		entityId: entry.id,
		staffId: entry.staffId,
		scopeId: entry.scopeId,
		changes,
	})
}

function editedFields(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): string[] {
	return Object.keys(after).filter(
		(key) =>
			key !== 'status' &&
			key !== 'paidMinutes' &&
			JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	)
}

function guardEditable(entry: TimeEntry): TimesheetFailure | null {
	if (entry.voidedAt !== null) return fail(404, 'not_found')
	if (entry.status === 'locked') return fail(409, 'card_locked')
	if (entry.status === 'approved') return fail(409, 'card_approved')
	return null
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCard(
	ctx: WriteContext,
	input: TimeCardCreate,
): Promise<TimesheetResult<WriteOutcome>> {
	if (!OPAQUE_ID_PATTERN.test(input.scopeId)) return fail(404, 'not_found')
	if (!ctx.scope.allows(input.scopeId)) return fail(404, 'not_found')
	const touchesTips =
		input.cashTipsMinor !== undefined || input.creditTipsMinor !== undefined
	if (touchesTips && !hasGrant(ctx.auth, P.READ_STAFF_PAY)) {
		return payGrantFailure()
	}

	const policy = await resolvePolicy(ctx.db, input.scopeId)
	const timeZone = await resolveTimeZone(ctx, input.scopeId, policy)
	if (!timeZone) return fail(422, 'time_zone_unavailable')

	const times =
		input.clockInAt !== undefined
			? { clockInAt: input.clockInAt, clockOutAt: input.clockOutAt! }
			: resolveLocalCardTimes(
					{
						date: input.date!,
						startTime: input.startTime!,
						endTime: input.endTime!,
					},
					timeZone,
				)
	const clockInAt = Math.floor(times.clockInAt / MS_PER_MINUTE) * MS_PER_MINUTE
	const clockOutAt =
		Math.floor(times.clockOutAt / MS_PER_MINUTE) * MS_PER_MINUTE
	const breaks = resolveBreaks(input.breaks, clockInAt, timeZone, policy)
	const invalid = validateCardWindow({
		clockInAt,
		clockOutAt,
		breaks,
		now: ctx.now,
	})
	if (invalid) return invalid
	const localDate = businessDateOf(
		clockInAt,
		timeZone,
		policy.workdayStartMinute,
	)

	return transact(ctx, async (tx) => {
		// Not found rather than "not assigned": a manager must not be able to
		// probe which people exist at other scopes.
		const [member] = await tx
			.select({ id: staffMembers.id })
			.from(staffMembers)
			.innerJoin(
				staffScopeAssignments,
				and(
					eq(staffScopeAssignments.staffId, staffMembers.id),
					eq(staffScopeAssignments.scopeId, input.scopeId),
				),
			)
			.where(eq(staffMembers.id, input.staffId))
			.limit(1)
		if (!member) return fail(404, 'not_found')

		const jobs = await activeJobs(tx, input.staffId, input.scopeId, localDate)
		const choice = chooseJob(jobs, input.positionId)
		if (!choice.ok) return choice.failure
		const snap = jobSnapshot(choice.pick)

		const clash = await findOverlap(
			tx,
			input.staffId,
			clockInAt,
			clockOutAt,
			null,
		)
		if (clash) {
			return fail(409, 'overlaps_existing', {
				conflict: {
					entryId: clash.id,
					clockInAt: clash.clockInAt,
					clockOutAt: clash.clockOutAt,
				},
			})
		}

		const [created] = await tx
			.insert(timeEntries)
			.values({
				staffId: input.staffId,
				scopeId: input.scopeId,
				jobId: snap.jobId,
				positionId: snap.positionId,
				clockInAt,
				clockOutAt,
				timeZone,
				localDate,
				status: 'closed',
				issues: ['edited'],
				rateMinor: snap.rateMinor,
				currency: snap.currency,
				overtimeExempt: snap.overtimeExempt,
				cashTipsMinor: input.cashTipsMinor ?? 0,
				creditTipsMinor: input.creditTipsMinor ?? 0,
				managerNote: input.managerNote ?? null,
				clockOutKind: 'manager',
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			.returning()
		for (const brk of breaks) {
			await tx.insert(timeBreaks).values({
				entryId: created!.id,
				kind: brk.kind,
				paid: brk.paid,
				startAt: brk.startAt,
				endAt: brk.endAt,
				createdAt: ctx.now,
			})
		}

		const settled = await settleCard(tx, created!.id, policy, ctx.now, [
			'edited',
		])
		const after = snapshotCard(settled.entry, settled.breaks)
		const delta = settled.entry.paidMinutes
		const edit = await appendEdit(tx, ctx, {
			entry: settled.entry,
			action: 'create',
			reason: input.reason,
			before: null,
			after,
			hoursDeltaMinutes: delta,
		})
		await notifyStaff(tx, ctx, edit, settled.entry, false)
		await auditFor(tx, ctx, 'timesheet.card.created', settled.entry, {
			editId: edit.id,
			hoursDeltaMinutes: delta,
		})
		return ok({ entryId: settled.entry.id, edit, reducedHours: false })
	})
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateCard(
	ctx: WriteContext,
	id: string,
	input: TimeCardUpdate,
): Promise<TimesheetResult<WriteOutcome>> {
	if (!OPAQUE_ID_PATTERN.test(id)) return fail(404, 'not_found')
	const touchesTips =
		input.cashTipsMinor !== undefined || input.creditTipsMinor !== undefined
	if (touchesTips && !hasGrant(ctx.auth, P.READ_STAFF_PAY)) {
		return payGrantFailure()
	}

	const first = await readEntry(ctx.db, id)
	if (!first || !ctx.scope.allows(first.entry.scopeId)) {
		return fail(404, 'not_found')
	}
	const policy = await resolvePolicy(ctx.db, first.entry.scopeId)

	return transact(ctx, async (tx) => {
		const current = await readEntry(tx, id)
		if (!current || !ctx.scope.allows(current.entry.scopeId)) {
			return fail(404, 'not_found')
		}
		const { entry, breaks: oldBreaks } = current
		const blocked = guardEditable(entry)
		if (blocked) return blocked
		if (entry.version !== input.expectedVersion) {
			return fail(409, 'stale_version', { currentVersion: entry.version })
		}

		const timeZone = entry.timeZone
		let clockInAt = entry.clockInAt
		let clockOutAt = entry.clockOutAt
		if (input.date !== undefined) {
			const resolved = resolveLocalCardTimes(
				{
					date: input.date,
					startTime: input.startTime!,
					endTime: input.endTime!,
				},
				timeZone,
			)
			clockInAt = resolved.clockInAt
			clockOutAt = resolved.clockOutAt
		} else {
			if (input.clockInAt !== undefined) clockInAt = input.clockInAt
			if (input.clockOutAt !== undefined) clockOutAt = input.clockOutAt
		}
		clockInAt = Math.floor(clockInAt / MS_PER_MINUTE) * MS_PER_MINUTE
		if (clockOutAt !== null) {
			clockOutAt = Math.floor(clockOutAt / MS_PER_MINUTE) * MS_PER_MINUTE
		}
		const closing = entry.clockOutAt === null && clockOutAt !== null

		// Breaks: replaced when given, otherwise kept. An open break (the person
		// is on break right now) is ended at the clock-out when the card closes,
		// as the kiosk does.
		let planned: PlannedBreak[]
		let breaksChanged = false
		if (input.breaks !== undefined) {
			if (clockOutAt === null) return fail(422, 'breaks_need_clock_out')
			planned = resolveBreaks(input.breaks, clockInAt, timeZone, policy)
			breaksChanged = true
		} else {
			planned = []
			for (const brk of oldBreaks) {
				if (brk.voidedAt !== null) continue
				if (brk.endAt === null) {
					if (clockOutAt === null) continue
					planned.push({
						kind: brk.kind,
						paid: brk.paid,
						startAt: brk.startAt,
						endAt: clockOutAt,
					})
					breaksChanged = true
				} else {
					planned.push({
						kind: brk.kind,
						paid: brk.paid,
						startAt: brk.startAt,
						endAt: brk.endAt,
					})
				}
			}
		}
		const invalid = validateCardWindow({
			clockInAt,
			clockOutAt,
			breaks: planned,
			now: ctx.now,
		})
		if (invalid) return invalid

		// Position: a different role re-takes the rate snapshot of that pay row.
		const localDate = businessDateOf(
			clockInAt,
			timeZone,
			policy.workdayStartMinute,
		)
		let snap: ReturnType<typeof jobSnapshot> | null = null
		if (
			input.positionId !== undefined &&
			input.positionId !== entry.positionId
		) {
			const jobs = await activeJobs(tx, entry.staffId, entry.scopeId, localDate)
			const choice = chooseJob(jobs, input.positionId)
			if (!choice.ok) return choice.failure
			snap = jobSnapshot(choice.pick)
		}

		const next = {
			...entry,
			clockInAt,
			clockOutAt,
			localDate,
			...snap,
			cashTipsMinor: input.cashTipsMinor ?? entry.cashTipsMinor,
			creditTipsMinor: input.creditTipsMinor ?? entry.creditTipsMinor,
			managerNote:
				input.managerNote === undefined ? entry.managerNote : input.managerNote,
		}

		const before = snapshotCard(entry, oldBreaks)
		const plannedRows = planned.map((b) => ({
			kind: b.kind,
			paid: b.paid,
			startAt: b.startAt,
			endAt: b.endAt,
		}))
		const afterPlan = {
			...snapshotCard(next, []),
			breaks: plannedRows,
		}
		if (editedFields(before, afterPlan).length === 0) {
			return fail(422, 'nothing_to_change')
		}

		const clash = await findOverlap(
			tx,
			entry.staffId,
			clockInAt,
			clockOutAt,
			entry.id,
		)
		if (clash) {
			return fail(409, 'overlaps_existing', {
				conflict: {
					entryId: clash.id,
					clockInAt: clash.clockInAt,
					clockOutAt: clash.clockOutAt,
				},
			})
		}

		const updated = await tx
			.update(timeEntries)
			.set({
				clockInAt,
				clockOutAt,
				localDate,
				jobId: next.jobId,
				positionId: next.positionId,
				rateMinor: next.rateMinor,
				currency: next.currency,
				overtimeExempt: next.overtimeExempt,
				cashTipsMinor: next.cashTipsMinor,
				creditTipsMinor: next.creditTipsMinor,
				managerNote: next.managerNote,
				clockOutKind: closing ? 'manager' : entry.clockOutKind,
				// The manager looked at it and changed it; a review mark belongs to the
				// version that was reviewed.
				reviewedBy: null,
				reviewedAt: null,
				version: entry.version + 1,
				updatedAt: ctx.now,
			})
			.where(
				and(
					eq(timeEntries.id, entry.id),
					eq(timeEntries.version, entry.version),
				),
			)
			.returning({ id: timeEntries.id })
		if (updated.length !== 1) {
			return fail(409, 'stale_version', { currentVersion: entry.version })
		}

		if (breaksChanged) {
			await tx
				.update(timeBreaks)
				.set({ voidedAt: ctx.now })
				.where(
					and(eq(timeBreaks.entryId, entry.id), isNull(timeBreaks.voidedAt)),
				)
			for (const brk of planned) {
				await tx.insert(timeBreaks).values({
					entryId: entry.id,
					kind: brk.kind,
					paid: brk.paid,
					startAt: brk.startAt,
					endAt: brk.endAt,
					createdAt: ctx.now,
				})
			}
		}

		const settled = await settleCard(tx, entry.id, policy, ctx.now, ['edited'])
		const after = snapshotCard(settled.entry, settled.breaks)
		// An open card measured nothing before; the change is what it now holds.
		const delta = settled.entry.paidMinutes - entry.paidMinutes
		const reducedHours = delta < 0
		const edit = await appendEdit(tx, ctx, {
			entry: settled.entry,
			action: 'update',
			reason: input.reason,
			before,
			after,
			hoursDeltaMinutes: delta,
		})
		await notifyStaff(tx, ctx, edit, settled.entry, reducedHours)
		await auditFor(tx, ctx, 'timesheet.card.updated', settled.entry, {
			editId: edit.id,
			fields: editedFields(before, after),
			hoursDeltaMinutes: delta,
			reducedHours,
		})
		return ok({ entryId: entry.id, edit, reducedHours })
	})
}

// ---------------------------------------------------------------------------
// Void (delete)
// ---------------------------------------------------------------------------

export async function voidCard(
	ctx: WriteContext,
	id: string,
	input: TimeCardVoid,
): Promise<TimesheetResult<WriteOutcome>> {
	if (!OPAQUE_ID_PATTERN.test(id)) return fail(404, 'not_found')
	return transact(ctx, async (tx) => {
		const current = await readEntry(tx, id)
		if (!current || !ctx.scope.allows(current.entry.scopeId)) {
			return fail(404, 'not_found')
		}
		const { entry, breaks } = current
		const blocked = guardEditable(entry)
		if (blocked) return blocked
		if (entry.version !== input.expectedVersion) {
			return fail(409, 'stale_version', { currentVersion: entry.version })
		}

		const before = snapshotCard(entry, breaks)
		const updated = await tx
			.update(timeEntries)
			.set({
				voidedAt: ctx.now,
				voidedBy: ctx.auth.userId,
				version: entry.version + 1,
				updatedAt: ctx.now,
			})
			.where(
				and(
					eq(timeEntries.id, entry.id),
					eq(timeEntries.version, entry.version),
				),
			)
			.returning({ id: timeEntries.id })
		if (updated.length !== 1) {
			return fail(409, 'stale_version', { currentVersion: entry.version })
		}
		await tx
			.update(timeBreaks)
			.set({ voidedAt: ctx.now })
			.where(and(eq(timeBreaks.entryId, entry.id), isNull(timeBreaks.voidedAt)))
		// The person's other cards may move overtime now that this one is gone.
		await refreshStaffCaches(
			tx,
			entry.staffId,
			{ clockInAt: entry.clockInAt },
			ctx.now,
		)

		const delta = -entry.paidMinutes
		const reducedHours = delta < 0
		const voided = (await readEntry(tx, entry.id))!
		const edit = await appendEdit(tx, ctx, {
			entry: voided.entry,
			action: 'void',
			reason: input.reason,
			before,
			after: { voided: true },
			hoursDeltaMinutes: delta,
		})
		await notifyStaff(tx, ctx, edit, voided.entry, reducedHours)
		await auditFor(tx, ctx, 'timesheet.card.voided', voided.entry, {
			editId: edit.id,
			hoursDeltaMinutes: delta,
			reducedHours,
		})
		return ok({ entryId: entry.id, edit, reducedHours })
	})
}

// ---------------------------------------------------------------------------
// Review (the manager looked; no time changed)
// ---------------------------------------------------------------------------

export async function reviewCard(
	ctx: WriteContext,
	id: string,
	input: TimeCardReview,
): Promise<TimesheetResult<WriteOutcome>> {
	if (!OPAQUE_ID_PATTERN.test(id)) return fail(404, 'not_found')
	const first = await readEntry(ctx.db, id)
	if (!first || !ctx.scope.allows(first.entry.scopeId)) {
		return fail(404, 'not_found')
	}
	const policy = await resolvePolicy(ctx.db, first.entry.scopeId)

	return transact(ctx, async (tx) => {
		const current = await readEntry(tx, id)
		if (!current || !ctx.scope.allows(current.entry.scopeId)) {
			return fail(404, 'not_found')
		}
		const { entry, breaks } = current
		const blocked = guardEditable(entry)
		if (blocked) return blocked
		if (entry.version !== input.expectedVersion) {
			return fail(409, 'stale_version', { currentVersion: entry.version })
		}
		if (entry.clockOutAt === null) return fail(409, 'open_card')
		const issues = issuesForEntry(entry, breaks, policy, [], ctx.now)
		if (hasBlockingIssue(issues)) return fail(409, 'needs_fix')

		const before = snapshotCard(entry, breaks)
		await tx
			.update(timeEntries)
			.set({
				status: 'closed',
				issues,
				reviewedBy: ctx.auth.userId,
				reviewedAt: ctx.now,
				version: entry.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(timeEntries.id, entry.id))
		const after = (await readEntry(tx, entry.id))!
		const edit = await appendEdit(tx, ctx, {
			entry: after.entry,
			action: 'review',
			reason: input.note?.trim() ? input.note : 'Reviewed',
			before: { status: before.status },
			after: { status: after.entry.status },
			hoursDeltaMinutes: null,
		})
		await auditFor(tx, ctx, 'timesheet.card.reviewed', after.entry, {
			editId: edit.id,
		})
		return ok({ entryId: entry.id, edit, reducedHours: false })
	})
}

// ---------------------------------------------------------------------------
// Approve, lock, unlock, reopen (separate `approve` grant)
// ---------------------------------------------------------------------------

export type BatchOp = 'approve' | 'lock' | 'unlock' | 'reopen'

const BATCH_DEFAULT_REASON: Record<BatchOp, string> = {
	approve: 'Approved',
	lock: 'Locked',
	unlock: 'Unlocked',
	reopen: 'Reopened',
}

const BATCH_AUDIT: Record<BatchOp, string> = {
	approve: 'timesheet.card.approved',
	lock: 'timesheet.card.locked',
	unlock: 'timesheet.card.unlocked',
	reopen: 'timesheet.card.reopened',
}

type Rejection = { code: TimesheetErrorCode }

async function applyBatchOp(
	tx: StaffDb,
	ctx: WriteContext,
	op: BatchOp,
	entry: TimeEntry,
	breaks: TimeBreakRow[],
	policy: LaborPolicyView,
	reason: string,
): Promise<Rejection | { status: TimesheetStatus; version: number }> {
	const before = { status: entry.status }
	const now = ctx.now

	if (op === 'approve') {
		if (entry.status === 'locked') return { code: 'already_locked' }
		if (entry.status === 'approved') return { code: 'already_approved' }
		if (entry.clockOutAt === null) return { code: 'open_card' }
		if (policy.timesheetApprovalMode === 'none') {
			return { code: 'approval_not_enabled' }
		}
		const issues = issuesForEntry(entry, breaks, policy, [], now)
		if (hasBlockingIssue(issues)) return { code: 'needs_fix' }
		// Freeze today's figures, not whatever was cached when the card closed.
		await refreshStaffCaches(
			tx,
			entry.staffId,
			{ clockInAt: entry.clockInAt },
			now,
		)
		await tx
			.update(timeEntries)
			.set({
				status: 'approved',
				issues,
				approvedBy: ctx.auth.userId,
				approvedAt: now,
				reviewedBy: ctx.auth.userId,
				reviewedAt: now,
				version: entry.version + 1,
				updatedAt: now,
			})
			.where(eq(timeEntries.id, entry.id))
	} else if (op === 'lock') {
		if (entry.status === 'locked') return { code: 'already_locked' }
		if (entry.status !== 'approved') return { code: 'not_approved' }
		if (policy.timesheetApprovalMode !== 'approve_lock') {
			return { code: 'lock_not_enabled' }
		}
		await tx
			.update(timeEntries)
			.set({
				status: 'locked',
				lockedBy: ctx.auth.userId,
				lockedAt: now,
				version: entry.version + 1,
				updatedAt: now,
			})
			.where(eq(timeEntries.id, entry.id))
	} else if (op === 'unlock') {
		if (entry.status !== 'locked') return { code: 'not_locked' }
		await tx
			.update(timeEntries)
			.set({
				status: 'approved',
				lockedBy: null,
				lockedAt: null,
				version: entry.version + 1,
				updatedAt: now,
			})
			.where(eq(timeEntries.id, entry.id))
	} else {
		if (entry.status === 'locked') return { code: 'card_locked' }
		if (entry.status !== 'approved') return { code: 'not_approved' }
		const issues = issuesForEntry(entry, breaks, policy, [], now)
		await tx
			.update(timeEntries)
			.set({
				status: statusAfterClose(issues),
				issues,
				approvedBy: null,
				approvedAt: null,
				reviewedBy: null,
				reviewedAt: null,
				version: entry.version + 1,
				updatedAt: now,
			})
			.where(eq(timeEntries.id, entry.id))
	}

	const after = (await readEntry(tx, entry.id))!
	const edit = await appendEdit(tx, ctx, {
		entry: after.entry,
		action: op,
		reason,
		before,
		after: { status: after.entry.status },
		hoursDeltaMinutes: null,
	})
	await auditFor(tx, ctx, BATCH_AUDIT[op], after.entry, { editId: edit.id })
	return { status: after.entry.status, version: after.entry.version }
}

/**
 * Approve, lock, unlock or reopen several cards. Each card is judged on its
 * own: a stale version, a card that needs fixing, or a scope without the
 * approval mode answers with a code for that card and the rest still go
 * through. The caller must hold `approve:timesheet:any`.
 */
export async function runBatch(
	ctx: WriteContext,
	op: BatchOp,
	entries: ReadonlyArray<{ id: string; version: number }>,
	reason: string | undefined,
): Promise<TimesheetResult<TimesheetBatchResult>> {
	if (!hasGrant(ctx.auth, P.APPROVE_TIMESHEET)) {
		return fail(403, 'Forbidden', { required: P.APPROVE_TIMESHEET })
	}
	const text = reason?.trim() ? reason : BATCH_DEFAULT_REASON[op]

	return transact(ctx, async (tx) => {
		const results: TimesheetBatchResult['results'] = []
		const policies = new Map<string, LaborPolicyView>()
		for (const { id, version } of entries) {
			const current = OPAQUE_ID_PATTERN.test(id)
				? await readEntry(tx, id)
				: null
			if (
				!current ||
				current.entry.voidedAt !== null ||
				!ctx.scope.allows(current.entry.scopeId)
			) {
				results.push({ id, ok: false, code: 'not_found' })
				continue
			}
			const { entry, breaks } = current
			if (entry.version !== version) {
				results.push({
					id,
					ok: false,
					code: 'stale_version',
					version: entry.version,
					status: entry.status,
				})
				continue
			}
			let policy = policies.get(entry.scopeId)
			if (!policy) {
				policy = await resolvePolicy(tx, entry.scopeId)
				policies.set(entry.scopeId, policy)
			}
			const outcome = await applyBatchOp(
				tx,
				ctx,
				op,
				entry,
				breaks,
				policy,
				text,
			)
			if ('code' in outcome) {
				results.push({
					id,
					ok: false,
					code: outcome.code,
					version: entry.version,
					status: entry.status,
				})
			} else {
				results.push({ id, ok: true, ...outcome })
			}
		}
		const changed = results.filter((r) => r.ok).length
		return ok({ results, changed, skipped: results.length - changed })
	})
}
