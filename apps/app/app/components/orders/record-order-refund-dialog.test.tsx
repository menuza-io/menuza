// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { RecordOrderRefundDialog } from './record-order-refund-dialog.tsx'

const ORDER = {
	id: 'ord_1',
	currency: 'usd',
	totalCents: 2000,
	refundedCents: 500,
}

function setup(
	onSubmit: (body: unknown, key: string) => Promise<void> = async () => {},
	order = ORDER,
) {
	const submit = vi.fn(onSubmit)
	const onRecorded = vi.fn()
	const onOpenChange = vi.fn()
	const onStale = vi.fn()
	const view = renderStaff(
		<RecordOrderRefundDialog
			order={order}
			open
			onOpenChange={onOpenChange}
			onSubmit={submit}
			onRecorded={onRecorded}
			onStale={onStale}
		/>,
	)
	return { submit, onRecorded, onOpenChange, onStale, view }
}

async function recordPartial(amount = '4.50') {
	await userEvent.click(screen.getByRole('combobox', { name: 'Refund' }))
	await userEvent.click(
		await screen.findByRole('option', { name: 'Part of the payment' }),
	)
	await userEvent.type(screen.getByTestId('order-refund-amount'), amount)
	await userEvent.type(screen.getByTestId('order-refund-note'), 'Cold fries')
	await userEvent.click(screen.getByTestId('order-refund-submit'))
}

function keyOf(call: number, submit: ReturnType<typeof vi.fn>) {
	return submit.mock.calls[call]?.[1] as string
}

describe('RecordOrderRefundDialog', () => {
	it('derives the key from the order, the refunded total and the content', async () => {
		const first = setup()
		await recordPartial()
		await waitFor(() => expect(first.onRecorded).toHaveBeenCalled())
		const key = keyOf(0, first.submit)
		expect(key).toMatch(/^order-refund-/)
		expect(first.submit.mock.calls[0]?.[0]).toEqual({
			amountCents: 450,
			note: 'Cold fries',
		})
		first.view.unmount()

		// Closed and reopened without the order reloading: the same refund
		// replays the first attempt instead of recording it twice.
		const second = setup()
		await recordPartial()
		await waitFor(() => expect(second.onRecorded).toHaveBeenCalled())
		expect(keyOf(0, second.submit)).toBe(key)
		second.view.unmount()

		// The refund landed and the order reloaded: a new refund gets a new key.
		const third = setup(async () => {}, { ...ORDER, refundedCents: 950 })
		await recordPartial()
		await waitFor(() => expect(third.onRecorded).toHaveBeenCalled())
		expect(keyOf(0, third.submit)).not.toBe(key)
	})

	it('reloads the order when it is already fully refunded', async () => {
		const { onStale, onRecorded } = setup(async () => {
			throw new OperatorRequestError(
				'Already refunded',
				'refund_complete',
				409,
				{ error: 'refund_complete' },
			)
		})
		await recordPartial()
		expect(await screen.findByTestId('order-refund-error')).toHaveTextContent(
			'This order is already fully refunded.',
		)
		expect(onStale).toHaveBeenCalledTimes(1)
		expect(onRecorded).not.toHaveBeenCalled()
	})

	it('reloads the order when the refund was recorded with other details', async () => {
		const { onStale } = setup(async () => {
			throw new OperatorRequestError('Conflict', 'idempotency_conflict', 409, {
				error: 'idempotency_conflict',
			})
		})
		await recordPartial()
		expect(await screen.findByTestId('order-refund-error')).toHaveTextContent(
			'This refund was already recorded with other details. The amounts above are now up to date.',
		)
		expect(onStale).toHaveBeenCalledTimes(1)
	})

	it('does not reload for an error that leaves the order as it was', async () => {
		const { onStale } = setup(async () => {
			throw new TypeError('Failed to fetch')
		})
		await recordPartial()
		expect(await screen.findByTestId('order-refund-error')).toBeVisible()
		expect(onStale).not.toHaveBeenCalled()
	})

	it('reads the amount in the currency exponent', async () => {
		const kwd = setup(async () => {}, { ...ORDER, currency: 'KWD' })
		expect(screen.getByTestId('order-refund-left')).toHaveTextContent(
			'KWD 1.500',
		)
		await recordPartial('1.234')
		await waitFor(() => expect(kwd.onRecorded).toHaveBeenCalled())
		expect(kwd.submit.mock.calls[0]?.[0]).toEqual({
			amountCents: 1234,
			note: 'Cold fries',
		})
		kwd.view.unmount()

		const jpy = setup(async () => {}, { ...ORDER, currency: 'JPY' })
		await recordPartial('450')
		await waitFor(() => expect(jpy.onRecorded).toHaveBeenCalled())
		expect(jpy.submit.mock.calls[0]?.[0]).toEqual({
			amountCents: 450,
			note: 'Cold fries',
		})
	})

	it('cannot be closed while a submit is in flight', async () => {
		let release!: () => void
		const { onOpenChange } = setup(
			() => new Promise<void>((resolve) => (release = resolve)),
		)
		await recordPartial()
		expect(screen.getByTestId('order-refund-submit')).toBeDisabled()

		await userEvent.keyboard('{Escape}')
		expect(onOpenChange).not.toHaveBeenCalled()

		release()
		await waitFor(() =>
			expect(screen.getByTestId('order-refund-submit')).toBeEnabled(),
		)
	})
})
