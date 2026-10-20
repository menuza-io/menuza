import { and, eq, gte, isNull, lte } from 'drizzle-orm'
import {
	computeCachedMinutes,
	computeEntryIssues,
	laborPolicyToRules,
	PUNCH_FLAG_ISSUES,
	type CacheContext,
	type EntryBreak,
	type EntryIssueCode,
	type LaborPolicyView,
	type TimeEntryInput,
} from '@repo/staffing'
import {
	timeBreaks,
	timeEntries,
	type TimeBreakRow,
	type TimeEntry,
} from '@repo/tenant-db'
import { resolvePolicy } from './labor-policy-service.ts'
import { type StaffDb } from './staff-audit.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * Database side of the shared time math. Everything that turns punches into
 * minutes goes through `computeCachedMinutes` and `computeEntryIssues` from
 * `@repo/staffing`, the same functions the timesheets and reports use, so a
 * card shown here can never disagree with an export.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** Entries this far around a changed card are reloaded (overtime is per week). */
const NEIGHBOURHOOD_MS = 21 * DAY_MS

export function entryToInput(
	entry: TimeEntry,
	breaks: readonly TimeBreakRow[],
): TimeEntryInput & { breaks: EntryBreak[] } {
	return {
		id: entry.id,
		scopeId: entry.scopeId,
		clockInAt: entry.clockInAt,
		clockOutAt: entry.clockOutAt,
		breaks: breaks
			.filter((b) => b.voidedAt === null)
			.map((b) => ({
				kind: b.kind,
				startAt: b.startAt,
				endAt: b.endAt,
				paid: b.paid,
			})),
		breakWaived: entry.breakWaived,
		rateMinor: entry.rateMinor,
		currency: entry.currency,
		overtimeExempt: entry.overtimeExempt,
	}
}

export async function loadBreaks(
	db: StaffDb,
	entryIds: readonly string[],
): Promise<Map<string, TimeBreakRow[]>> {
	const map = new Map<string, TimeBreakRow[]>()
	if (entryIds.length === 0) return map
	const rows = await db
		.select()
		.from(timeBreaks)
		.where(inJsonList(timeBreaks.entryId, [...entryIds]))
	for (const row of rows) {
		const list = map.get(row.entryId) ?? []
		list.push(row)
		map.set(row.entryId, list)
	}
	return map
}

/** Issues carried by the punches, which cannot be recomputed from times. */
export function persistedPunchFlags(issues: readonly string[]): string[] {
	return issues.filter((issue) =>
		(PUNCH_FLAG_ISSUES as readonly string[]).includes(issue),
	)
}

/**
 * Recomputes the stored issues of one entry from its times, breaks and policy,
 * keeping the flags that came with the punches. Returns the new issue list.
 */
export function issuesForEntry(
	entry: TimeEntry,
	breaks: readonly TimeBreakRow[],
	policy: LaborPolicyView,
	extraFlags: readonly string[] = [],
	nowMs?: number,
): EntryIssueCode[] {
	return computeEntryIssues({
		entry: entryToInput(entry, breaks),
		rules: laborPolicyToRules(policy),
		breakRules: policy.breakRules.rules,
		timeZone: entry.timeZone,
		nowMs,
		punchFlags: [...persistedPunchFlags(entry.issues), ...extraFlags],
	})
}

/**
 * Refreshes the cached minute totals of every closed entry of one person near
 * `anchor`, because one entry changing can move overtime onto its neighbours in
 * the same week. Only rows whose figures actually changed are written. Open
 * entries are left alone (their minutes are measured when they close).
 */
export async function refreshStaffCaches(
	db: StaffDb,
	staffId: string,
	anchor: { clockInAt: number },
	now: number,
): Promise<void> {
	const rows = await db
		.select()
		.from(timeEntries)
		.where(
			and(
				eq(timeEntries.staffId, staffId),
				isNull(timeEntries.voidedAt),
				gte(timeEntries.clockInAt, anchor.clockInAt - NEIGHBOURHOOD_MS),
				lte(timeEntries.clockInAt, anchor.clockInAt + NEIGHBOURHOOD_MS),
			),
		)
	const closed = rows.filter((row) => row.clockOutAt !== null)
	if (closed.length === 0) return

	const breaks = await loadBreaks(
		db,
		closed.map((row) => row.id),
	)
	const inputs = closed.map((row) =>
		entryToInput(row, breaks.get(row.id) ?? []),
	)

	const contexts = new Map<string, CacheContext>()
	for (const row of closed) {
		if (contexts.has(row.scopeId)) continue
		const policy = await resolvePolicy(db, row.scopeId)
		contexts.set(row.scopeId, {
			rules: laborPolicyToRules(policy),
			timeZone: row.timeZone,
		})
	}

	const minutes = computeCachedMinutes(inputs, (scopeId) =>
		contexts.get(scopeId)!,
	)
	// Only entries whose whole neighbourhood was loaded are final; the edge of
	// the window is recomputed the next time one of its own entries changes.
	const settledFrom = anchor.clockInAt - NEIGHBOURHOOD_MS / 2
	const settledTo = anchor.clockInAt + NEIGHBOURHOOD_MS / 2
	for (const row of closed) {
		if (row.clockInAt < settledFrom || row.clockInAt > settledTo) continue
		// Approved and locked cards are a manager's decision; they are only ever
		// recomputed by an explicit edit or unlock, never as a side effect.
		if (row.status === 'approved' || row.status === 'locked') continue
		const next = minutes.get(row.id)
		if (!next) continue
		if (
			next.regularMinutes === row.regularMinutes &&
			next.overtimeMinutes === row.overtimeMinutes &&
			next.doubleTimeMinutes === row.doubleTimeMinutes &&
			next.holidayMinutes === row.holidayMinutes &&
			next.paidMinutes === row.paidMinutes &&
			next.unpaidBreakMinutes === row.unpaidBreakMinutes
		) {
			continue
		}
		await db
			.update(timeEntries)
			.set({ ...next, updatedAt: now })
			.where(eq(timeEntries.id, row.id))
	}
}
