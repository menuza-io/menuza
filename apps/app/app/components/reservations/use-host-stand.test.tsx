// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'

const pollOptions = vi.hoisted(() => ({
	calls: [] as Array<{ paused?: boolean; intervalMs?: number }>,
}))
const liveNowOptions = vi.hoisted(() => ({
	calls: [] as Array<{ intervalMs?: number }>,
}))

vi.mock('#app/hooks/use-reservations-poll.ts', () => ({
	useReservationsPoll: (options: { paused?: boolean; intervalMs?: number }) => {
		pollOptions.calls.push(options)
		return {
			data: null,
			refresh: vi.fn(),
			setOptimisticData: vi.fn(),
		}
	},
}))

vi.mock('#app/hooks/use-live-now.ts', () => ({
	useLiveNow: (options: { intervalMs?: number }) => {
		liveNowOptions.calls.push(options)
		return { businessDate: '2026-10-16' }
	},
}))

vi.mock('#app/hooks/use-reservations-client.ts', () => ({
	useReservationsScopeClient: () => ({}),
}))

function renderHostStand(route: string) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
	)
	return renderHook(
		() => useHostStand({ orgSlug: 'acme', locationId: 'loc_1' }),
		{ wrapper },
	)
}

describe('useHostStand polling', () => {
	beforeEach(() => {
		pollOptions.calls.length = 0
		liveNowOptions.calls.length = 0
	})

	it('keeps polling while no reservation detail is open', () => {
		renderHostStand('/acme/reservations/book')
		expect(pollOptions.calls.at(-1)?.paused).toBe(false)
	})

	it('pauses background day-feed polling while the detail sheet is open', () => {
		renderHostStand('/acme/reservations/book?r=rsv_1')
		expect(pollOptions.calls.at(-1)?.paused).toBe(true)
	})

	it('ticks live timers every 15 seconds', () => {
		renderHostStand('/acme/reservations/book')
		expect(liveNowOptions.calls.at(-1)?.intervalMs).toBe(15_000)
	})
})
