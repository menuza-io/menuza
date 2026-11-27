// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { KeptByDirectCard } from './kept-by-direct-card.tsx'

const figures = vi.hoisted(() => ({ list: [] as unknown[], fail: false }))
vi.mock('#app/utils/reports/monthly-client.ts', () => ({
	fetchMonthlyFigures: vi.fn(async () => {
		if (figures.fail) throw new Error('boom')
		return figures.list
	}),
}))

const view = {
	orgSlug: 'acme',
	month: '2026-10',
	timeZone: 'America/Chicago',
	tokenUrl: '/acme/reports/token',
	tenantApiUrl: 'https://tenant.example.test',
	commissionBp: 2500,
}

beforeEach(() => {
	figures.fail = false
	figures.list = [
		{
			id: 'onlineSales',
			format: 'currency',
			entries: [
				{ currency: 'USD', value: 4000 },
				{ currency: 'SAR', value: 800 },
			],
			previous: [],
		},
	]
})

describe('KeptByDirectCard on the billing page (#221)', () => {
	it("shows last month's estimate per currency, labelled with the rate", async () => {
		renderStaff(<KeptByDirectCard view={view} />)
		expect(
			await screen.findByTestId('billing-kept-by-direct'),
		).toBeInTheDocument()
		expect(screen.getByTestId('billing-kept-estimate')).toHaveTextContent(
			'Estimate at 25% commission',
		)
		expect(screen.getByTestId('billing-kept-USD')).toHaveTextContent(
			'$1,000.00',
		)
		expect(screen.getByTestId('billing-kept-SAR')).toHaveTextContent(/200/)
	})

	it("uses the organization's own rate", async () => {
		renderStaff(<KeptByDirectCard view={{ ...view, commissionBp: 1850 }} />)
		expect(await screen.findByTestId('billing-kept-USD')).toHaveTextContent(
			'$740.00',
		)
		expect(screen.getByTestId('billing-kept-estimate')).toHaveTextContent(
			'18.5%',
		)
	})

	it('shows nothing without the sales grant or when the figures cannot be read', async () => {
		figures.list = []
		const { unmount } = renderStaff(<KeptByDirectCard view={view} />)
		await waitFor(() =>
			expect(screen.queryByTestId('billing-kept-by-direct')).toBeNull(),
		)
		unmount()
		figures.fail = true
		renderStaff(<KeptByDirectCard view={view} />)
		await new Promise((r) => setTimeout(r, 20))
		expect(screen.queryByTestId('billing-kept-by-direct')).toBeNull()
	})
})
