import { and, desc, eq, gte, isNull, lt, lte, max, or } from 'drizzle-orm'
import {
	allowedClockEvents,
	breakIsPaid,
	businessDateOf,
	checkOfflinePunchTime,
	type ClockEvent,
	type BreakKind,
	type ClockState,
	decideClockIn,
	decideClockOut,
	deriveClockState,
	type KioskErrorCode,
	type KioskPositionOption,
	type KioskPunchRequest,
	type KioskPunchResult,
	type LaborPolicyView,
	nextClockState,
	statusAfterClose,
	type ShiftLookup,
} from '@repo/staffing'
import {
	staffJobs,
	type StaffJob,
	type StaffScopeAssignment,
	staffMembers,
	type StaffMember,
	staffPositions,
	type StaffPosition,
	timeBreaks,
	type TimeBreakRow,
	timeEntries,
	timeEntryEdits,
	type TimeEntry,
	timePunches,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import { type StaffDb, writeDeviceAudit } from './staff-audit.ts'
import {
	issuesForEntry,
	loadBreaks,
	persistedPunchFlags,
	refreshStaffCaches,
	snapshotCard,
} from './time-entry-calc.ts'

/**
 * The punch engine. One call is one SQLite transaction that: returns the stored
 * result if the client-generated punch id was already processed (idempotency),
 * derives the person's state from their open entry, rejects impossible
 * transitions, applies the scope's labor policy, appends the punch (which is
 * immutable), updates the entry and breaks, and recomputes the cached minutes
 * through the shared time math. Server time is authoritative; the only client
 * time ever used is that of a punch queued while the tablet was offline, and
 * only inside the bounds in `checkOfflinePunchTime`.
 */

export type ShiftMatcherInput = {
	staffId: string
	scopeId: string
	atMs: number
	timeZone: string
}

/**
 * Finds the scheduled shift a punch belongs to. `undefined` means the schedule
 * is not available (so nothing about scheduling is judged); `null` means it is
 * and no shift matches. Scheduling registers the real implementation here; until
 * then every punch is judged on the clock alone.
 */
export type ShiftMatcher = (
	db: StaffDb,
	input: ShiftMatcherInput,
) => Promise<ShiftLookup>

export const noScheduleMatcher: ShiftMatcher = async () => undefined

export type PunchDeps = {
	now: () => number
	matchShift: ShiftMatcher
}

export const defaultPunchDeps: PunchDeps = {
	now: () => Date.now(),
	matchShift: noScheduleMatcher,
}

/**
 * Scheduling calls this once at start-up to supply real shift matching. Until
 * it does, late grace, prevent-early and unscheduled-punch rules are not judged.
 */
export function registerShiftMatcher(matcher: ShiftMatcher) {
	defaultPunchDeps.matchShift = matcher
}

export function resetShiftMatcher() {
	defaultPunchDeps.matchShift = noScheduleMatcher
}

/** Which kind of paired tablet took a punch. */
export type PunchSource = 'kiosk' | 'pos'

/** The paired tablet that took a punch: a time-clock kiosk or a Station terminal. */
export type PunchDevice = { id: string; scopeId: string }

export type PunchSubject = {
	orgId: string
	device: PunchDevice
	/** A kiosk when omitted. */
	source?: PunchSource
	assignment: StaffScopeAssignment
	member: StaffMember
	ipHash: string | null
	/** Scope time zone the caller resolved (control plane, policy, or device). */
	timeZone: string
}

export type PunchFailure = {
	ok: false
	status: 400 | 403 | 409 | 422
	code: KioskErrorCode
	extra?: Record<string, unknown>
}
export type PunchSuccess = { ok: true; result: KioskPunchResult }
export type PunchOutcome = PunchSuccess | PunchFailure

const FAILURE_STATUS: Partial<Record<KioskErrorCode, PunchFailure['status']>> =
	{
		time_tracking_disabled: 403,
		already_clocked_in: 409,
		not_clocked_in: 409,
		already_on_break: 409,
		not_on_break: 409,
		clocked_in_elsewhere: 409,
		overlaps_previous_entry: 409,
		time_conflict: 409,
		punch_id_conflict: 409,
		position_required: 409,
		invalid_position: 400,
		early_clock_in: 422,
		unscheduled_not_allowed: 422,
		punch_in_future: 422,
		punch_too_old: 422,
	}

function failure(
	code: KioskErrorCode,
	extra?: Record<string, unknown>,
): PunchFailure {
	return {
		ok: false,
		status: FAILURE_STATUS[code] ?? 422,
		code,
		...(extra ? { extra } : {}),
	}
}

function isUniqueViolation(error: unknown): boolean {
	let root: unknown = error
	while (root instanceof Error && (root as { cause?: unknown }).cause) {
		root = (root as { cause?: unknown }).cause
	}
	return (
		root instanceof Error &&
		/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(
			root.message,
		)
	)
}

/** The reason a transition is impossible, as a stable code. */
function stateRejection(state: ClockState, kind: ClockEvent): KioskErrorCode {
	if (kind === 'clock_in') return 'already_clocked_in'
	if (state === 'out') return 'not_clocked_in'
	if (kind === 'break_start') return 'already_on_break'
	return 'not_on_break'
}

type OpenEntry = {
	entry: TimeEntry
	openBreakId: string | null
	openBreakStart: number | null
}

async function loadOpenEntry(
	db: StaffDb,
	staffId: string,
): Promise<OpenEntry | null> {
	const [entry] = await db
		.select()
		.from(timeEntries)
		.where(
			and(
				eq(timeEntries.staffId, staffId),
				isNull(timeEntries.clockOutAt),
				isNull(timeEntries.voidedAt),
			),
		)
		.limit(1)
	if (!entry) return null
	const [brk] = await db
		.select()
		.from(timeBreaks)
		.where(
			and(
				eq(timeBreaks.entryId, entry.id),
				isNull(timeBreaks.endAt),
				isNull(timeBreaks.voidedAt),
			),
		)
		.limit(1)
	return {
		entry,
		openBreakId: brk?.id ?? null,
		openBreakStart: brk?.startAt ?? null,
	}
}

async function currentState(db: StaffDb, staffId: string): Promise<ClockState> {
	const open = await loadOpenEntry(db, staffId)
	return deriveClockState(
		open ? { clockOutAt: null, openBreak: open.openBreakId !== null } : null,
	)
}

export type JobWithPosition = { job: StaffJob; position: StaffPosition }

/** Pay rows in force at the scope on `localDate`, with their positions. */
export async function activeJobs(
	db: StaffDb,
	staffId: string,
	scopeId: string,
	localDate: string,
): Promise<JobWithPosition[]> {
	const rows = await db
		.select({ job: staffJobs, position: staffPositions })
		.from(staffJobs)
		.innerJoin(staffPositions, eq(staffPositions.id, staffJobs.positionId))
		.where(
			and(
				eq(staffJobs.staffId, staffId),
				eq(staffJobs.scopeId, scopeId),
				lte(staffJobs.effectiveFrom, localDate),
				or(
					isNull(staffJobs.effectiveTo),
					gte(staffJobs.effectiveTo, localDate),
				),
				isNull(staffPositions.archivedAt),
			),
		)
		.orderBy(desc(staffJobs.isPrimary), staffPositions.name)
	return rows
}

export function positionOptions(
	jobs: readonly JobWithPosition[],
): KioskPositionOption[] {
	const seen = new Set<string>()
	const options: KioskPositionOption[] = []
	for (const { position } of jobs) {
		if (seen.has(position.id)) continue
		seen.add(position.id)
		options.push({
			id: position.id,
			name: position.name,
			nameAr: position.nameAr,
		})
	}
	return options
}

/**
 * What a person may do right now and which roles they would pick from; used by
 * the identify step so the tablet can show the right buttons.
 */
export async function describeClockState(
	db: StaffDb,
	subject: Pick<PunchSubject, 'member' | 'device' | 'timeZone'>,
	now: number,
) {
	const open = await loadOpenEntry(db, subject.member.id)
	const state = deriveClockState(
		open ? { clockOutAt: null, openBreak: open.openBreakId !== null } : null,
	)
	const elsewhere =
		open !== null && open.entry.scopeId !== subject.device.scopeId
	const policy = await resolvePolicy(db, subject.device.scopeId)
	const localDate = businessDateOf(
		now,
		subject.timeZone,
		policy.workdayStartMinute,
	)
	const jobs =
		state === 'out'
			? await activeJobs(
					db,
					subject.member.id,
					subject.device.scopeId,
					localDate,
				)
			: []
	const allowedEvents =
		elsewhere || !policy.timeTrackingEnabled ? [] : allowedClockEvents(state)
	return {
		state,
		allowedEvents,
		// A workplace with rest-break rules lets people say which break they take.
		// Sent whatever the state, so a till can remember it for offline breaks.
		breakKinds: policy.breakRules.rules.some((rule) => rule.kind === 'rest')
			? (['meal', 'rest'] as BreakKind[])
			: [],
		positions: positionOptions(jobs).length > 1 ? positionOptions(jobs) : [],
		// Ask for cash tips at clock-out only for a role marked as receiving tips.
		promptTips:
			open !== null && !elsewhere
				? await entryReceivesTips(db, open.entry)
				: false,
	}
}

/** Whether the position or pay row an entry was opened under receives tips. */
async function entryReceivesTips(
	db: StaffDb,
	entry: TimeEntry,
): Promise<boolean> {
	if (entry.jobId) {
		const [job] = await db
			.select({ tipEligible: staffJobs.tipEligible })
			.from(staffJobs)
			.where(eq(staffJobs.id, entry.jobId))
			.limit(1)
		if (job?.tipEligible) return true
	}
	if (entry.positionId) {
		const [position] = await db
			.select({ tipEligible: staffPositions.tipEligible })
			.from(staffPositions)
			.where(eq(staffPositions.id, entry.positionId))
			.limit(1)
		if (position?.tipEligible) return true
	}
	return false
}

function successResult(
	kind: ClockEvent,
	state: ClockState,
	member: StaffMember,
	at: number,
	now: number,
	duplicate: boolean,
): PunchSuccess {
	return {
		ok: true,
		result: {
			outcome: 'accepted',
			duplicate,
			kind,
			state,
			firstName: member.firstName,
			at,
			serverNow: now,
		},
	}
}

/**
 * A punch this device already recorded under this id, answered as it was
 * (before any PIN check: the PIN may have been given to someone else since,
 * and a lost answer must never turn a recorded punch into a refused one).
 * A tablet paired again keeps its waiting punches but has a new device id:
 * its punch still counts as its own when it names the same person (ids are
 * random, so only the till that made the punch knows it). Null when there is
 * none, or it was refused.
 */
export async function replayRecordedPunch(
	db: TenantDatabase,
	deviceId: string,
	request: Pick<KioskPunchRequest, 'id' | 'kind' | 'staffId'>,
	now: number,
): Promise<PunchSuccess | null> {
	const [existing] = await db
		.select()
		.from(timePunches)
		.where(eq(timePunches.id, request.id))
		.limit(1)
	if (
		!existing ||
		(existing.deviceId !== deviceId &&
			(!request.staffId || existing.staffId !== request.staffId)) ||
		existing.kind !== request.kind ||
		existing.outcome !== 'accepted'
	)
		return null
	const [member] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, existing.staffId))
		.limit(1)
	if (!member) return null
	const state = await currentState(db, member.id)
	return successResult(
		existing.kind,
		state,
		member,
		existing.effectiveAt ?? existing.serverAt,
		now,
		true,
	)
}

