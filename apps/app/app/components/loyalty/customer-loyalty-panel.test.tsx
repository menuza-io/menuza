// @vitest-environment jsdom
import { type LoyaltyMemberSummary } from '@repo/loyalty'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
	type LoyaltyClient,
	type LoyaltyMemberDetail,
} from '#app/utils/loyalty/loyalty-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	CustomerLoyaltyPanel,
	CustomerLoyaltyPanelView,
} from './customer-loyalty-panel.tsx'

function member(
	id: string,
	name: string,
	over: Partial<LoyaltyMemberSummary> = {},
): LoyaltyMemberSummary {
	return {
		id,
		customerId: `cus_${id}`,
		name,
		phoneLast4: '0001',
		status: 'active',
		createdAt: 1_700_000_000_000,
		balance: {
			points: 40,
			reserved: 5,
			available: 35,
			lifetimeEarned: 40,
			lifetimeRedeemed: 0,
		},
		lastPurchaseAt: null,
		...over,
	}
}

const ADA = member('mem_a', 'Ada Lovelace')
const BEA = member('mem_b', 'Bea Turing')

function detailOf(
	summary: LoyaltyMemberSummary,
	over: Partial<LoyaltyMemberDetail> = {},
): LoyaltyMemberDetail {
	return {
		member: summary,
		entries: [],
		purchases: [],
		redemptions: [],
		filteredByLocation: false,
		...over,
	}
}

const QR_PURCHASE = {
	id: 'pur_1',
	memberId: 'mem_a',
	channel: 'qr',
	sourceType: 'qr_tab',
	sourceId: 'tab_1',
	locationId: null,
	currency: 'USD',
	occurredAt: 1_700_000_000_000,
	state: 'completed',
	reviewReason: null,
	excludedReason: null,
	skipReason: null,
	programVersion: 1,
	eligibleMinor: 2000,
	totalPaidMinor: 2000,
	awardedPoints: 20,
	reversedPoints: 0,
	refundedMinor: 0,
} as const

function view(
	client: Partial<LoyaltyClient>,
	flags: { canAdjust?: boolean; canRecordRefund?: boolean } = {},
) {
	return renderStaff(
		<CustomerLoyaltyPanelView
			client={client as LoyaltyClient}
			customerId="cus_mem_a"
			canAdjust={flags.canAdjust ?? false}
			canRecordRefund={flags.canRecordRefund ?? false}
		/>,
	)
}

