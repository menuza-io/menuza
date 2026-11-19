// @vitest-environment jsdom
import { type LoyaltyEarningRule, type LoyaltyTiersConfig } from '@repo/loyalty'
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { RewardReturnPreview } from './reward-return-preview.tsx'

const SPEND_1_PER_100: LoyaltyEarningRule = {
	method: 'spend',
	points: 1,
	perMinor: 100, // 1 pt per $1.00
}

describe('RewardReturnPreview (#414)', () => {
	it('calculates effective percent back live for fixed order discounts', () => {
		renderStaff(
			<RewardReturnPreview
				earning={SPEND_1_PER_100}
				reward={{
					kind: 'order',
					pointsCost: 100,
					discount: { type: 'fixed', amountMinor: 500 },
				}}
				currency="USD"
			/>,
		)
		expect(
			screen.getByTestId('loyalty-reward-return-badge').textContent,
		).toContain('5%')
		expect(
			screen.getByTestId('loyalty-reward-return-summary').textContent,
		).toContain('$100.00')
		expect(
			screen.getByTestId('loyalty-reward-return-summary').textContent,
		).toContain('$5.00')
		expect(screen.queryByTestId('loyalty-reward-return-warning')).toBeNull()
	})

	it('warns when effective return exceeds 20%', () => {
		renderStaff(
			<RewardReturnPreview
				earning={SPEND_1_PER_100}
				reward={{
					kind: 'order',
					pointsCost: 20,
					discount: { type: 'fixed', amountMinor: 500 }, // $20 -> $5 = 25%
				}}
				currency="USD"
			/>,
		)
		expect(
			screen.getByTestId('loyalty-reward-return-badge').textContent,
		).toContain('25%')
		expect(screen.getByTestId('loyalty-reward-return-warning')).toBeTruthy()
	})

	it('calculates free-item return from menu item price and shows top tier rate', () => {
		const tiers: LoyaltyTiersConfig = {
			enabled: true,
			metric: 'qualifying_points',
			periodMonths: 12,
			graceDays: 30,
			tiers: [
				{ id: 'gold', name: 'Gold', threshold: 500, multiplierBp: 15_000 },
			],
		}
		renderStaff(
			<RewardReturnPreview
				earning={SPEND_1_PER_100}
				reward={{
					kind: 'free_item',
					pointsCost: 50,
				}}
				currency="USD"
				itemPriceMinor={500}
				tiers={tiers}
			/>,
		)
		// Spend $50 -> $5.00 = 10%, Gold 1.5x -> 15%
		expect(
			screen.getByTestId('loyalty-reward-return-badge').textContent,
		).toContain('10%')
		expect(
			screen.getByTestId('loyalty-reward-return-tier').textContent,
		).toContain('Gold')
		expect(
			screen.getByTestId('loyalty-reward-return-tier').textContent,
		).toContain('15%')
	})

	it('asks for sample order total on visit earning and updates when typed', async () => {
		const user = userEvent.setup()
		function Wrapper() {
			const [avg, setAvg] = useState<number | null>(null)
			return (
				<RewardReturnPreview
					earning={{ method: 'visit', points: 10 }}
					reward={{
						kind: 'order',
						pointsCost: 50,
						discount: { type: 'fixed', amountMinor: 500 },
					}}
					currency="USD"
					averageOrderMinor={avg}
					onAverageOrderChange={setAvg}
				/>
			)
		}
		renderStaff(<Wrapper />)
		const input = screen.getByTestId('loyalty-preview-average-order')
		await user.type(input, '20.00')
		// 5 visits * $20 = $100 -> $5 off = 5%
		expect(
			screen.getByTestId('loyalty-reward-return-badge').textContent,
		).toContain('5%')
	})
})
