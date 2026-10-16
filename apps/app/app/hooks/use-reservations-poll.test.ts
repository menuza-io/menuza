/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	type PollResult,
	useReservationsPoll,
} from './use-reservations-poll.ts'

describe('useReservationsPoll', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('sends ETag on subsequent polls and preserves data reference on 304 Not Modified', async () => {
		const initialPayload = { version: 1, items: ['a', 'b'] }
		const fetcher = vi
			.fn<
				(
					etag: string | null,
					signal: AbortSignal,
				) => Promise<PollResult<typeof initialPayload>>
			>()
			.mockResolvedValueOnce({
				status: 200,
				data: initialPayload,
				etag: '"v1"',
			})
			.mockResolvedValueOnce({
				status: 304,
				etag: '"v1"',
			})

		const { result } = renderHook(() =>
			useReservationsPoll({
				key: 'loc-1:2026-04-20',
				fetcher,
				intervalMs: 0,
			}),
		)

		await waitFor(() => {
			expect(result.current.loading).toBe(false)
		})
		expect(result.current.data).toBe(initialPayload)
		expect(result.current.etag).toBe('"v1"')
		expect(fetcher).toHaveBeenNthCalledWith(1, null, expect.any(AbortSignal))

		await act(async () => {
			await result.current.refresh({ force: false })
		})

		expect(fetcher).toHaveBeenNthCalledWith(2, '"v1"', expect.any(AbortSignal))
		expect(result.current.data).toBe(initialPayload)
		expect(result.current.notModifiedCount).toBe(1)
	})

	it('pauses interval polling while paused is true and resets ETag when key changes', async () => {
		vi.useFakeTimers()
		const fetcher = vi
			.fn<
				(
					etag: string | null,
					signal: AbortSignal,
				) => Promise<PollResult<{ date: string }>>
			>()
			.mockResolvedValue({
				status: 200,
				data: { date: '2026-04-20' },
				etag: '"etag-1"',
			})

		const { rerender } = renderHook(
			({ key, paused }) =>
				useReservationsPoll({
					key,
					fetcher,
					intervalMs: 5_000,
					paused,
				}),
			{
				initialProps: { key: 'loc-1:2026-04-20', paused: true },
			},
		)

		await act(async () => {
			await Promise.resolve()
		})
		expect(fetcher).toHaveBeenCalledTimes(1)

		// Advance 20s while paused -> no additional polls
		await act(async () => {
			vi.advanceTimersByTime(20_000)
		})
		expect(fetcher).toHaveBeenCalledTimes(1)

		// Change key -> resets ETag to null and fetches immediately
		rerender({ key: 'loc-1:2026-04-21', paused: true })
		await act(async () => {
			await Promise.resolve()
		})
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(fetcher).toHaveBeenLastCalledWith(null, expect.any(AbortSignal))
	})
})