/**
 * Processes one kiosk punch. Idempotent on `request.id`. Safe to call
 * concurrently for the same person: the open-entry and open-break unique
 * indexes are the arbiter, and a lost race is retried once against the new
 * state.
 */
export async function processPunch(
	db: TenantDatabase,
	subject: PunchSubject,
	request: KioskPunchRequest,
	deps: PunchDeps = defaultPunchDeps,
): Promise<PunchOutcome> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await retryOnSqliteBusy(() =>
				runTenantTransaction(db, (tx) => runPunch(tx, subject, request, deps)),
			)
		} catch (error) {
			if (attempt === 0 && isUniqueViolation(error)) continue
			throw error
		}
	}
	throw new Error('Unreachable')
}

async function runPunch(
	tx: StaffDb,
	subject: PunchSubject,
	request: KioskPunchRequest,
	deps: PunchDeps,
): Promise<PunchOutcome> {
	const { member, device, timeZone } = subject
	const source = subject.source ?? 'kiosk'
	const now = deps.now()
	const scopeId = device.scopeId

	// 1. Idempotency: the client id is the key. The same id from another person,
	// device or action is a conflict, never someone else's result.
	const [existing] = await tx
		.select()
		.from(timePunches)
		.where(eq(timePunches.id, request.id))
		.limit(1)
	if (existing) {
		if (
			existing.staffId !== member.id ||
			existing.deviceId !== device.id ||
			existing.kind !== request.kind
		) {
			return failure('punch_id_conflict')
		}
		if (existing.outcome === 'accepted') {
			const state = await currentState(tx, member.id)
			return successResult(
				existing.kind,
				state,
				member,
				existing.effectiveAt ?? existing.serverAt,
				now,
				true,
			)
		}
		return failure((existing.rejectCode as KioskErrorCode) ?? 'time_conflict')
	}

	const policy = await resolvePolicy(tx, scopeId)
	const open = await loadOpenEntry(tx, member.id)
	const state = deriveClockState(
		open ? { clockOutAt: null, openBreak: open.openBreakId !== null } : null,
	)

	// Everything below can reject; a rejection is recorded (append-only) and the
	// transaction still commits it, so replays answer the same.
	const flags: string[] = []
	let effectiveAt = now
	const reject = async (
		code: KioskErrorCode,
		extra?: Record<string, unknown>,
		outcome: 'rejected_state' | 'rejected_policy' = 'rejected_policy',
		/** The card a refused punch concerns, when it is not the open one. */
		entryId: string | null = open?.entry.id ?? null,
	): Promise<PunchFailure> => {
		await tx.insert(timePunches).values({
			id: request.id,
			staffId: member.id,
			scopeId,
			entryId,
			kind: request.kind,
			clientAt: request.clientAt,
			serverAt: now,
			effectiveAt: null,
			source,
			deviceId: device.id,
			outcome,
			rejectCode: code,
			flags: request.offline ? ['offline_punch'] : [],
			positionId: request.positionId ?? null,
			timeZone,
			localDate: businessDateOf(now, timeZone, policy.workdayStartMinute),
			ipHash: subject.ipHash,
			createdAt: now,
		})
		await writeDeviceAudit(tx, source, device, subject.ipHash, {
			action: `${source}.punch.rejected`,
			entityType: 'time_punch',
			entityId: request.id,
			staffId: member.id,
			scopeId,
			changes: { code, kind: request.kind, outcome },
		})
		return failure(code, extra)
	}

	if (!policy.timeTrackingEnabled) return reject('time_tracking_disabled')

	// 2. Which instant does this punch count at?
	if (request.offline) {
		const verdict = checkOfflinePunchTime(
			request.clientAt,
			now,
			request.deviceNowAt,
		)
		if (!verdict.ok) {
			return reject(
				verdict.reason === 'in_future' ? 'punch_in_future' : 'punch_too_old',
			)
		}
		effectiveAt = verdict.effectiveAtMs
		flags.push('offline_punch')
		if (verdict.flaggedSkew) flags.push('clock_skew')
		if (verdict.lateSync) flags.push('late_sync')
	}
	const localDate = businessDateOf(
		effectiveAt,
		timeZone,
		policy.workdayStartMinute,
	)

	// 3. State machine.
	if (open && open.entry.scopeId !== scopeId) {
		return reject('clocked_in_elsewhere', undefined, 'rejected_state')
	}
	// A punch saved offline after the server closed the shift on its own
	// (automatic clock-out, while the till could not send) belongs to that card:
	// the person was still there. A clock-out replaces the automatic time,
	// earlier or later; a break lands on the card and stretches it to when they
	// were last seen, until their clock-out arrives. The card keeps its
	// auto_clock_out flag and stays with a manager. One a manager has already
	// edited, approved or locked is left alone: the punch is refused, on it.
	let autoClosed: AutoClosedCard | null = null
	if (!open && request.offline && request.kind !== 'clock_in') {
		const [latest] = await tx
			.select()
			.from(timeEntries)
			.where(
				and(
					eq(timeEntries.staffId, member.id),
					isNull(timeEntries.voidedAt),
					lt(timeEntries.clockInAt, effectiveAt),
				),
			)
			.orderBy(desc(timeEntries.clockInAt))
			.limit(1)
		if (
			latest?.clockOutKind === 'auto' &&
			latest.clockOutAt !== null &&
			latest.scopeId === scopeId
		) {
			if (
				latest.status === 'approved' ||
				latest.status === 'locked' ||
				latest.issues.includes('edited')
			)
				return reject('not_clocked_in', undefined, 'rejected_state', latest.id)
			const breaks = (
				(await loadBreaks(tx, [latest.id])).get(latest.id) ?? []
			).filter((b) => b.voidedAt === null)
			autoClosed = {
				entry: latest,
				clockOutAt: latest.clockOutAt,
				breaks,
				// Still running when the card closed: it ends with the card.
				running:
					breaks.find(
						(b) => b.endPunchId === null && b.endAt === latest.clockOutAt,
					) ?? null,
			}
		}
	}
	const from = autoClosed ? (autoClosed.running ? 'on_break' : 'in') : state
	const next = nextClockState(from, request.kind)
	if (!next) {
		return reject(
			stateRejection(from, request.kind),
			undefined,
			'rejected_state',
			autoClosed?.entry.id,
		)
	}

	// 4. Ordering against what is already recorded (matters for queued punches).
	if (request.kind === 'clock_in') {
		const [latest] = await tx
			.select({ at: max(timeEntries.clockOutAt) })
			.from(timeEntries)
			.where(
				and(eq(timeEntries.staffId, member.id), isNull(timeEntries.voidedAt)),
			)
		if (latest?.at != null && effectiveAt < latest.at) {
			return reject('overlaps_previous_entry', undefined, 'rejected_state')
		}
	} else if (open) {
		const floor = Math.max(
			open.entry.clockInAt,
			request.kind === 'break_end' || request.kind === 'clock_out'
				? (open.openBreakStart ?? 0)
				: 0,
		)
		if (effectiveAt < floor)
			return reject('time_conflict', undefined, 'rejected_state')
	} else if (autoClosed) {
		// Never before a break that is already on the card.
		const floor = Math.max(
			autoClosed.entry.clockInAt,
			...autoClosed.breaks.map((b) =>
				b === autoClosed!.running ? b.startAt : (b.endAt ?? b.startAt),
			),
		)
		if (effectiveAt < floor)
			return reject(
				'time_conflict',
				undefined,
				'rejected_state',
				autoClosed.entry.id,
			)
	}

	// 5. Apply.
	let entryId: string
	let positionId: string | null = null

	if (request.kind === 'clock_in') {
		const jobs = await activeJobs(tx, member.id, scopeId, localDate)
		const shift = await deps.matchShift(tx, {
			staffId: member.id,
			scopeId,
			atMs: effectiveAt,
			timeZone,
		})
		const ruled = decideClockIn({ policy, atMs: effectiveAt, shift })
		// Online the person is told to wait or ask. A punch queued offline was
		// already accepted on the till and the person went to work: it is
		// recorded, flagged, and the card waits for a manager, rather than lost
		// along with the rest of that shift.
		if (!ruled.ok && !request.offline) {
			return reject(
				ruled.code,
				ruled.code === 'early_clock_in'
					? { earliestAt: ruled.earliestAt }
					: undefined,
			)
		}
		const early = !ruled.ok && ruled.code === 'early_clock_in'
		const decision = ruled.ok
			? ruled
			: {
					ok: true as const,
					flags: [
						early ? ('early_in' as const) : ('unscheduled' as const),
						'offline_override' as const,
					],
					// Early still has its shift: its role, its end and the schedule link.
					shift: early ? (shift ?? null) : null,
				}
		// Paid from the earliest allowed time, as if they had waited (as online);
		// the punch itself keeps the time it was tapped.
		// Never after now: a replay that arrives before then starts when it arrives.
		const clockInAt =
			!ruled.ok && ruled.code === 'early_clock_in'
				? Math.min(Math.max(effectiveAt, ruled.earliestAt), now)
				: effectiveAt

		let picked: JobWithPosition | null = null
		if (request.positionId) {
			picked = jobs.find((j) => j.position.id === request.positionId) ?? null
			if (!picked) return reject('invalid_position')
		} else if (jobs.length === 1) {
			picked = jobs[0]!
		} else if (jobs.length > 1) {
			const scheduled = decision.shift?.positionId
				? jobs.find((j) => j.position.id === decision.shift!.positionId)
				: undefined
			if (scheduled) {
				picked = scheduled
			} else if (request.offline) {
				// Nobody could be asked: the main job, for a manager to confirm.
				picked = jobs[0]!
				flags.push('offline_override')
			} else {
				// A prompt, not an event: nothing is recorded and the same punch id
				// is reused when the person picks.
				return failure('position_required', {
					positions: positionOptions(jobs),
				})
			}
		}
		positionId = picked?.position.id ?? null
		flags.push(...decision.flags)

		entryId = crypto.randomUUID()
		const rateMinor = picked
			? picked.job.payType === 'hourly'
				? (picked.job.rateMinor ?? picked.position.defaultRateMinor)
				: null
			: null
		await tx.insert(timeEntries).values({
			id: entryId,
			staffId: member.id,
			scopeId,
			jobId: picked?.job.id ?? null,
			positionId,
			shiftId: decision.shift?.id ?? null,
			clockInAt,
			timeZone,
			localDate,
			status: 'open',
			issues: [...new Set(flags)],
			rateMinor: rateMinor ?? null,
			currency: picked?.job.currency ?? picked?.position.currency ?? null,
			overtimeExempt: picked?.job.overtimeExempt ?? false,
			createdAt: now,
			updatedAt: now,
		})
	} else if (autoClosed) {
		entryId = autoClosed.entry.id
		positionId = autoClosed.entry.positionId
		await applyToAutoClosedCard(tx, autoClosed, {
			effectiveAt,
			now,
			policy,
			flags,
			request,
			deps,
			timeZone,
			source,
			deviceId: device.id,
		})
	} else {
		const entry = open!.entry
		entryId = entry.id
		positionId = entry.positionId

		if (request.kind === 'break_start') {
			const kind = request.breakKind ?? 'meal'
			await tx.insert(timeBreaks).values({
				entryId,
				kind,
				paid: breakIsPaid(policy.breakRules.rules, kind),
				startAt: effectiveAt,
				startPunchId: request.id,
				createdAt: now,
			})
			await touchEntry(tx, entry, now, flags)
		} else if (request.kind === 'break_end') {
			await tx
				.update(timeBreaks)
				.set({ endAt: effectiveAt, endPunchId: request.id })
				.where(eq(timeBreaks.id, open!.openBreakId!))
			await touchEntry(tx, entry, now, flags)
		} else {
			await closeEntry(tx, {
				entry,
				openBreakId: open!.openBreakId,
				effectiveAt,
				now,
				policy,
				flags,
				request,
				deps,
				timeZone,
				source,
			})
		}
	}

	await tx.insert(timePunches).values({
		id: request.id,
		staffId: member.id,
		scopeId,
		entryId,
		kind: request.kind,
		clientAt: request.clientAt,
		serverAt: now,
		effectiveAt,
		source,
		deviceId: device.id,
		outcome: 'accepted',
		flags: [...new Set(flags)],
		positionId,
		timeZone,
		localDate,
		ipHash: subject.ipHash,
		createdAt: now,
	})

	// A punch landing on a closed card leaves the person clocked out.
	return successResult(
		request.kind,
		autoClosed ? 'out' : next,
		member,
		effectiveAt,
		now,
		false,
	)
}

