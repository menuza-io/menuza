import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	createClockQueue as createKioskQueue,
	MAX_QUEUED_PUNCHES,
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
