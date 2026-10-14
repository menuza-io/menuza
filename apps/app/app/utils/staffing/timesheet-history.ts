import { type EditLogRow } from './timesheet-types.ts'

/**
 * Turns an edit-log row (a before and after snapshot of the card) into the few
 * fields that actually changed, so the history reads as "Clock-out 5:00 PM to
 * 5:30 PM" and not as a diff. Money keys are simply absent from the snapshots of
 * a reader without the pay grant, so they never show up here either.
 */

export type ChangedField =
	| {
			field: 'clockInAt' | 'clockOutAt'
			before: number | null
			after: number | null
	  }
	| {
			field: 'breaks'
			before: SnapshotBreak[]
			after: SnapshotBreak[]
	  }
	| { field: 'positionId'; before: string | null; after: string | null }
	| {
			field: 'cashTipsMinor' | 'creditTipsMinor'
			before: number | null
			after: number | null
	  }
	| { field: 'managerNote'; before: string | null; after: string | null }

export type SnapshotBreak = {
	kind: string
	startAt: number
	endAt: number | null
}

const NUMBER_FIELDS = [
	'clockInAt',
	'clockOutAt',
	'cashTipsMinor',
	'creditTipsMinor',
] as const

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asText(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null
}

function asBreaks(value: unknown): SnapshotBreak[] {
	if (!Array.isArray(value)) return []
	const out: SnapshotBreak[] = []
	for (const item of value) {
		if (item === null || typeof item !== 'object') continue
		const record = item as Record<string, unknown>
		const startAt = asNumber(record.startAt)
		if (startAt === null) continue
		out.push({
			kind: typeof record.kind === 'string' ? record.kind : 'meal',
			startAt,
			endAt: asNumber(record.endAt),
		})
	}
	return out
}

export function changedFields(
	edit: Pick<EditLogRow, 'action' | 'before' | 'after'>,
): ChangedField[] {
	// Approve, lock, unlock and reopen only move the status, which the action
	// label already says. A new card lists what it was created with.
	if (!['update', 'create'].includes(edit.action)) return []
	const before = edit.before ?? {}
	const after = edit.after ?? {}
	const out: ChangedField[] = []

	for (const field of NUMBER_FIELDS) {
		if (!(field in after) && !(field in before)) continue
		const a = asNumber(before[field])
		const b = asNumber(after[field])
		if (a !== b) out.push({ field, before: a, after: b })
	}
	if ('positionId' in after || 'positionId' in before) {
		const a = asText(before.positionId)
		const b = asText(after.positionId)
		if (a !== b) out.push({ field: 'positionId', before: a, after: b })
	}
	const breaksBefore = asBreaks(before.breaks)
	const breaksAfter = asBreaks(after.breaks)
	if (JSON.stringify(breaksBefore) !== JSON.stringify(breaksAfter)) {
		out.push({ field: 'breaks', before: breaksBefore, after: breaksAfter })
	}
	if ('managerNote' in after || 'managerNote' in before) {
		const a = asText(before.managerNote)
		const b = asText(after.managerNote)
		if (a !== b) out.push({ field: 'managerNote', before: a, after: b })
	}
	return out
}
