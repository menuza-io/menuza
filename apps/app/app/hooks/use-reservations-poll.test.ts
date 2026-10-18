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

	it('never returns the previous key data after the key changes', async () => {
		let resolveSecond: (value: PollResult<{ date: string }>) => void = () => {}
		const fetcher = vi
			.fn<
				(
					etag: string | null,
					signal: AbortSignal,
				) => Promise<PollResult<{ date: string }>>
			>()
			.mockResolvedValueOnce({
				status: 200,
				data: { date: 'monday' },
				etag: '"a"',
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve
					}),
			)
		const { result, rerender } = renderHook(
			({ key }) => useReservationsPoll({ key, fetcher, intervalMs: 0 }),
			{ initialProps: { key: 'loc:monday' } },
		)
		await waitFor(() => expect(result.current.data).toEqual({ date: 'monday' }))

		rerender({ key: 'loc:tuesday' })
		expect(result.current.data).toBeNull()
		expect(result.current.loading).toBe(true)

		await act(async () => {
			resolveSecond({ status: 200, data: { date: 'tuesday' }, etag: '"b"' })
		})
		await waitFor(() =>
			expect(result.current.data).toEqual({ date: 'tuesday' }),
		)
	})

	it('drops a response that resolves after the key changed', async () => {
		const resolvers: Array<(value: PollResult<{ date: string }>) => void> = []
		const fetcher = vi.fn(
			() =>
				new Promise<PollResult<{ date: string }>>((resolve) => {
					resolvers.push(resolve)
				}),
		)
		const { result, rerender } = renderHook(
			({ key }) => useReservationsPoll({ key, fetcher, intervalMs: 0 }),
			{ initialProps: { key: 'monday' } },
		)
		rerender({ key: 'tuesday' })
		resolvers[1]!({ status: 200, data: { date: 'tuesday' }, etag: null })
		await waitFor(() =>
			expect(result.current.data).toEqual({ date: 'tuesday' }),
		)
		resolvers[0]!({ status: 200, data: { date: 'monday' }, etag: null })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(result.current.data).toEqual({ date: 'tuesday' })
	})

	it('stops polling after a 403 and exposes the status', async () => {
		vi.useFakeTimers()
		const denied = Object.assign(new Error('forbidden'), {
			status: 403,
			body: { error: 'forbidden' },
		})
		const fetcher = vi
			.fn<
				(
					etag: string | null,
					signal: AbortSignal,
				) => Promise<PollResult<number>>
			>()
			.mockRejectedValue(denied)
		const { result } = renderHook(() =>
			useReservationsPoll({ key: 'k', fetcher, intervalMs: 1_000 }),
		)
		await act(async () => {
			await Promise.resolve()
		})
		expect(result.current.accessDenied).toBe(true)
		expect(result.current.errorStatus).toBe(403)
		expect(result.current.errorCode).toBe('forbidden')
		const calls = fetcher.mock.calls.length
		await act(async () => {
			vi.advanceTimersByTime(10_000)
		})
		expect(fetcher).toHaveBeenCalledTimes(calls)
	})

	it('returns the same object while nothing changed', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue({ status: 200, data: 1, etag: null })
		const { result, rerender } = renderHook(() =>
			useReservationsPoll<number>({ key: 'k', fetcher, intervalMs: 0 }),
		)
		await waitFor(() => expect(result.current.data).toBe(1))
		const first = result.current
		rerender()
		expect(result.current).toBe(first)
	})
})
