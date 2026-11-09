import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type StockItem,
	type TransferDetail,
	type TransferLineInput,
	type TransferStatus,
	type TransferSummary,
	type UnitRef,
	MAX_TRANSFER_LINES,
} from '@repo/inventory'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { inventorySaveErrorMessage } from './inventory-errors.ts'

/** What is typed for one line of a new transfer or request. */
export type TransferLineDraft = {
	key: string
	item: Pick<
		StockItem,
		'id' | 'name' | 'baseUnit' | 'units' | 'countUnit'
	> | null
	amount: number | null
	unit: UnitRef | null
}

export type TransferDraft = {
	/** The other place: where stock comes from (a request) or goes to (a transfer). */
	otherLocationId: string
	lines: TransferLineDraft[]
	note: string
}

let lineCounter = 0
export function emptyTransferLine(): TransferLineDraft {
	lineCounter += 1
	return { key: `line-${lineCounter}`, item: null, amount: null, unit: null }
}

export function emptyTransferDraft(): TransferDraft {
	return { otherLocationId: '', lines: [emptyTransferLine()], note: '' }
}

export type TransferProblem =
	'place' | 'no_lines' | 'partial_line' | 'duplicate_item' | 'too_many'

const blank = (line: TransferLineDraft) =>
	line.item === null && (line.amount === null || line.amount === 0)

/** Why the draft cannot be sent to the region yet (empty when it can). */
export function transferProblems(draft: TransferDraft): TransferProblem[] {
	const problems: TransferProblem[] = []
	if (draft.otherLocationId === '') problems.push('place')
	const used = draft.lines.filter((line) => !blank(line))
	if (used.length === 0) problems.push('no_lines')
	if (used.length > MAX_TRANSFER_LINES) problems.push('too_many')
	if (
		used.some(
			(line) =>
				line.item === null ||
				line.unit === null ||
				line.amount === null ||
				!(line.amount > 0),
		)
	) {
		problems.push('partial_line')
	}
	const ids = used.flatMap((line) => (line.item ? [line.item.id] : []))
	if (new Set(ids).size !== ids.length) problems.push('duplicate_item')
	return problems
}

/** The `lines` of a create body, or null while the draft has problems. */
export function buildTransferLines(
	draft: TransferDraft,
): TransferLineInput[] | null {
	if (transferProblems(draft).length > 0) return null
	return draft.lines
		.filter((line) => !blank(line))
		.map((line) => ({
			itemId: line.item!.id,
			amount: line.amount!,
			unit: line.unit!,
		}))
}

/**
 * What a person may do with a transfer at the place they are looking at.
 * The sender sends (and, for a transfer it made, cancels); the receiver
 * receives (and, for a request it made, cancels). Anyone else only reads.
 */
export type TransferActions = {
	send: boolean
	receive: boolean
	cancel: boolean
}

export function transferActions(
	transfer: Pick<
		TransferSummary,
		'kind' | 'status' | 'fromLocationId' | 'toLocationId'
	>,
	locationId: string,
): TransferActions {
	const open = transfer.status === 'requested' || transfer.status === 'draft'
	const creator =
		transfer.kind === 'request'
			? transfer.toLocationId
			: transfer.fromLocationId
	return {
		send: open && transfer.fromLocationId === locationId,
		receive: transfer.status === 'sent' && transfer.toLocationId === locationId,
		cancel: open && creator === locationId,
	}
}

export function transferStatusLabel(status: TransferStatus): MessageDescriptor {
	switch (status) {
		case 'requested':
			return msg`Requested`
		case 'draft':
			return msg`Ready to send`
		case 'sent':
			return msg`On the way`
		case 'received':
			return msg`Received`
		case 'cancelled':
			return msg`Cancelled`
	}
}

/** The amounts to confirm when sending or receiving: what was asked for, or what was sent. */
export function confirmStartQuantity(
	line: TransferDetail['lines'][number],
	step: 'send' | 'receive',
): number {
	return step === 'send'
		? line.requestedQuantity
		: (line.sentQuantity ?? line.requestedQuantity)
}

/** One owner-language sentence for a failed transfer call. */
export function transferErrorMessage(error: unknown): MessageDescriptor {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'transfer_closed') {
			return msg`This transfer was already finished or cancelled. Close it and open it again.`
		}
		if (error.code === 'transfer_same_location') {
			return msg`Pick a different place: stock cannot move to the same place.`
		}
		if (error.code === 'nothing_sent') {
			return msg`Enter an amount above zero for at least one item.`
		}
		if (error.code === 'over_received') {
			return msg`More arrived than was sent. Check the amounts.`
		}
		if (error.code === 'feature_disabled') {
			return msg`Transfers are not turned on for your business.`
		}
	}
	return inventorySaveErrorMessage(error)
}
