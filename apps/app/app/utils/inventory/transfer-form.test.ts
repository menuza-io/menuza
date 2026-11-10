import { describe, expect, it } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	buildTransferLines,
	confirmStartQuantity,
	emptyTransferDraft,
	emptyTransferLine,
	transferActions,
	transferErrorMessage,
	transferProblems,
	type TransferDraft,
} from './transfer-form.ts'

const item = (id: string) => ({
	id,
	name: id,
	baseUnit: 'g' as const,
	units: [],
	countUnit: 'kg' as const,
})

const draft = (over: Partial<TransferDraft> = {}): TransferDraft => ({
	otherLocationId: 'loc_b',
	lines: [{ ...emptyTransferLine(), item: item('i1'), amount: 2, unit: 'kg' }],
	note: '',
	...over,
})

describe('transferProblems', () => {
	it('needs a place and at least one complete line', () => {
		expect(transferProblems(emptyTransferDraft())).toEqual([
			'place',
			'no_lines',
		])
		expect(transferProblems(draft())).toEqual([])
	})

	it('flags half-filled lines and an item used twice, and ignores empty rows', () => {
		const half = draft({
			lines: [
				{ ...emptyTransferLine(), item: item('i1'), amount: null, unit: 'kg' },
			],
		})
		expect(transferProblems(half)).toContain('partial_line')
		const twice = draft({
			lines: [
				{ ...emptyTransferLine(), item: item('i1'), amount: 1, unit: 'kg' },
				{ ...emptyTransferLine(), item: item('i1'), amount: 2, unit: 'kg' },
			],
		})
		expect(transferProblems(twice)).toContain('duplicate_item')
		const blankRow = draft({
			lines: [...draft().lines, emptyTransferLine()],
		})
		expect(transferProblems(blankRow)).toEqual([])
	})
})

describe('buildTransferLines', () => {
	it('keeps only filled rows, as the region reads them', () => {
		const lines = buildTransferLines(
			draft({ lines: [...draft().lines, emptyTransferLine()] }),
		)
		expect(lines).toEqual([{ itemId: 'i1', amount: 2, unit: 'kg' }])
	})

	it('is null while there are problems', () => {
		expect(buildTransferLines(emptyTransferDraft())).toBeNull()
	})
})

describe('transferActions', () => {
	const base = {
		kind: 'request' as const,
		status: 'requested' as const,
		fromLocationId: 'kitchen',
		toLocationId: 'branch',
	}

	it('lets the asked place send, and only the asking place cancel a request', () => {
		expect(transferActions(base, 'kitchen')).toEqual({
			send: true,
			receive: false,
			cancel: false,
		})
		expect(transferActions(base, 'branch')).toEqual({
			send: false,
			receive: false,
			cancel: true,
		})
	})

	it('lets the sender plan, send and cancel a transfer it made', () => {
		const transfer = {
			...base,
			kind: 'transfer' as const,
			status: 'draft' as const,
		}
		expect(transferActions(transfer, 'kitchen')).toEqual({
			send: true,
			receive: false,
			cancel: true,
		})
		expect(transferActions(transfer, 'branch')).toEqual({
			send: false,
			receive: false,
			cancel: false,
		})
	})

	it('lets only the receiver receive what was sent, and nobody change a finished one', () => {
		const sent = { ...base, status: 'sent' as const }
		expect(transferActions(sent, 'branch')).toEqual({
			send: false,
			receive: true,
			cancel: false,
		})
		expect(transferActions(sent, 'kitchen')).toEqual({
			send: false,
			receive: false,
			cancel: false,
		})
		for (const status of ['received', 'cancelled'] as const) {
			for (const place of ['kitchen', 'branch']) {
				expect(transferActions({ ...base, status }, place)).toEqual({
					send: false,
					receive: false,
					cancel: false,
				})
			}
		}
	})
})

describe('confirmStartQuantity', () => {
	const line = { requestedQuantity: 5000, sentQuantity: 4000 } as never
	it('starts a send at what was asked and a receipt at what was sent', () => {
		expect(confirmStartQuantity(line, 'send')).toBe(5000)
		expect(confirmStartQuantity(line, 'receive')).toBe(4000)
	})
})

describe('transferErrorMessage', () => {
	it('names the transfer codes in owner words', () => {
		const message = transferErrorMessage(
			new OperatorRequestError('x', 'transfer_closed', 409),
		)
		expect(message.message).toContain('already finished')
	})
})