/** A card the automatic clock-out closed, with the breaks on it. */
type AutoClosedCard = {
	entry: TimeEntry
	clockOutAt: number
	breaks: TimeBreakRow[]
	/** A break still running when the card closed: it ends with the card. */
	running: TimeBreakRow | null
}

/**
 * Lands a punch saved offline on a card the automatic clock-out has closed
 * since (see `runPunch`), and writes the change to the card's history.
 */
async function applyToAutoClosedCard(
	tx: StaffDb,
	card: AutoClosedCard,
	input: {
		effectiveAt: number
		now: number
		policy: LaborPolicyView
		flags: string[]
		request: KioskPunchRequest
		deps: PunchDeps
		timeZone: string
		source: PunchSource
		deviceId: string
	},
) {
	const { entry, running } = card
	const { effectiveAt, now, policy, request } = input
	if (request.kind === 'clock_out') {
		await closeEntry(tx, {
			entry,
			openBreakId: running?.id ?? null,
			effectiveAt,
			now,
			policy,
			flags: input.flags,
			request,
			deps: input.deps,
			timeZone: input.timeZone,
			source: input.source,
			reopenReview: true,
		})
	} else {
		// Seen at work until then: the card stretches, and a running break with it.
		const clockOutAt = Math.max(card.clockOutAt, effectiveAt)
		if (request.kind === 'break_start') {
			const kind = request.breakKind ?? 'meal'
			await tx.insert(timeBreaks).values({
				entryId: entry.id,
				kind,
				paid: breakIsPaid(policy.breakRules.rules, kind),
				startAt: effectiveAt,
				endAt: clockOutAt,
				startPunchId: request.id,
				createdAt: now,
			})
		} else {
			await tx
				.update(timeBreaks)
				.set({ endAt: effectiveAt, endPunchId: request.id })
				.where(eq(timeBreaks.id, running!.id))
		}
		const breaks = (await loadBreaks(tx, [entry.id])).get(entry.id) ?? []
		const issues = issuesForEntry(
			{ ...entry, clockOutAt },
			breaks,
			policy,
			input.flags,
		)
		await tx
			.update(timeEntries)
			.set({
				clockOutAt,
				status: statusAfterClose(issues),
				issues,
				// Changed since a manager looked at it.
				reviewedBy: null,
				reviewedAt: null,
				version: entry.version + 1,
				updatedAt: now,
			})
			.where(eq(timeEntries.id, entry.id))
		await refreshStaffCaches(
			tx,
			entry.staffId,
			{ clockInAt: entry.clockInAt },
			now,
		)
	}
	const [settled] = await tx
		.select()
		.from(timeEntries)
		.where(eq(timeEntries.id, entry.id))
		.limit(1)
	const breaksAfter = (await loadBreaks(tx, [entry.id])).get(entry.id) ?? []
	await tx.insert(timeEntryEdits).values({
		entryId: entry.id,
		staffId: entry.staffId,
		scopeId: entry.scopeId,
		editorId: input.deviceId,
		via: input.source,
		action: 'late_punch',
		reason:
			'A punch saved while the time clock was offline arrived after the automatic clock-out.',
		before: snapshotCard(entry, card.breaks),
		after: snapshotCard(settled ?? entry, breaksAfter),
		hoursDeltaMinutes:
			settled?.paidMinutes != null && entry.paidMinutes != null
				? settled.paidMinutes - entry.paidMinutes
				: null,
		createdAt: now,
	})
}

