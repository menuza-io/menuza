import { type RecordBatch, type UnitRef } from '@repo/inventory'

/** What is typed in "Record a batch": a number of recipe batches, or the amount that came out. */
export type BatchDraft = {
	kind: 'batches' | 'amount'
	count: number | null
	amount: number | null
	unit: UnitRef | null
	note: string
}

export type BatchProblem = 'count' | 'amount' | 'unit'

export function emptyBatchDraft(): BatchDraft {
	return { kind: 'batches', count: 1, amount: null, unit: null, note: '' }
}

export function batchProblems(draft: BatchDraft): BatchProblem[] {
	if (draft.kind === 'batches') {
		return draft.count !== null && draft.count > 0 && draft.count <= 1000
			? []
			: ['count']
	}
	const problems: BatchProblem[] = []
	if (draft.amount === null || !(draft.amount > 0)) problems.push('amount')
	if (draft.unit === null) problems.push('unit')
	return problems
}

/** The `POST /items/:id/batch` body, or null while the draft has problems. */
export function buildBatch(
	draft: BatchDraft,
	input: { clientId: string; locationId: string },
): RecordBatch | null {
	if (batchProblems(draft).length > 0) return null
	const note = draft.note.trim()
	return {
		clientId: input.clientId,
		locationId: input.locationId,
		made:
			draft.kind === 'batches'
				? { kind: 'batches', count: draft.count! }
				: { kind: 'amount', amount: draft.amount!, unit: draft.unit! },
		...(note ? { note } : {}),
	}
}
