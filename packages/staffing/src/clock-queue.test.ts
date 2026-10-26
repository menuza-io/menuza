import 'fake-indexeddb/auto'
import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	createClockQueue as createKioskQueue,
	MAX_QUEUED_PUNCHES,
	QUEUED_PUNCH_MAX_AGE_MS,
	QueueUnavailableError,
	type EnqueueInput,
} from './clock-queue.ts'

function punch(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
	return {
		id: crypto.randomUUID(),
		kind: 'clock_in',
		clientAt: 1_000,
		pin: '4821',
		...overrides,
	}
}

/**
 * A queue, and every database connection it opens, so a test can close one
 * the way a browser would.
 */
function watchedQueue() {
	const factory = new IDBFactory()
	const connections: IDBDatabase[] = []
	const open = factory.open.bind(factory)
	factory.open = (name, version) => {
		const req = open(name, version)
		req.addEventListener('success', () => connections.push(req.result))
		return req
	}
	const dbName = `w-${Math.random()}`
	const queue = createKioskQueue({ indexedDB: factory, crypto, dbName })
	return { queue, connections, factory, dbName }
}

const ids = async (rows: Promise<Array<{ id: string }>>) =>
	(await rows).map((row) => row.id)

describe('kiosk queue', () => {
	let queue: ReturnType<typeof createKioskQueue>
	beforeEach(() => {
		queue = createKioskQueue({
			indexedDB: new IDBFactory(),
			crypto,
			dbName: `q-${Math.random()}`,
		})
	})

	it('keeps punches in the order they were made', async () => {
		await queue.enqueue(punch({ id: 'b', createdAt: 20 }))
		await queue.enqueue(punch({ id: 'a', createdAt: 10 }))
		await queue.enqueue(punch({ id: 'c', createdAt: 30 }))
		expect((await queue.pending()).map((row) => row.id)).toEqual([
			'a',
			'b',
			'c',
		])
		expect(await queue.counts()).toEqual({ queued: 3, failed: 0 })
	})

	it('never stores the PIN in the clear', async () => {
		await queue.enqueue(punch({ id: 'a', pin: '4821' }))
		const [row] = await queue.pending()
		expect(JSON.stringify(Array.from(row!.pin!.data))).not.toContain('4821')
		const asText = new TextDecoder().decode(row!.pin!.data)
		expect(asText).not.toContain('4821')
		expect(await queue.readPin(row!)).toBe('4821')
	})

	it('uses a different iv for every punch', async () => {
		await queue.enqueue(punch({ id: 'a' }))
		await queue.enqueue(punch({ id: 'b' }))
		const [a, b] = await queue.pending()
		expect(Array.from(a!.pin!.iv)).not.toEqual(Array.from(b!.pin!.iv))
	})

	it('ignores a second enqueue of the same id', async () => {
		await queue.enqueue(punch({ id: 'a' }))
		await queue.enqueue(punch({ id: 'a' }))
		expect((await queue.counts()).queued).toBe(1)
	})

	it('drops the PIN when a punch is refused and keeps the reason', async () => {
		await queue.enqueue(punch({ id: 'a' }))
		await queue.markFailed('a', 'already_clocked_in')
		expect(await queue.pending()).toEqual([])
		const [failed] = await queue.failed()
		expect(failed).toMatchObject({
			id: 'a',
			status: 'failed',
			failure: 'already_clocked_in',
			pin: null,
		})
		await expect(queue.readPin(failed!)).rejects.toThrow('pin_removed')
		await queue.clearFailed()
		expect(await queue.counts()).toEqual({ queued: 0, failed: 0 })
	})

	it('removes a settled punch and counts attempts', async () => {
		await queue.enqueue(punch({ id: 'a' }))
		await queue.recordAttempt('a')
		await queue.recordAttempt('a')
		expect((await queue.pending())[0]!.attempts).toBe(2)
		await queue.remove('a')
		expect(await queue.counts()).toEqual({ queued: 0, failed: 0 })
	})

	it('refuses to grow without bound', async () => {
		for (let i = 0; i < MAX_QUEUED_PUNCHES; i++) {
			await queue.enqueue(punch({ id: `p${i}`, createdAt: i }))
		}
		await expect(queue.enqueue(punch({ id: 'one-too-many' }))).rejects.toThrow(
			QueueUnavailableError,
		)
	}, 30_000)

	it('reports unsupported when IndexedDB is missing and does nothing', async () => {
		// The globals exist in this test environment, so force the missing case.
		const none = createKioskQueue({
			indexedDB: null as unknown as IDBFactory,
			crypto: {} as Crypto,
		})
		expect(none.supported).toBe(false)
		expect(await none.pending()).toEqual([])
		expect(await none.counts()).toEqual({ queued: 0, failed: 0 })
		await expect(none.enqueue(punch())).rejects.toThrow(QueueUnavailableError)
	})

	it('wipes the queue and the key together', async () => {
		await queue.enqueue(punch({ id: 'a' }))
		await queue.wipe()
		expect(await queue.counts()).toEqual({ queued: 0, failed: 0 })
		// A new key is minted on demand afterwards.
		await queue.enqueue(punch({ id: 'b', pin: '1234' }))
		const [row] = await queue.pending()
		expect(await queue.readPin(row!)).toBe('1234')
	})
})

