import {
	type ApproveCountResult,
	type CountReview,
	type CountSummary,
} from '@repo/inventory'

/**
 * The count review as pure rules: which lines need a look (the region already
 * lists only those), how they group, what the person decides for items nobody
 * counted, and the body that approves the count. The region decides what
 * needs review; this module only shapes it for the screen.
 */

export type ReviewLine = CountReview['lines'][number]

/** What to do with an item nobody counted: keep what we expect, or set it to none. */
export type UncountedChoice = 'keep' | 'zero'

export type GroupedReview = {
	/** Items nobody counted. */
	notCounted: ReviewLine[]
	/** Counted far from what was expected: most money at stake first (as the region orders them). */
	bigDifferences: ReviewLine[]
	/** Items that match and need no review. */
	matching: number
}

export function groupReviewLines(review: CountReview): GroupedReview {
	return {
		notCounted: review.lines.filter((line) => line.flag === 'not_counted'),
		bigDifferences: review.lines.filter(
			(line) => line.flag === 'big_difference',
		),
		matching: review.matching,
	}
}

/** Whether a line is short ("missing") or over what was expected. */
export function differenceDirection(
	line: Pick<ReviewLine, 'difference'>,
): 'missing' | 'extra' | 'none' {
	if (line.difference === null || line.difference === 0) return 'none'
	return line.difference < 0 ? 'missing' : 'extra'
}

export type ReviewDecisions = {
	/** Per not-counted item; anything not chosen yet counts as `keep`. */
	uncounted: Readonly<Record<string, UncountedChoice>>
	/** Per big-difference item, as typed. */
	notes: Readonly<Record<string, string>>
}

export function uncountedChoice(
	decisions: Pick<ReviewDecisions, 'uncounted'>,
	itemId: string,
): UncountedChoice {
	return decisions.uncounted[itemId] ?? 'keep'
}

/**
 * The body of `POST /counts/:id/approve`. Every not-counted item carries its
 * choice (so what was approved is explicit), notes are sent only for lines
 * still under review and only when something was typed.
 */
export function buildApprovePayload(
	review: CountReview,
	decisions: ReviewDecisions,
): {
	expectedVersion: number
	uncounted: Record<string, UncountedChoice>
	notes: Record<string, string>
} {
	const grouped = groupReviewLines(review)
	const uncounted: Record<string, UncountedChoice> = {}
	for (const line of grouped.notCounted) {
		uncounted[line.itemId] = uncountedChoice(decisions, line.itemId)
	}
	const notes: Record<string, string> = {}
	for (const line of grouped.bigDifferences) {
		const note = (decisions.notes[line.itemId] ?? '').trim()
		if (note !== '') notes[line.itemId] = note.slice(0, 500)
	}
	return { expectedVersion: review.count.version, uncounted, notes }
}

export type CountAccess = {
	/** `update:inventory:any`, and not impersonating. */
	canEdit: boolean
	/** `read:inventory_cost:any`. */
	canSeeCost: boolean
}

/** Approving posts adjustments in money: it needs both grants. */
export function canApproveCount(access: CountAccess): boolean {
	return access.canEdit && access.canSeeCost
}

export type CountAction =
	'count' | 'finish' | 'review' | 'approve' | 'reopen' | 'cancel'

/**
 * What a person may do with a count in its state. Counting and finishing need
 * to be able to edit; approving also needs the cost grant (without it the
 * count goes "Send for approval": it stays in review for a manager).
 */
export function countActions(
	status: CountSummary['status'],
	access: CountAccess,
): CountAction[] {
	const actions: CountAction[] = []
	if (status === 'counting') {
		if (access.canEdit) actions.push('count', 'finish', 'cancel')
		actions.push('review')
	} else if (status === 'in_review') {
		actions.push('review')
		if (canApproveCount(access)) actions.push('approve')
		if (access.canEdit) actions.push('reopen', 'cancel')
	}
	return actions
}

/** Whether the people who counted are done: the verb on the Finish button. */
export function finishLabelKind(access: CountAccess): 'review' | 'send' {
	return canApproveCount(access) ? 'review' : 'send'
}

/** Approval may go ahead: every grant held and nothing pending. */
export function approveBlockedReason(input: {
	access: CountAccess
	status: CountSummary['status']
	saving: boolean
}): 'permission' | 'state' | 'saving' | null {
	if (!canApproveCount(input.access)) return 'permission'
	if (input.status !== 'in_review') return 'state'
	if (input.saving) return 'saving'
	return null
}

type FoodCost = NonNullable<ApproveCountResult['foodCost']>

export type FoodCostSummary =
	| { kind: 'ready'; bp: number; targetBp: number; overTarget: boolean }
	| { kind: 'need_two_counts' | 'no_sales' }

/** What the completion dialog says about food cost, from the region's state. */
export function summarizeFoodCost(
	foodCost: FoodCost | undefined,
): FoodCostSummary | null {
	if (!foodCost) return null
	if (
		foodCost.state === 'ok' &&
		foodCost.bp !== null &&
		foodCost.bp !== undefined
	) {
		return {
			kind: 'ready',
			bp: foodCost.bp,
			targetBp: foodCost.targetBp,
			overTarget: foodCost.bp > foodCost.targetBp,
		}
	}
	return {
		kind: foodCost.state === 'no_sales' ? 'no_sales' : 'need_two_counts',
	}
}
