import {
	type AdjustmentReason,
	type InventoryBaseUnit,
	MAX_ENTRY_QUANTITY,
	type UnitRef,
} from '@repo/inventory'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { type ItemUnitLike } from './format.ts'
import { wasteBaseQuantity } from './waste-form.ts'

export type AdjustDirection = 'add' | 'remove'

export type AdjustDraft = {
	direction: AdjustDirection
	amountText: string
	unit: UnitRef | null
	reason: AdjustmentReason | null
	note: string
}

export type AdjustProblem = 'amount' | 'unit' | 'reason'

export function adjustDraftProblems(draft: AdjustDraft): AdjustProblem[] {
	const problems: AdjustProblem[] = []
	const amount = parseQuantityText(draft.amountText)
	if (amount === null || amount <= 0) problems.push('amount')
	if (!draft.unit) problems.push('unit')
	if (!draft.reason) problems.push('reason')
	return problems
}

/**
 * The `POST /items/:id/adjust` body for a complete draft: the change is
 * signed (negative to take stock away) and in base thousandths. Null while
 * something is missing or the amount does not fit.
 */
export function buildAdjustPayload(
	draft: AdjustDraft,
	context: {
		clientId: string
		locationId: string
		baseUnit: InventoryBaseUnit
		units: readonly ItemUnitLike[]
	},
): {
	clientId: string
	locationId: string
	quantity: number
	reason: AdjustmentReason
	note?: string
} | null {
	if (adjustDraftProblems(draft).length > 0) return null
	const amount = parseQuantityText(draft.amountText)!
	const base = wasteBaseQuantity(
		amount,
		draft.unit!,
		context.baseUnit,
		context.units,
	)
	if (base === null || base === 0 || base > MAX_ENTRY_QUANTITY) return null
	const note = draft.note.trim()
	return {
		clientId: context.clientId,
		locationId: context.locationId,
		quantity: draft.direction === 'remove' ? -base : base,
		reason: draft.reason!,
		...(note ? { note } : {}),
	}
}
