import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	STATUS_POLL_INTERVAL_MS,
	createStatusPoller,
	isTerminalStatus,
	type StatusFetchResult,
} from './status-poll.ts'

type Order = { status: string }

function setup(
	results: Array<
		StatusFetchResult<object> | Error | Promise<StatusFetchResult<object>>
	>,
) {
	let hidden = false
	let listener: (() => void) | null = null
	const queue = [...results]
	const fetchOnce = vi.fn(async () => {
		const next = queue.shift()
		if (next instanceof Error) throw next
		return (await next) as StatusFetchResult<object>
	})
	const seen: Order[] = []
	const onGone = vi.fn()
	const poller = createStatusPoller<object>({
		fetchOnce,
		onOrder: (order) => seen.push(order),
		onGone,
		isHidden: () => hidden,
		onVisibilityChange: (cb) => {
			listener = cb
			return () => {
				listener = null
			}
		},
	})
	return {
		poller,
		fetchOnce,
		seen,
		onGone,
		setHidden(value: boolean) {
			hidden = value
			listener?.()
		},
		hasListener: () => listener !== null,
	}
}

const order = (status: string): StatusFetchResult<object> => ({
	kind: 'order',
	order: { status },
})

describe('createStatusPoller', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('polls every 15 seconds', async () => {
		const t = setup([order('accepted'), order('preparing'), order('ready')])
		expect(STATUS_POLL_INTERVAL_MS).toBe(15_000)
		t.poller.start({ immediate: false })
		await vi.advanceTimersByTimeAsync(14_999)
		expect(t.fetchOnce).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(t.fetchOnce).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(t.seen.map((o) => o.status)).toEqual([
			'accepted',
			'preparing',
			'ready',
		])
		t.poller.stop()
	})

	it('reads immediately by default', async () => {
		const t = setup([order('accepted')])
		t.poller.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(t.fetchOnce).toHaveBeenCalledTimes(1)
		t.poller.stop()
	})

	it.each(['completed', 'cancelled', 'expired'])(
		'stops once the order is %s',
		async (status) => {
			const t = setup([order('ready'), order(status), order('ready')])
			t.poller.start()
			await vi.advanceTimersByTimeAsync(60_000)
			expect(t.fetchOnce).toHaveBeenCalledTimes(2)
			expect(t.hasListener()).toBe(false)
		},
	)

	it('stops for good when the order is gone', async () => {
		const t = setup([{ kind: 'gone' }, order('ready')])
		t.poller.start()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(1)
		expect(t.onGone).toHaveBeenCalledTimes(1)
		expect(t.seen).toEqual([])
	})

	it('survives errors without a tight loop and keeps the last state', async () => {
		const t = setup([order('accepted'), new Error('offline'), order('ready')])
		t.poller.start()
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(14_999)
		expect(t.fetchOnce).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(t.fetchOnce).toHaveBeenCalledTimes(3)
		expect(t.seen.map((o) => o.status)).toEqual(['accepted', 'ready'])
		t.poller.stop()
	})

	it('pauses while hidden and reads at once when visible again', async () => {
		const t = setup([order('accepted'), order('preparing'), order('ready')])
		t.poller.start()
		await vi.advanceTimersByTimeAsync(0)
		t.setHidden(true)
		await vi.advanceTimersByTimeAsync(120_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(1)
		t.setHidden(false)
		await vi.advanceTimersByTimeAsync(0)
		expect(t.fetchOnce).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(3)
		t.poller.stop()
	})

	it('does not schedule when a read finishes while hidden', async () => {
		let resolve!: (value: StatusFetchResult<object>) => void
		const slow = new Promise<StatusFetchResult<object>>((r) => (resolve = r))
		const t = setup([slow, order('ready')])
		t.poller.start()
		await vi.advanceTimersByTimeAsync(0)
		t.setHidden(true)
		resolve(order('accepted'))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(1)
		t.poller.stop()
	})

	it('never overlaps requests', async () => {
		let resolve!: (value: StatusFetchResult<object>) => void
		const slow = new Promise<StatusFetchResult<object>>((r) => (resolve = r))
		const t = setup([slow, order('ready')])
		t.poller.start()
		await vi.advanceTimersByTimeAsync(0)
		t.poller.refresh()
		t.setHidden(true)
		t.setHidden(false)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(1)
		resolve(order('accepted'))
		await vi.advanceTimersByTimeAsync(15_000)
		expect(t.fetchOnce).toHaveBeenCalledTimes(2)
		t.poller.stop()
	})

	it('does nothing after stop', async () => {
		const t = setup([order('accepted')])
		t.poller.start({ immediate: false })
		t.poller.stop()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(t.fetchOnce).not.toHaveBeenCalled()
	})
})

describe('isTerminalStatus', () => {
	it('knows the settled statuses', () => {
		expect(isTerminalStatus('completed')).toBe(true)
		expect(isTerminalStatus('cancelled')).toBe(true)
		expect(isTerminalStatus('ready')).toBe(false)
		expect(isTerminalStatus(null)).toBe(false)
	})
})