describe('CustomerLoyaltyPanel', () => {
	it('shows nothing when Loyalty is off or the user cannot read it', () => {
		const off = { enabled: false, canRead: false, canAdjust: false }
		renderStaff(
			<CustomerLoyaltyPanel
				orgSlug="acme"
				customerId="cus_1"
				capabilities={{ ...off, canReconcile: false }}
			/>,
		)
		expect(screen.queryByTestId('customer-loyalty')).toBeNull()
		renderStaff(
			<CustomerLoyaltyPanel
				orgSlug="acme"
				customerId="cus_1"
				capabilities={{ ...off, enabled: true, canReconcile: false }}
			/>,
		)
		expect(screen.queryByTestId('customer-loyalty')).toBeNull()
	})

	it('explains calmly that the account opens on sign-in when there is none', async () => {
		const getMember = vi.fn()
		view({ getCustomerMember: vi.fn(async () => null), getMember })
		expect(
			await screen.findByTestId('customer-loyalty-none'),
		).toHaveTextContent(
			'No points account yet. It is opened automatically when the customer signs in on the website or the app.',
		)
		expect(getMember).not.toHaveBeenCalled()
		expect(screen.queryByTestId('customer-loyalty-adjust-open')).toBeNull()
	})

	it('shows balance, status and history, and hides actions without grants', async () => {
		view({
			getCustomerMember: vi.fn(async () => ADA),
			getMember: vi.fn(async () =>
				detailOf(ADA, {
					entries: [
						{
							id: 'led_1',
							at: 1_700_000_000_000,
							memberId: ADA.id,
							customerId: ADA.customerId,
							type: 'earn',
							delta: 20,
							channel: 'web',
							locationId: null,
							purchaseId: null,
							redemptionId: null,
							reason: null,
							note: null,
							actorKind: 'system',
							actorId: null,
						},
					],
					purchases: [QR_PURCHASE],
				}),
			),
		})
		const balance = await screen.findByTestId('customer-loyalty-balance')
		expect(balance).toHaveTextContent('35')
		expect(balance).toHaveTextContent('Reserved')
		expect(screen.getByTestId('customer-loyalty-status')).toHaveTextContent(
			'Active',
		)
		expect(screen.getByTestId('customer-loyalty-entries')).toHaveTextContent(
			'Earned',
		)
		expect(screen.queryByTestId('customer-loyalty-adjust-open')).toBeNull()
		expect(screen.queryByTestId('customer-loyalty-suspend')).toBeNull()
		expect(screen.queryByTestId('loyalty-purchase-refund-open')).toBeNull()
	})

	it('suspends and reactivates the account with the points grant', async () => {
		const suspended = member('mem_a', 'Ada Lovelace', { status: 'suspended' })
		const getMember = vi
			.fn<LoyaltyClient['getMember']>()
			.mockResolvedValueOnce(detailOf(ADA))
			.mockResolvedValue(detailOf(suspended))
		const setMemberStatus = vi.fn(async () => suspended)
		view(
			{ getCustomerMember: vi.fn(async () => ADA), getMember, setMemberStatus },
			{ canAdjust: true },
		)

		await userEvent.click(await screen.findByTestId('customer-loyalty-suspend'))

		expect(setMemberStatus).toHaveBeenCalledWith(
			'mem_a',
			{ status: 'suspended' },
			expect.stringMatching(/^lty-member-status-/),
		)
		expect(
			await screen.findByTestId('customer-loyalty-reactivate'),
		).toBeVisible()
		expect(screen.getByTestId('customer-loyalty-status')).toHaveTextContent(
			'Suspended',
		)
	})

	it('offers Record refund on a QR tab with the redemption grant', async () => {
		view(
			{
				getCustomerMember: vi.fn(async () => ADA),
				getMember: vi.fn(async () =>
					detailOf(ADA, { purchases: [QR_PURCHASE] }),
				),
			},
			{ canRecordRefund: true },
		)
		await userEvent.click(
			await screen.findByTestId('loyalty-purchase-refund-open'),
		)
		expect(await screen.findByTestId('loyalty-refund-submit')).toBeVisible()
	})

	it('never shows a slow answer for the customer shown before', async () => {
		let answerAda!: (summary: LoyaltyMemberSummary | null) => void
		const getCustomerMember = vi.fn(
			(customerId: string, _signal?: AbortSignal) => {
				if (customerId === 'cus_mem_a') {
					// Ignores the abort, like a response already on its way.
					return new Promise<LoyaltyMemberSummary | null>(
						(resolve) => (answerAda = resolve),
					)
				}
				return Promise.resolve(BEA)
			},
		)
		const getMember = vi.fn(async (id: string) =>
			detailOf(id === BEA.id ? BEA : ADA),
		)
		function Harness() {
			const [customerId, setCustomerId] = useState('cus_mem_a')
			return (
				<>
					<button type="button" onClick={() => setCustomerId('cus_mem_b')}>
						next
					</button>
					<CustomerLoyaltyPanelView
						client={
							{ getCustomerMember, getMember } as unknown as LoyaltyClient
						}
						customerId={customerId}
						canAdjust={false}
						canRecordRefund={false}
					/>
				</>
			)
		}
		renderStaff(<Harness />)

		expect(await screen.findByTestId('customer-loyalty-loading')).toBeVisible()
		await userEvent.click(screen.getByRole('button', { name: 'next' }))
		await waitFor(() =>
			expect(screen.getByTestId('customer-loyalty-balance')).toBeVisible(),
		)

		answerAda(ADA)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(screen.getByTestId('customer-loyalty-balance')).toBeVisible()
		expect(getMember).toHaveBeenCalledTimes(1)
		expect(getMember).toHaveBeenCalledWith('mem_b', expect.anything())
		// The request for the customer shown first was cancelled.
		expect(getCustomerMember.mock.calls[0]?.[1]?.aborted).toBe(true)
	})
})