/** Carries punch-derived flags onto an open entry and bumps its version. */
async function touchEntry(
	tx: StaffDb,
	entry: TimeEntry,
	now: number,
	flags: readonly string[],
) {
	const merged = [...new Set([...persistedPunchFlags(entry.issues), ...flags])]
	await tx
		.update(timeEntries)
		.set({ issues: merged, version: entry.version + 1, updatedAt: now })
		.where(eq(timeEntries.id, entry.id))
}

async function closeEntry(
	tx: StaffDb,
	input: {
		entry: TimeEntry
		openBreakId: string | null
		effectiveAt: number
		now: number
		policy: LaborPolicyView
		flags: string[]
		request: KioskPunchRequest
		deps: PunchDeps
		timeZone: string
		source: PunchSource
		/** The card was closed and may have been looked at: it needs a fresh look. */
		reopenReview?: boolean
	},
) {
	const { entry, effectiveAt, now, policy, request } = input

	if (input.openBreakId) {
		await tx
			.update(timeBreaks)
			.set({ endAt: effectiveAt, endPunchId: request.id })
			.where(eq(timeBreaks.id, input.openBreakId))
	}

	const shift = entry.shiftId
		? await input.deps.matchShift(tx, {
				staffId: entry.staffId,
				scopeId: entry.scopeId,
				atMs: entry.clockInAt,
				timeZone: input.timeZone,
			})
		: undefined
	const matched = shift && shift.id === entry.shiftId ? shift : undefined
	input.flags.push(
		...decideClockOut({ policy, atMs: effectiveAt, shift: matched }),
	)

	const closedShape = {
		...entry,
		clockOutAt: effectiveAt,
	}
	const breaks = await loadBreaks(tx, [entry.id])
	const issues = issuesForEntry(
		closedShape,
		breaks.get(entry.id) ?? [],
		policy,
		input.flags,
	)

	await tx
		.update(timeEntries)
		.set({
			clockOutAt: effectiveAt,
			clockOutKind: input.source,
			status: statusAfterClose(issues),
			issues,
			cashTipsMinor: request.cashTipsMinor ?? entry.cashTipsMinor,
			...(input.reopenReview ? { reviewedBy: null, reviewedAt: null } : {}),
			version: entry.version + 1,
			updatedAt: now,
		})
		.where(eq(timeEntries.id, entry.id))

	await refreshStaffCaches(
		tx,
		entry.staffId,
		{ clockInAt: entry.clockInAt },
		now,
	)
}
