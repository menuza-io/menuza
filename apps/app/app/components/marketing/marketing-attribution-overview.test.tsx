// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { MarketingAttributionOverview } from './marketing-attribution-overview.tsx'

const answer = {
	attribution: {
		days: 30,
		currency: 'usd',
		messagesSent: 1200,
		guestsReached: 800,
		clicked: { orders: 14, revenueMinor: 52300 },
		reached: { orders: 40, revenueMinor: 161000 },
	},
}

describe('MarketingAttributionOverview (#115)', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('shows messages sent and unique guests reached, and the Clicked / Reached switch changes figures and labels', async () => {
		const fetchMock = vi.fn(async () => Response.json(answer))
		vi.stubGlobal('fetch', fetchMock)
		renderStaff(
			<MarketingAttributionOverview jwt="jwt" tenantApiUrl="http://region" />,
		)
		expect(
			await screen.findByTestId('marketing-messages-sent'),
		).toBeInTheDocument()
		expect(fetchMock).toHaveBeenCalledWith(
			'http://region/operator/marketing/attribution?days=30',
			{ headers: { Authorization: 'Bearer jwt' } },
		)
		expect(screen.getByTestId('marketing-messages-sent')).toHaveTextContent(
			'1,200',
		)
		expect(screen.getByTestId('marketing-guests-reached')).toHaveTextContent(
			'800',
		)
		// Clicked is the default.
		expect(
			screen.getByTestId('marketing-attribution-orders'),
		).toHaveTextContent('14')
		expect(
			screen.getByTestId('marketing-attribution-revenue'),
		).toHaveTextContent('$523.00')
		expect(screen.getByText('Revenue after a click')).toBeInTheDocument()

		await userEvent.click(screen.getByTestId('marketing-attribution-reached'))
		expect(
			screen.getByTestId('marketing-attribution-orders'),
		).toHaveTextContent('40')
		expect(
			screen.getByTestId('marketing-attribution-revenue'),
		).toHaveTextContent('$1,610.00')
		expect(screen.getByText('Revenue from guests reached')).toBeInTheDocument()
		expect(screen.queryByText('Revenue after a click')).not.toBeInTheDocument()
	})

	it('says so when the figures cannot be loaded', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 500 })),
		)
		renderStaff(
			<MarketingAttributionOverview jwt="jwt" tenantApiUrl="http://region" />,
		)
		expect(await screen.findByRole('status')).toHaveTextContent(
			'could not be loaded',
		)
	})
})
