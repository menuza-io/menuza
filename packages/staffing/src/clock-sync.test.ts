import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ClockApiError as KioskApiError,
	ClockNetworkError as KioskNetworkError,
	type ClockPunchBody as KioskPunchBody,
} from './clock-client.ts'
import { createClockQueue as createKioskQueue } from './clock-queue.ts'
import {
	MAX_PENDING_AGE_MS,
	MAX_SYNC_ATTEMPTS,
	POISON_MIN_AGE_MS,
	syncBackoffMs,
	syncQueue,
} from './clock-sync.ts'

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
		staffId?: string,
	) {
		await queue.enqueue({
			id,
			kind,
			clientAt: createdAt,
			pin: '4821',
			createdAt,
			...(staffId ? { staffId } : {}),
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

	it('sets aside a punch made after the clock was switched off here, and goes on', async () => {
		await add('a', 1)
		await add('b', 2)
		const seen: string[] = []
		const outcome = await run(async (body) => {
			seen.push(body.id)
			if (body.id === 'a') throw new KioskApiError(409, 'timeclock_was_off')
			return { outcome: 'accepted' }
		})
		// A final answer, not a pause: the punch behind it still goes out.
		expect(seen).toEqual(['a', 'b'])
		expect(outcome).toMatchObject({ synced: 1, failed: 1, remaining: 0 })
		expect((await queue.failed())[0]!.failure).toBe('timeclock_was_off')
	})

	it('clears only the refused punches someone has seen', async () => {
		await add('a', 1)
		await add('b', 2)
		await queue.markFailed('a', 'invalid_pin')
		await queue.markFailed('b', 'invalid_pin')
		await queue.clearFailed(['a'])
		expect((await queue.failed()).map((row) => row.id)).toEqual(['b'])
	})

	it('one person’s stuck punch holds only their own later punches', async () => {
		await add('rana-in', 1, 'clock_in', 'rana')
		await add('omar-in', 2, 'clock_in', 'omar')
		await add('rana-out', 3, 'clock_out' as never, 'rana')
		const seen: string[] = []
		const outcome = await run(async (body) => {
			seen.push(body.id)
			if (body.id === 'rana-in') throw new KioskApiError(500, 'internal_error')
			return { outcome: 'accepted' }
		})
		// Omar goes out; Rana's clock-out waits behind her clock-in.
		expect(seen).toEqual(['rana-in', 'omar-in'])
		expect(outcome).toMatchObject({ synced: 1, remaining: 2 })
	})

	it('sets aside a punch the server keeps breaking on, while others get through', async () => {
		await add('rana-in', 1, 'clock_in', 'rana')
		let clock = 10_000
		const runAt = (punch: PunchFn) =>
			syncQueue({ queue, api: { punch: punch as never }, now: () => clock })
		const punch = async (body: KioskPunchBody) => {
			if (body.id === 'rana-in') throw new KioskApiError(500, 'internal_error')
			return { outcome: 'accepted' }
		}
		// Eight runs, five minutes apart, each with someone else's punch going out.
		for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
			await add(`omar-${i}`, clock, 'clock_in', `omar-${i}`)
			await runAt(punch)
			clock += 5 * 60_000
		}
		expect(await queue.counts()).toEqual({ queued: 0, failed: 1 })
		expect((await queue.failed())[0]!.failure).toBe('server_error')
	})

	it('an outage of 500s for everyone sets nothing aside, and stops early', async () => {
		await add('a', 1, 'clock_in', 'rana')
		await add('b', 2, 'clock_in', 'omar')
		await add('c', 3, 'clock_in', 'lina')
		let clock = 5_000 + POISON_MIN_AGE_MS * 4
		const seen: string[] = []
		const punch = async (body: KioskPunchBody) => {
			seen.push(body.id)
			throw new KioskApiError(500, 'internal_error')
		}
		for (let i = 0; i < MAX_SYNC_ATTEMPTS * 2; i++) {
			await syncQueue({
				queue,
				api: { punch: punch as never },
				now: () => clock,
			})
			clock += 5 * 60_000
		}
		expect(await queue.counts()).toEqual({ queued: 3, failed: 0 })
		// Two 500s in a row with nothing answered: the next person's punch is
		// probed (once a run), and when it fails too the run stops.
		expect(seen.filter((id) => id === 'c')).toHaveLength(MAX_SYNC_ATTEMPTS * 2)
	})

	it('a probe keeps each person’s order: their earliest punch goes first', async () => {
		await add('rana-in', 1, 'clock_in', 'rana')
		await add('lina-in', 2, 'clock_in', 'lina')
		await add('omar-in', 3, 'clock_in', 'omar')
		await add('omar-break', 4, 'break_start' as never, 'omar')
		await queue.recordAttempt('omar-in')
		const seen: string[] = []
		await run(async (body) => {
			seen.push(body.id)
			if (body.id.startsWith('omar')) return { outcome: 'accepted' }
			throw new KioskApiError(500, 'internal_error')
		})
		expect(seen).toEqual(['rana-in', 'lina-in', 'omar-in', 'omar-break'])
	})

	it('two broken punches at the head do not hold everyone: an untried one gets through', async () => {
		await add('rana-in', 1, 'clock_in', 'rana')
		await add('lina-in', 2, 'clock_in', 'lina')
		await add('omar-in', 3, 'clock_in', 'omar')
		const outcome = await run(async (body) => {
			if (body.id !== 'omar-in') throw new KioskApiError(500, 'internal_error')
			return { outcome: 'accepted' }
		})
		expect(outcome).toMatchObject({ synced: 1, remaining: 2 })
		// Omar got an answer, so the two 500s count against those two punches.
		const pending = await queue.pending()
		expect(pending.map((p) => p.serverErrors)).toEqual([1, 1])
	})

	it('keeps a recent punch through any number of server errors', async () => {
		await add('a', 1)
		const punch = async () => {
			throw new KioskApiError(500, 'Internal Server Error')
		}
		for (let i = 0; i < MAX_SYNC_ATTEMPTS * 3; i++) await run(punch)
		expect(await queue.counts()).toEqual({ queued: 1, failed: 0 })
	})

	it('sets a punch aside only when an outage outlasts its age limit', async () => {
		await add('a', 5_000 - MAX_PENDING_AGE_MS - 1)
		const punch = async () => {
			throw new KioskApiError(503, 'service_unavailable')
		}
		for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) await run(punch)
		expect(await queue.counts()).toEqual({ queued: 0, failed: 1 })
		expect((await queue.failed())[0]!.failure).toBe('server_unavailable')
	})

	it('sets aside a punch that keeps throwing an unexpected local error so it cannot starve the queue', async () => {
		await add('bad', 1)
		await add('good', 2)
		const punch = async (body: KioskPunchBody) => {
			if (body.id === 'bad') throw new Error('local bug')
			return { outcome: 'accepted' }
		}
		for (let i = 0; i < MAX_SYNC_ATTEMPTS - 1; i++) {
			const r = await run(punch)
			expect(r).toMatchObject({ synced: 0, failed: 0, remaining: 2 })
		}
		const final = await run(punch)
		expect(final).toMatchObject({ synced: 1, failed: 1, remaining: 0 })
		expect((await queue.failed())[0]!.failure).toBe('client_error')
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