describe('kiosk queue, when the browser drops its connection', () => {
	it('opens a new one after the browser closes it', async () => {
		const { queue, connections } = watchedQueue()
		await queue.enqueue(punch({ id: 'a', createdAt: 1 }))
		// Site data cleared, or storage evicted: closed, with a close event.
		forceCloseDatabase(connections[0] as never)
		// The queue knows it is gone, and never tries it again.
		connections[0]!.transaction = () => {
			throw new Error('used a closed connection')
		}
		await queue.enqueue(punch({ id: 'b', createdAt: 2, pin: '1234' }))
		const pending = await queue.pending()
		expect(pending.map((row) => row.id)).toEqual(['a', 'b'])
		expect(await queue.readPin(pending[1]!)).toBe('1234')
		expect(connections).toHaveLength(2)
	})

	it('tries once more on a new connection when the old one died without a word', async () => {
		const { queue, connections } = watchedQueue()
		await queue.enqueue(punch({ id: 'a', createdAt: 1, pin: '1234' }))
		// Safari lost its IndexedDB server while the iPad slept: no close event,
		// and every transaction on the old connection fails.
		connections[0]!.transaction = () => {
			throw new DOMException(
				'Connection to Indexed Database server lost. Refresh the page to try again',
				'UnknownError',
			)
		}
		expect(await ids(queue.pending())).toEqual(['a'])
		// Closed under the queue without telling it: InvalidStateError.
		connections[1]!.close()
		await queue.enqueue(punch({ id: 'b', createdAt: 2 }))
		connections[2]!.close()
		const [first] = await queue.pending()
		connections[3]!.close()
		// The sync step still reads the PIN and settles the punch.
		expect(await queue.readPin(first!)).toBe('1234')
		connections[4]!.close()
		await queue.remove('a')
		expect(await ids(queue.pending())).toEqual(['b'])
		expect(connections).toHaveLength(6)
	})

	it('tries only once', async () => {
		const { queue, connections, factory } = watchedQueue()
		await queue.enqueue(punch({ id: 'a' }))
		// Every new connection is dead on arrival too: the error comes back.
		const open = factory.open.bind(factory)
		factory.open = (name, version) => {
			const req = open(name, version)
			req.addEventListener('success', () => req.result.close())
			return req
		}
		connections[0]!.close()
		const error = await queue.pending().catch((caught: unknown) => caught)
		expect((error as DOMException).name).toBe('InvalidStateError')
		expect(connections).toHaveLength(2)
	})

	it('lets another tab upgrade the database instead of blocking it', async () => {
		const { queue, factory, dbName } = watchedQueue()
		await queue.enqueue(punch({ id: 'a' }))
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = factory.open(dbName, 2)
			req.onblocked = () => reject(new Error('blocked'))
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		expect(upgraded.version).toBe(2)
		upgraded.close()
	})
})

describe('kiosk queue expiry', () => {
	const hour = 60 * 60 * 1000
	const now = Date.UTC(2026, 9, 24, 12)
	let queue: ReturnType<typeof createKioskQueue>
	beforeEach(() => {
		queue = createKioskQueue({
			indexedDB: new IDBFactory(),
			crypto,
			dbName: `e-${Math.random()}`,
		})
	})

	it('allows the server’s 48 hours and an hour for a clock that is off', () => {
		expect(QUEUED_PUNCH_MAX_AGE_MS).toBe(49 * hour)
	})

	it('sets aside punches too old to record, and drops their PINs', async () => {
		await queue.enqueue(
			punch({
				id: 'old',
				clientAt: now - QUEUED_PUNCH_MAX_AGE_MS - 1,
				createdAt: 1,
			}),
		)
		await queue.enqueue(
			punch({
				id: 'edge',
				clientAt: now - QUEUED_PUNCH_MAX_AGE_MS,
				createdAt: 2,
			}),
		)
		await queue.enqueue(
			punch({ id: 'recent', clientAt: now - 47 * hour, createdAt: 3 }),
		)
		expect(await queue.expire(now)).toBe(1)
		expect(await ids(queue.pending())).toEqual(['edge', 'recent'])
		const [old] = await queue.failed()
		expect(old).toMatchObject({
			id: 'old',
			status: 'failed',
			failure: 'punch_too_old',
			pin: null,
		})
		await expect(queue.readPin(old!)).rejects.toThrow('pin_removed')
		// Ten hours on the recent one is due too; one the server already refused
		// keeps its own reason, and a second run finds nothing.
		await queue.markFailed('edge', 'invalid_pin')
		expect(await queue.expire(now + 10 * hour)).toBe(1)
		expect((await queue.failed()).map((row) => [row.id, row.failure])).toEqual([
			['old', 'punch_too_old'],
			['edge', 'invalid_pin'],
			['recent', 'punch_too_old'],
		])
		expect(await queue.expire(now + 10 * hour)).toBe(0)
	})

	it('keeps everything a till paired again within 48 hours still sends', async () => {
		await queue.enqueue(punch({ id: 'a', clientAt: now - 48 * hour }))
		await queue.enqueue(punch({ id: 'b', clientAt: now - hour }))
		expect(await queue.expire(now)).toBe(0)
		expect(await queue.counts()).toEqual({ queued: 2, failed: 0 })
	})

	it('does nothing without IndexedDB', async () => {
		const none = createKioskQueue({
			indexedDB: null as unknown as IDBFactory,
			crypto: {} as Crypto,
		})
		expect(await none.expire(now)).toBe(0)
	})
})
