// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { type AccountingDayFacts } from '@repo/reports'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { AccountingScreen } from './accounting-screen.tsx'

function facts(over: Partial<AccountingDayFacts> = {}): AccountingDayFacts {
	return {
		locationId: 'loc_main',
		locationName: 'Main St',
		businessDate: '2026-11-20',
		currency: 'USD',
		closed: true,
		categories: [{ key: 'mains', label: 'Mains', minor: 10_000 }],
		grossMinor: 10_000,
		serviceFeesMinor: 0,
		discountsMinor: 0,
		loyaltyMinor: 0,
		cashDiscountsMinor: 0,
		refundsNetMinor: 0,
		taxByRate: [{ rateBp: 1500, minor: 1500 }],
		tipsMinor: 0,
		giftCardsSoldMinor: 0,
		tenders: [
			{ tender: 'cash', minor: 4000 },
			{ tender: 'card_till', minor: 7500 },
		],
		processingFeesMinor: 0,
		payoutMinor: 0,
		...over,
	}
}

const props = {
	orgSlug: 'acme',
	mapping: {},
	settings: {
		layout: 'generic' as const,
		bookkeeperEmail: null,
		weeklyEmail: false,
	},
	timeZone: 'America/Chicago',
	canReadPayments: true,
	defaultFrom: '2026-11-20',
	defaultTo: '2026-11-20',
	tokenUrl: '/acme/reports/token',
	tenantApiUrl: 'https://tenant.example.test',
}

const state = vi.hoisted(() => ({
	regional: [] as unknown[],
	payoutsHidden: false,
	provider: [] as unknown[],
}))

beforeEach(() => {
	state.regional = [facts()]
	state.payoutsHidden = false
	state.provider = []
	globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const target = String(url)
		if (target.endsWith('/reports/token'))
			return Response.json({ token: 'jwt' })
		if (target.includes('/analytics/accounting-daily'))
			return Response.json({ days: state.regional })
		return Response.json({
			provider: state.provider,
			payoutsHidden: state.payoutsHidden,
		})
	}) as never
})

describe('AccountingScreen (#189)', () => {
	it('previews a balanced, final journal per location and day', async () => {
		renderStaff(<AccountingScreen {...props} />)
		fireEvent.click(screen.getByTestId('accounting-preview'))
		const card = await screen.findByTestId(
			'accounting-day-2026-11-20-loc_main-USD',
		)
		expect(card).toHaveTextContent('Final')
		expect(card).toHaveTextContent('Balanced')
		expect(card).toHaveTextContent('Sales: Mains')
		expect(card).toHaveTextContent('Tax 15%')
		expect(screen.queryByTestId('accounting-difference-2026-11-20')).toBeNull()
	})

	it('shows the difference of a day that does not balance, never hiding it', async () => {
		state.regional = [facts({ tenders: [{ tender: 'cash', minor: 100 }] })]
		renderStaff(<AccountingScreen {...props} />)
		fireEvent.click(screen.getByTestId('accounting-preview'))
		expect(
			await screen.findByTestId('accounting-difference-2026-11-20'),
		).toHaveTextContent('Out of balance by')
		expect(
			screen.getByTestId('accounting-day-2026-11-20-loc_main-USD'),
		).toHaveTextContent('Difference (needs review)')
	})

	it('labels an open day provisional, and says when payout lines are left out', async () => {
		state.regional = [facts({ closed: false })]
		state.payoutsHidden = true
		renderStaff(<AccountingScreen {...props} canReadPayments={false} />)
		fireEvent.click(screen.getByTestId('accounting-preview'))
		expect(
			await screen.findByTestId('accounting-day-2026-11-20-loc_main-USD'),
		).toHaveTextContent('Provisional')
		expect(screen.getByTestId('accounting-no-payouts')).toBeInTheDocument()
	})

	it('offers the lines to map, with default names as placeholders', async () => {
		renderStaff(<AccountingScreen {...props} />)
		fireEvent.click(screen.getByTestId('accounting-preview'))
		const name = await screen.findByTestId('accounting-name-sales:mains')
		expect(name).toHaveAttribute('placeholder', 'Sales: Mains')
		expect(screen.getByTestId('accounting-code-tax:1500')).toBeInTheDocument()
	})

	it('reports a region failure instead of an empty journal', async () => {
		globalThis.fetch = vi.fn(async (url: RequestInfo | URL) =>
			String(url).endsWith('/reports/token')
				? Response.json({ token: 'jwt' })
				: Response.json(
						{ message: 'That range holds too many sales. Pick a shorter one.' },
						{ status: 422 },
					),
		) as never
		renderStaff(<AccountingScreen {...props} />)
		fireEvent.click(screen.getByTestId('accounting-preview'))
		await waitFor(() =>
			expect(screen.getByTestId('accounting-error')).toHaveTextContent(
				'too many sales',
			),
		)
	})
})
