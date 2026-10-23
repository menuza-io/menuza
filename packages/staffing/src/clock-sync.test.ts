import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ClockApiError as KioskApiError,
	ClockNetworkError as KioskNetworkError,
	type ClockPunchBody as KioskPunchBody,
} from './clock-client.ts'
import { createClockQueue as createKioskQueue } from './clock-queue.ts'
import { MAX_SYNC_ATTEMPTS, syncBackoffMs, syncQueue } from './clock-sync.ts'

type PunchFn = (body: KioskPunchBody) => Promise<unknown>

describe('syncQueue', () => {
	let queue: ReturnType<typeof createKioskQueue>
	beforeEach(() => {
		queue = createKioskQueue({
			indexedDB: new IDBFactory(),
			crypto,
			dbName: `s-${Math.random()}`,
		})
	})

	async function add(
		id: string,
		createdAt: number,
		kind = 'clock_in' as const,
	) {
		await queue.enqueue({
			id,
			kind,
			clientAt: createdAt,
			pin: '4821',
			createdAt,
		})
	}
	const run = (punch: PunchFn) =>
		syncQueue({ queue, api: { punch: punch as never }, now: () => 5_000 })

	it('sends everything in order, marked offline, and empties the queue', async () => {
		await add('a', 1)
		await add('b', 2, 'clock_out' as never)
		const seen: KioskPunchBody[] = []
		const outcome = await run(async (body) => {
			seen.push(body)
			return { outcome: 'accepted' }
		})
		expect(seen.map((body) => body.id)).toEqual(['a', 'b'])
		expect(seen.every((body) => body.offline && body.pin === '4821')).toBe(true)
		expect(seen[0]!.deviceNowAt).toBe(5_000)
		expect(outcome).toMatchObject({ synced: 2, failed: 0, remaining: 0 })
		expect(await queue.counts()).toEqual({ queued: 0, failed: 0 })
	})

	it('stops at the first outage so later punches never jump the line', async () => {
		await add('a', 1)
		await add('b', 2)
		const punch = vi.fn<PunchFn>().mockRejectedValue(new KioskNetworkError())
		const outcome = await run(punch)
		expect(punch).toHaveBeenCalledTimes(1)
		expect(outcome).toMatchObject({ synced: 0, remaining: 2 })
		expect((await queue.pending()).map((row) => row.id)).toEqual(['a', 'b'])
	})

	it('sets a refused punch aside and carries on with the next', async () => {
		await add('a', 1)
		await add('b', 2)
		const outcome = await run(async (body) => {
			if (body.id === 'a') throw new KioskApiError(409, 'already_clocked_in')
			return { outcome: 'accepted' }
		})
		expect(outcome).toMatchObject({ synced: 1, failed: 1, remaining: 0 })
		const [failed] = await queue.failed()
		expect(failed).toMatchObject({
			id: 'a',
			failure: 'already_clocked_in',
			pin: null,
		})
	})

	it('treats a wrong PIN as final, not as something to retry', async () => {
		await add('a', 1)
		const punch = vi
			.fn<PunchFn>()
			.mockRejectedValue(new KioskApiError(401, 'invalid_pin', 30))
		const outcome = await run(punch)
		expect(outcome.failed).toBe(1)
		expect((await queue.failed())[0]!.failure).toBe('invalid_pin')
	})

	it('waits out a PIN pause instead of failing the punch', async () => {
		await add('a', 1)
		const outcome = await run(async () => {
			throw new KioskApiError(429, 'backoff', 90)
		})
		expect(outcome).toMatchObject({
			retryAfterSeconds: 90,
			failed: 0,
			remaining: 1,
		})
		expect((await queue.pending())[0]!.attempts).toBe(1)
	})

	it('reports a removed device and keeps every punch', async () => {
		await add('a', 1)
		const outcome = await run(async () => {
			throw new KioskApiError(401, 'device_revoked')
		})
		expect(outcome.deviceGone).toBe(true)
		expect(outcome.deviceGoneCode).toBe('device_revoked')
		expect(outcome.remaining).toBe(1)
	})

	it('keeps a punch, without counting an attempt, while the kill switch is on', async () => {
		await add('a', 1)
		const punch = async () => {
			throw new KioskApiError(503, 'kiosk_disabled')
		}
		for (let i = 0; i < MAX_SYNC_ATTEMPTS + 2; i++) {
			const outcome = await run(punch)
			expect(outcome).toMatchObject({
				deviceGone: false,
				failed: 0,
				remaining: 1,
				retryAfterSeconds: 60,
			})
		}
		expect(await queue.counts()).toEqual({ queued: 1, failed: 0 })
		expect((await queue.pending())[0]!.attempts).toBe(0)
	})

	it('gives up on a punch after repeated server errors', async () => {
		await add('a', 1)
		const punch = async () => {
			throw new KioskApiError(500, 'Internal Server Error')
		}
		for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) await run(punch)
		expect(await queue.counts()).toEqual({ queued: 0, failed: 1 })
		expect((await queue.failed())[0]!.failure).toBe('server_unavailable')
	})

	it('is a no-op for an empty queue', async () => {
		const punch = vi.fn<PunchFn>()
		const outcome = await run(punch)
		expect(punch).not.toHaveBeenCalled()
		expect(outcome).toEqual({
			synced: 0,
			failed: 0,
			retryAfterSeconds: null,
			deviceGone: false,
			remaining: 0,
		})
	})
})

describe('syncBackoffMs', () => {
	it('grows, is capped, and stays within the jitter band', () => {
		const mid = () => 0.5
		expect(syncBackoffMs(1, mid)).toBe(2000)
		expect(syncBackoffMs(2, mid)).toBe(4000)
		expect(syncBackoffMs(30, mid)).toBe(5 * 60_000)
		expect(syncBackoffMs(3, () => 0)).toBe(Math.round(8000 * 0.75))
		expect(syncBackoffMs(3, () => 1)).toBe(Math.round(8000 * 1.25))
	})
})
