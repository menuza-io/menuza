// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { type FigureValue } from '@repo/reports'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	MonthlyResultsScreen,
	type MonthlyResultsData,
} from './monthly-results-screen.tsx'

const figures = vi.hoisted(() => ({ list: [] as unknown[], fail: false }))
vi.mock('#app/utils/reports/monthly-client.ts', () => ({
	fetchMonthlyFigures: vi.fn(async () => {
		if (figures.fail) throw new Error('boom')
		return figures.list
	}),
}))

const base: MonthlyResultsData = {
	orgSlug: 'acme',
	month: '2026-10',
	previousMonth: '2026-09',
	nextMonth: '2026-11',
	timeZone: 'America/Chicago',
	tokenUrl: '/acme/reports/token',
	tenantApiUrl: 'https://tenant.example.test',
	regionIds: ['directSales', 'directOrders', 'onlineSales'],
	reviews: [],
	off: [],
	commissionBp: 2500,
	partialSince: null,
	canEditRate: true,
	showKept: true,
}

const value = (
	id: string,
	format: FigureValue['format'],
	entries: FigureValue['entries'],
	previous: FigureValue['entries'] = [],
): FigureValue => ({ id: id as never, format, entries, previous })

beforeEach(() => {
	figures.fail = false
	figures.list = [
		value('directSales', 'currency', [{ currency: 'SAR', value: 2000 }, { currency: 'USD', value: 10_000 }], [{ currency: 'USD', value: 8000 }]),
		value('directOrders', 'number', [{ currency: null, value: 320 }], [{ currency: null, value: 300 }]),
		value('onlineSales', 'currency', [{ currency: 'USD', value: 4000 }, { currency: 'SAR', value: 800 }]),
	]
})

describe('MonthlyResultsScreen (#221)', () => {
	it('shows each currency on its own line, with the change against the month before', async () => {
		renderStaff(<MonthlyResultsScreen data={base} />)
		expect(await screen.findByTestId('monthly-figure-directSales')).toBeInTheDocument()
		expect(screen.getByTestId('monthly-value-directSales-USD')).toHaveTextContent('$10,000.00')
		expect(screen.getByTestId('monthly-value-directSales-USD')).toHaveTextContent('up 25%')
		expect(screen.getByTestId('monthly-value-directSales-SAR')).toHaveTextContent(/SAR|ر\.س/)
		expect(screen.getByTestId('monthly-value-directOrders-n')).toHaveTextContent('320')
		expect(screen.getByTestId('monthly-title')).toHaveTextContent('October 2026')
	})

	it('labels the commission estimate and shows the rate, per currency', async () => {
		renderStaff(<MonthlyResultsScreen data={{ ...base, commissionBp: 1850 }} />)
		const kept = await screen.findByTestId('monthly-kept')
		expect(screen.getByTestId('monthly-kept-estimate')).toHaveTextContent('Estimate at 18.5% commission')
		expect(screen.getByTestId('monthly-kept-USD')).toHaveTextContent('$740.00')
		expect(screen.getByTestId('monthly-kept-SAR')).toHaveTextContent(/148/)
		expect(kept).toHaveTextContent('not real money')
	})

	it('hides the estimate and the money lines without the sales grant', async () => {
		figures.list = []
		renderStaff(<MonthlyResultsScreen data={{ ...base, regionIds: [], showKept: false }} />)
		await waitFor(() => expect(screen.queryByTestId('monthly-kept')).toBeNull())
		expect(screen.queryByTestId('monthly-figure-directSales')).toBeNull()
	})

	it('says a first month is partial', async () => {
		renderStaff(<MonthlyResultsScreen data={{ ...base, partialSince: '2026-10-17' }} />)
		expect(await screen.findByTestId('monthly-partial')).toHaveTextContent('2026-10-17')
	})

	it('names modules that are off as quiet lines', async () => {
		renderStaff(<MonthlyResultsScreen data={{ ...base, off: ['reservations', 'loyalty'] }} />)
		const off = await screen.findByTestId('monthly-off')
		expect(off.querySelectorAll('li')).toHaveLength(2)
		expect(off).toHaveTextContent('Not switched on yet')
	})

	it('shows the reviews the App computed and a link to the earlier month', async () => {
		renderStaff(
			<MonthlyResultsScreen
				data={{
					...base,
					reviews: [value('newReviews', 'number', [{ currency: null, value: 7 }], [{ currency: null, value: 5 }])],
				}}
			/>,
		)
		expect(await screen.findByTestId('monthly-figure-newReviews')).toHaveTextContent('7')
		expect(screen.getByTestId('monthly-previous')).toHaveAttribute('href', '/acme/reports/monthly?month=2026-09')
	})

	it('reports a failure instead of showing zeros', async () => {
		figures.fail = true
		renderStaff(<MonthlyResultsScreen data={base} />)
		expect(await screen.findByTestId('monthly-error')).toBeInTheDocument()
	})
})
