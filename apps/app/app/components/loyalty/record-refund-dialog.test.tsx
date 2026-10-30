// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
	LoyaltyApiError,
	type LoyaltyClient,
	type LoyaltyRefundResult,
} from '#app/utils/loyalty/loyalty-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	type LoyaltyRefundAmounts,
	RecordRefundDialog,
	useRefundResultMessage,
} from './record-refund-dialog.tsx'

const RESULT: LoyaltyRefundResult = {
	refundId: 'rfd_1',
	purchaseId: 'pur_1',
	refundedMinor: 450,
	cumulativeRefundedMinor: 450,
	pointsReversed: 4,
	fullRefund: false,
	rewardRestored: false,
}

function setup(
	recordRefund: LoyaltyClient['recordRefund'],
	amounts: LoyaltyRefundAmounts = {
		currency: 'usd',
		paidMinor: 2000,
		refundedMinor: 500,
	},
) {
	const client = { recordRefund: vi.fn(recordRefund) }
	const onRecorded = vi.fn()
	const onOpenChange = vi.fn()
	const view = renderStaff(
		<RecordRefundDialog
			client={client as unknown as LoyaltyClient}
			source={{ type: 'qr_tab', id: 'tab_1' }}
			amounts={amounts}
			open
			onOpenChange={onOpenChange}
			onRecorded={onRecorded}
		/>,
	)
	return { client, onRecorded, onOpenChange, view }
}

async function writeNote(text: string) {
	await userEvent.type(screen.getByTestId('loyalty-refund-note'), text)
}

describe('RecordRefundDialog', () => {
	it('shows what was paid and records everything that is left', async () => {
		const { client, onRecorded } = setup(async () => ({
			...RESULT,
			fullRefund: true,
			rewardRestored: true,
		}))
		expect(screen.getByTestId('loyalty-refund-paid')).toHaveTextContent(
			'$20.00',
		)
		await writeNote('Refunded in the payment dashboard')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))

		await waitFor(() => expect(onRecorded).toHaveBeenCalled())
		expect(client.recordRefund).toHaveBeenCalledWith(
			{
				source: { type: 'qr_tab', id: 'tab_1' },
				full: true,
				note: 'Refunded in the payment dashboard',
			},
			expect.stringMatching(/^lty-refund-/),
		)
		expect(onRecorded.mock.calls[0]?.[0]).toMatchObject({
			rewardRestored: true,
		})
	})

	it('records part of the payment in minor units', async () => {
		const { client, onRecorded } = setup(async () => RESULT)
		await userEvent.click(screen.getByRole('combobox', { name: 'Refund' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Part of the payment' }),
		)
		await userEvent.type(screen.getByTestId('loyalty-refund-amount'), '4.50')
		await writeNote('Cold fries')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))

		await waitFor(() => expect(onRecorded).toHaveBeenCalled())
		expect(client.recordRefund).toHaveBeenCalledWith(
			{
				source: { type: 'qr_tab', id: 'tab_1' },
				amountMinor: 450,
				note: 'Cold fries',
			},
			expect.any(String),
		)
	})

	it('refuses more than what is left without calling the region', async () => {
		const { client } = setup(async () => RESULT)
		await userEvent.click(screen.getByRole('combobox', { name: 'Refund' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Part of the payment' }),
		)
		await userEvent.type(screen.getByTestId('loyalty-refund-amount'), '15.01')
		await writeNote('Too much')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))

		expect(
			await screen.findByText('That is more than what is left to refund.'),
		).toBeInTheDocument()
		expect(client.recordRefund).not.toHaveBeenCalled()
	})

	it('explains a sale without loyalty activity', async () => {
		setup(async () => {
			throw new LoyaltyApiError('purchase_not_found', 404, 'purchase_not_found')
		})
		await writeNote('Refunded')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))

		expect(await screen.findByTestId('loyalty-refund-error')).toHaveTextContent(
			'No loyalty points or rewards are linked to this sale',
		)
	})

	it('replays the same key after the dialog remounts, until the refund lands', async () => {
		const first = setup(async () => RESULT)
		await writeNote('Refunded in the payment dashboard')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))
		await waitFor(() => expect(first.onRecorded).toHaveBeenCalled())
		const key = first.client.recordRefund.mock.calls[0]?.[1] as string
		expect(key).toMatch(/^lty-refund-/)
		first.view.unmount()

		// Reopened without fresh amounts: the same refund replays.
		const second = setup(async () => RESULT)
		await writeNote('Refunded in the payment dashboard')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))
		await waitFor(() => expect(second.onRecorded).toHaveBeenCalled())
		expect(second.client.recordRefund.mock.calls[0]?.[1]).toBe(key)
		second.view.unmount()

		// The refund landed and the amounts reloaded: the next one is new.
		const third = setup(async () => RESULT, {
			currency: 'usd',
			paidMinor: 2000,
			refundedMinor: 950,
		})
		await writeNote('Refunded in the payment dashboard')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))
		await waitFor(() => expect(third.onRecorded).toHaveBeenCalled())
		expect(third.client.recordRefund.mock.calls[0]?.[1]).not.toBe(key)
	})

	it('cannot be closed while a submit is in flight', async () => {
		let release!: (result: LoyaltyRefundResult) => void
		const { onOpenChange } = setup(
			() => new Promise<LoyaltyRefundResult>((resolve) => (release = resolve)),
		)
		await writeNote('Refunded in the payment dashboard')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))
		expect(screen.getByTestId('loyalty-refund-submit')).toBeDisabled()

		await userEvent.keyboard('{Escape}')
		expect(onOpenChange).not.toHaveBeenCalled()

		release(RESULT)
		await waitFor(() =>
			expect(screen.getByTestId('loyalty-refund-submit')).toBeEnabled(),
		)
	})

	it('names the most that can still be refunded', async () => {
		setup(
			async () => {
				throw new LoyaltyApiError(
					'refund_exceeds_payment',
					409,
					'refund_exceeds_payment',
					{ code: 'refund_exceeds_payment', refundableMinor: 1250 },
				)
			},
			{ currency: 'usd', paidMinor: null, refundedMinor: 0 },
		)
		await writeNote('Refunded twice?')
		await userEvent.click(screen.getByTestId('loyalty-refund-submit'))

		expect(await screen.findByTestId('loyalty-refund-error')).toHaveTextContent(
			'At most $12.50 can still be refunded.',
		)
	})
})

describe('useRefundResultMessage', () => {
	function Probe({ result }: { result: LoyaltyRefundResult }) {
		const describe = useRefundResultMessage()
		return <p data-testid="probe">{describe(result)}</p>
	}

	it('says how many points came back and whether the reward did', () => {
		renderStaff(<Probe result={{ ...RESULT, rewardRestored: true }} />)
		expect(screen.getByTestId('probe')).toHaveTextContent(
			"Refund recorded. Points taken back: 4. The reward's points were returned to the customer.",
		)
	})

	it('says when nothing had to be taken back', () => {
		renderStaff(<Probe result={{ ...RESULT, pointsReversed: 0 }} />)
		expect(screen.getByTestId('probe')).toHaveTextContent(
			'Refund recorded. No points needed to be taken back.',
		)
	})
})
