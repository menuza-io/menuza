// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'

const fetchDay = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/reservations/book-api.ts', () => ({
	fetchBookDayConditional: fetchDay,
}))
vi.mock('#app/hooks/use-reservations-client.ts', () => ({
	useReservationsScopeClient: () => ({}),
}))

function render(route: string) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
	)
	return renderHook(
		() =>
			useHostStand({ orgSlug: 'acme', locationId: 'loc_1', pollIntervalMs: 0 }),
		{ wrapper },
	)
}

describe('useHostStand state', () => {
	it('takes the business date from the URL before the feed and the clock', async () => {
		fetchDay.mockResolvedValue({
			status: 200,
			etag: null,
			data: {
				businessDate: '2026-01-01',
				locationId: 'loc_1',
				dayStartMin: 240,
				timezone: 'UTC',
				reservations: [],
				moveNotices: [],
			},
		})
		const { result } = render('/acme/reservations/today?date=2026-05-05')
		expect(result.current.businessDate).toBe('2026-05-05')
		await waitFor(() => expect(result.current.dayFeed).not.toBeNull())
		expect(result.current.businessDate).toBe('2026-05-05')
		expect(result.current.isToday).toBe(false)
	})

	it('returns a stable poll reference across renders and live-clock ticks', async () => {
		fetchDay.mockResolvedValue({
			status: 200,
			etag: null,
			data: {
				businessDate: '2026-05-05',
				locationId: 'loc_1',
				dayStartMin: 240,
				timezone: 'UTC',
				reservations: [],
				moveNotices: [],
			},
		})
		const { result, rerender } = render(
			'/acme/reservations/today?date=2026-05-05',
		)
		await waitFor(() => expect(result.current.dayFeed).not.toBeNull())
		const first = result.current.poll
		rerender()
		rerender()
		expect(result.current.poll).toBe(first)
	})
})
