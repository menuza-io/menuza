// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TodayAccess } from '#app/utils/dashboards/today.ts'
import { resetHomeLocationMemory } from '../use-home-location.ts'
import { TodayBlock } from './today-block.tsx'

const ACCESS: TodayAccess = {
	available: true,
	orders: true,
	covers: false,
	locations: [
		{ id: 'loc_ny', name: 'New York', timeZone: 'America/New_York' },
		{ id: 'loc_ruh', name: 'Riyadh', timeZone: 'Asia/Riyadh' },
	],
	coverLocationIds: [],
	tokenUrl: '/acme/reports/token',
	tenantApiUrl: 'http://tenant.test',
	reportSalesBasis: 'net',
	reportSalesBasisUrl: '/resources/report-sales-basis',
}

const TOTALS = {
	today: [
		{ currency: 'SAR', salesMinor: 9000, orders: 3 },
		{ currency: 'USD', salesMinor: 2500, orders: 1 },
	],
	yesterday: [{ currency: 'USD', salesMinor: 2000, orders: 1 }],
	lastWeek: [],
	guests: { total: 4, firstTime: 1, returning: 3 },
}

function renderBlock(access: TodayAccess = ACCESS) {
	return render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>
				<TodayBlock
					orgSlug="acme"
					access={access}
					locationStorageKey="home-location:user:org"
				/>
			</MemoryRouter>
		</I18nProvider>,
	)
}

describe('TodayBlock', () => {
	const fetchMock = vi.fn()
	let regionUp = true

	beforeEach(() => {
		regionUp = true
		resetHomeLocationMemory()
		try {
			window.localStorage?.clear()
		} catch {
			// Storage may be missing; the picker then just forgets.
		}
		fetchMock.mockReset()
		fetchMock.mockImplementation(async (input: unknown) => {
			const url = String(input)
			if (url.includes('/reports/token')) {
				return new Response(JSON.stringify({ token: 'analytics.jwt' }))
			}
			if (!regionUp) throw new TypeError('Failed to fetch')
			return new Response(JSON.stringify(TOTALS))
		})
		vi.stubGlobal('fetch', fetchMock)
		i18n.load('en', {})
		i18n.activate('en')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('shows one sales tile per currency and never adds them up', async () => {
		renderBlock()
		expect(await screen.findByTestId('today-sales-SAR')).toBeInTheDocument()
		expect(screen.getByTestId('today-sales-USD')).toHaveTextContent('+25%')
		// No SAR sales yesterday: no percentage.
		expect(screen.getByTestId('today-sales-SAR')).toHaveTextContent(
			'No sales then',
		)
		expect(screen.getByTestId('today-orders')).toHaveTextContent('4')
		expect(screen.getByTestId('today-guests')).toHaveTextContent(
			'1 first-time, 3 returning',
		)
		const regional = fetchMock.mock.calls
			.map(([input]) => String(input))
			.find((url) => url.startsWith('http://tenant.test/analytics/today'))!
		const query = new URL(regional).searchParams
		expect(query.get('locationIds')).toBe('loc_ny,loc_ruh')
		expect(query.get('timeZones')).toBe('America/New_York,Asia/Riyadh')
	})

	it('shows a retry state when the region cannot be reached, then recovers', async () => {
		regionUp = false
		renderBlock()
		expect(await screen.findByTestId('today-error')).toHaveTextContent(
			"Couldn't load today's numbers.",
		)
		regionUp = true
		await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(await screen.findByTestId('today-sales-USD')).toBeInTheDocument()
	})

	it('hides the order tiles when the viewer has no order grant', async () => {
		renderBlock({ ...ACCESS, orders: false, covers: false, tenantApiUrl: null })
		await waitFor(() =>
			expect(screen.queryByTestId('today-orders')).not.toBeInTheDocument(),
		)
		expect(screen.queryByTestId('today-sales-USD')).not.toBeInTheDocument()
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes('/analytics/today'),
			),
		).toBe(false)
	})
})
