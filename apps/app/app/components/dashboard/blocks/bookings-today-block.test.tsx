// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BookingsTodayBlock,
	BOOKINGS_TODAY_REFRESH_MS,
} from './bookings-today-block.tsx'

const TOKEN = {
	jwt: 'rsv.jwt',
	tenantApiUrl: 'http://tenant.test',
	expiresAt: Date.now() + 3_600_000,
	scope: 'book',
	grants: [],
	locationIds: null,
	features: {},
}

function today(parties: number, firstName = 'Rana') {
	return {
		ok: true,
		locationId: 'loc_1',
		businessDate: '2026-04-20',
		totalParties: parties,
		totalCovers: parties * 2,
		counts: { booked: parties, no_show: 1 },
		coversByService: [
			{ serviceId: 's1', name: 'Dinner', parties, covers: parties * 2 },
		],
		waitlistCount: 2,
		nextArrivals: [
			{
				reservationId: 'r1',
				time: '19:00',
				partySize: 2,
				firstName,
				status: 'booked',
			},
		],
	}
}

describe('BookingsTodayBlock', () => {
	let parties = 3
	const fetchMock = vi.fn()

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		parties = 3
		fetchMock.mockReset()
		fetchMock.mockImplementation(async (input: unknown) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.includes('/reservations/token')) {
				return new Response(JSON.stringify(TOKEN), { status: 200 })
			}
			return new Response(JSON.stringify(today(parties)), { status: 200 })
		})
		vi.stubGlobal('fetch', fetchMock)
		i18n.load('en', {})
		i18n.activate('en')
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	const mount = (locations = [{ id: 'loc_1', name: 'Main' }]) =>
		render(
			<I18nProvider i18n={i18n}>
				<MemoryRouter>
					<BookingsTodayBlock orgSlug="acme" locations={locations} />
				</MemoryRouter>
			</I18nProvider>,
		)

	const dataCalls = () =>
		fetchMock.mock.calls.filter(([input]) =>
			String(input instanceof Request ? input.url : input).includes(
				'/book/today',
			),
		)

	it('reads straight from tenant-api with a bearer token', async () => {
		mount()
		expect(
			await screen.findByTestId('bookings-today-parties'),
		).toHaveTextContent('3')
		const [input, init] = dataCalls()[0]!
		const url = String(input instanceof Request ? input.url : input)
		expect(url).toBe(
			'http://tenant.test/operator/reservations/book/today?locationId=loc_1',
		)
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		)
		expect(headers.get('authorization')).toBe('Bearer rsv.jwt')
	})

	it('shows counts by status, covers by service, the waitlist and next arrivals', async () => {
		mount()
		await screen.findByTestId('bookings-today-parties')
		expect(screen.getByTestId('bookings-today-covers')).toHaveTextContent('6')
		expect(screen.getByTestId('bookings-today-waitlist')).toHaveTextContent('2')
		expect(
			screen.getByTestId('bookings-today-status-booked'),
		).toHaveTextContent('Booked 3')
		expect(
			screen.getByTestId('bookings-today-status-no_show'),
		).toHaveTextContent('No-show 1')
		expect(screen.getByTestId('bookings-today-services')).toHaveTextContent(
			'Dinner',
		)
		expect(screen.getByTestId('bookings-today-arrivals')).toHaveTextContent(
			'19:00 Rana',
		)
	})

	it('refreshes every 60 seconds without a reload', async () => {
		mount()
		await screen.findByTestId('bookings-today-parties')
		expect(dataCalls()).toHaveLength(1)
		parties = 4
		await act(async () => {
			await vi.advanceTimersByTimeAsync(BOOKINGS_TODAY_REFRESH_MS)
		})
		await vi.waitFor(() =>
			expect(screen.getByTestId('bookings-today-parties')).toHaveTextContent(
				'4',
			),
		)
		expect(dataCalls()).toHaveLength(2)
	})

	it('shows a quiet message when the data cannot be loaded', async () => {
		fetchMock.mockImplementation(async (input: unknown) => {
			const url = String(input instanceof Request ? input.url : input)
			return url.includes('/reservations/token')
				? new Response(JSON.stringify(TOKEN), { status: 200 })
				: new Response('{}', { status: 500 })
		})
		mount()
		expect(
			await screen.findByTestId('bookings-today-error'),
		).toBeInTheDocument()
	})

	it('offers a location picker only with several locations', async () => {
		mount([
			{ id: 'loc_1', name: 'Main' },
			{ id: 'loc_2', name: 'Harbor' },
		])
		await screen.findByTestId('bookings-today-parties')
		expect(screen.getByTestId('bookings-today-location')).toBeInTheDocument()
	})
})
