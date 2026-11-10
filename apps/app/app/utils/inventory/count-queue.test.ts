import { describe, expect, it, vi } from 'vitest'
import {
	type CountSyncSnapshot,
	createCountEntrySync,
	type EntryResult,
	enqueueEntry,
	entrySlotKey,
	MAX_ENTRIES_PER_REQUEST,
	pendingCountEntriesCount,
	type QueuedEntry,
	queueStorageKey,
	readQueue,
	settleBatch,
	writeQueue,
} from './count-queue.ts'

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial))
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	}
}

function entry(
	overrides: Partial<QueuedEntry> & { clientId: string },
): QueuedEntry {
	return {
		itemId: 'itm_1',
		areaId: 'area_1',
		amount: 2,
		unit: 'kg',
		queuedAt: 1,
		...overrides,
	}
}

function acceptAll(sent: readonly QueuedEntry[]): EntryResult {
	return {
		accepted: sent.map((item) => ({ clientId: item.clientId })),
		duplicates: [],
		refused: [],
	}
}

const KEY = queueStorageKey('acme', 'cnt_1')

describe('queue helpers', () => {
	it('keys the queue by organization and count', () => {
		expect(KEY).toBe('inventory-count-queue:acme:cnt_1')
	})

	it('a newer entry replaces an unsent one for the same item, area and unit', () => {
		let queue: QueuedEntry[] = []
		queue = enqueueEntry(queue, entry({ clientId: 'a', amount: 1 }))
		queue = enqueueEntry(queue, entry({ clientId: 'b', amount: 2 }))
		expect(queue.map((item) => [item.clientId, item.amount])).toEqual([
			['b', 2],
		])
	})

	it('keeps entries for other units, areas and items apart', () => {
		let queue: QueuedEntry[] = []
		queue = enqueueEntry(queue, entry({ clientId: 'a', unit: 'kg' }))
		queue = enqueueEntry(queue, entry({ clientId: 'b', unit: 'unit:box' }))
		queue = enqueueEntry(queue, entry({ clientId: 'c', areaId: 'area_2' }))
		queue = enqueueEntry(queue, entry({ clientId: 'd', itemId: 'itm_2' }))
		expect(queue.map((item) => item.clientId)).toEqual(['a', 'b', 'c', 'd'])
	})

	it('de-duplicates by clientId, even across slots', () => {
		let queue: QueuedEntry[] = []
		queue = enqueueEntry(queue, entry({ clientId: 'a', unit: 'kg' }))
		queue = enqueueEntry(queue, entry({ clientId: 'a', unit: 'g' }))
		expect(queue).toHaveLength(1)
		expect(queue[0]?.unit).toBe('g')
	})

	it('slot keys tell areas apart from "not in an area"', () => {
		expect(entrySlotKey({ itemId: 'i', areaId: null, unit: 'kg' })).toBe(
			'i||kg',
		)
	})

	it('reads nothing from blocked, empty or junk storage', () => {
		expect(readQueue(null, KEY)).toEqual([])
		expect(readQueue(memoryStorage(), KEY)).toEqual([])
		expect(readQueue(memoryStorage({ [KEY]: 'not json' }), KEY)).toEqual([])
		expect(readQueue(memoryStorage({ [KEY]: '{"a":1}' }), KEY)).toEqual([])
		const throwing = {
			getItem: () => {
				throw new Error('blocked')
			},
		}
		expect(readQueue(throwing, KEY)).toEqual([])
	})

	it('drops stored rows that are not entries and keeps the ones that are', () => {
		const good = entry({ clientId: 'a' })
		const storage = memoryStorage({
			[KEY]: JSON.stringify([good, { clientId: 1 }, null, 'x']),
		})
		expect(readQueue(storage, KEY)).toEqual([good])
	})

	it('writes the queue and removes the key when it empties', () => {
		const storage = memoryStorage()
		writeQueue(storage, KEY, [entry({ clientId: 'a' })])
		expect(storage.data.has(KEY)).toBe(true)
		writeQueue(storage, KEY, [])
		expect(storage.data.has(KEY)).toBe(false)
	})

	it('survives storage that refuses a write', () => {
		const full = {
			getItem: () => null,
			setItem: () => {
				throw new Error('quota')
			},
			removeItem: () => {},
		}
		expect(() =>
			writeQueue(full, KEY, [entry({ clientId: 'a' })]),
		).not.toThrow()
	})
})

describe('settleBatch', () => {
	const sent = [
		entry({ clientId: 'a' }),
		entry({ clientId: 'b', itemId: 'itm_2' }),
		entry({ clientId: 'c', itemId: 'itm_3' }),
		entry({ clientId: 'd', itemId: 'itm_4' }),
	]

	it('sorts accepted, replayed, refused and unanswered entries', () => {
		const settled = settleBatch(sent, {
			accepted: [{ clientId: 'a' }],
			duplicates: ['b'],
			refused: [{ clientId: 'c', code: 'not_found' }],
		})
		expect(settled.done.map((item) => item.clientId)).toEqual(['a', 'b'])
		expect(settled.refused.map((item) => item.code)).toEqual(['not_found'])
		expect(settled.unanswered.map((item) => item.clientId)).toEqual(['d'])
		expect(settled.closed).toBe(false)
	})

	it('notices a closed count', () => {
		const settled = settleBatch(sent, {
			accepted: [],
			duplicates: [],
			refused: sent.map((item) => ({
				clientId: item.clientId,
				code: 'count_closed',
			})),
		})
		expect(settled.closed).toBe(true)
	})
})

describe('createCountEntrySync', () => {
	it('persists an entry before it is sent, and empties storage once the region has it', async () => {
		const storage = memoryStorage()
		let release: (value: EntryResult) => void = () => {}
		const send = vi.fn(
			(batch: QueuedEntry[]) =>
				new Promise<EntryResult>((resolve) => {
					release = () => resolve(acceptAll(batch))
				}),
		)
		const sync = createCountEntrySync({ storage, key: KEY, send })

		const done = sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 3,
			unit: 'kg',
		})
		// The region has not answered yet: the entry is already on disk.
		expect(readQueue(storage, KEY).map((item) => item.clientId)).toEqual(['a'])
		expect(sync.getSnapshot().sending.has('a')).toBe(true)

		release({ accepted: [], duplicates: [], refused: [] })
		await done
		expect(storage.data.has(KEY)).toBe(false)
		const snapshot = sync.getSnapshot()
		expect(snapshot.pending).toEqual([])
		expect(snapshot.saved.has('itm_1||kg')).toBe(true)
	})

	it('keeps a failed entry queued, marks it failed, and retries it on flush', async () => {
		const storage = memoryStorage()
		const send = vi
			.fn<(batch: QueuedEntry[]) => Promise<EntryResult>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementation(async (batch) => acceptAll(batch))
		const sync = createCountEntrySync({ storage, key: KEY, send })

		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: 'area_1',
			amount: 3,
			unit: 'kg',
		})
		let snapshot = sync.getSnapshot()
		expect(snapshot.pending.map((item) => item.clientId)).toEqual(['a'])
		expect(snapshot.failed.has('a')).toBe(true)
		expect(snapshot.saved.size).toBe(0)
		expect(readQueue(storage, KEY)).toHaveLength(1)

		await sync.flush()
		snapshot = sync.getSnapshot()
		expect(snapshot.pending).toEqual([])
		expect(snapshot.failed.size).toBe(0)
		expect(send).toHaveBeenCalledTimes(2)
		// The retry sends the very same entry, so the region de-duplicates it.
		expect(send.mock.calls[1]![0]![0]!.clientId).toBe('a')
	})

	it('survives a reload: a second instance sends what the first never could', async () => {
		const storage = memoryStorage()
		const offline = createCountEntrySync({
			storage,
			key: KEY,
			send: async () => {
				throw new Error('offline')
			},
		})
		await offline.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 4,
			unit: 'kg',
		})
		await offline.submit({
			clientId: 'b',
			itemId: 'itm_2',
			areaId: null,
			amount: 1,
			unit: 'piece',
		})

		const send = vi.fn(async (batch: QueuedEntry[]) => acceptAll(batch))
		const reloaded = createCountEntrySync({ storage, key: KEY, send })
		expect(reloaded.getSnapshot().pending.map((item) => item.clientId)).toEqual(
			['a', 'b'],
		)
		await reloaded.flush()
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]![0]!.map((item) => item.clientId)).toEqual([
			'a',
			'b',
		])
		expect(storage.data.has(KEY)).toBe(false)
	})

	it('treats a replayed clientId as saved (the region already has it)', async () => {
		const storage = memoryStorage()
		const sync = createCountEntrySync({
			storage,
			key: KEY,
			send: async () => ({
				accepted: [],
				duplicates: ['a'],
				refused: [],
			}),
		})
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 4,
			unit: 'kg',
		})
		expect(sync.getSnapshot().pending).toEqual([])
		expect(sync.getSnapshot().saved.has('itm_1||kg')).toBe(true)
	})

	it('sends the newest value when the same field is edited twice while offline', async () => {
		const storage = memoryStorage()
		const send = vi
			.fn<(batch: QueuedEntry[]) => Promise<EntryResult>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementation(async (batch) => acceptAll(batch))
		const sync = createCountEntrySync({ storage, key: KEY, send })
		const base = { itemId: 'itm_1', areaId: null, unit: 'kg' } as const
		await sync.submit({ ...base, clientId: 'a', amount: 1 })
		await sync.submit({ ...base, clientId: 'b', amount: 2 })
		// The failed attempt for "a" no longer matters: "b" replaced it.
		await sync.flush()
		const lastBatch = send.mock.calls.at(-1)![0]
		expect(lastBatch.map((item) => [item.clientId, item.amount])).toEqual([
			['b', 2],
		])
	})

	it('sends a clear (amount null) like any other entry', async () => {
		const send = vi.fn(async (batch: QueuedEntry[]) => acceptAll(batch))
		const sync = createCountEntrySync({
			storage: memoryStorage(),
			key: KEY,
			send,
		})
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: null,
			unit: 'kg',
		})
		expect(send.mock.calls[0]![0]![0]!.amount).toBeNull()
	})

	it('drops entries the region refuses for good and reports them', async () => {
		const storage = memoryStorage()
		const sync = createCountEntrySync({
			storage,
			key: KEY,
			send: async () => ({
				accepted: [],
				duplicates: [],
				refused: [{ clientId: 'a', code: 'unit_mismatch' }],
			}),
		})
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		const snapshot = sync.getSnapshot()
		expect(snapshot.pending).toEqual([])
		expect(snapshot.refused.map((item) => item.code)).toEqual(['unit_mismatch'])
		expect(storage.data.has(KEY)).toBe(false)
	})

	it('stops and forgets everything when the count was closed meanwhile', async () => {
		const storage = memoryStorage()
		const send = vi.fn(async (batch: QueuedEntry[]) => ({
			accepted: [],
			duplicates: [],
			refused: batch.map((item) => ({
				clientId: item.clientId,
				code: 'count_closed',
			})),
		}))
		const sync = createCountEntrySync({ storage, key: KEY, send })
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		expect(sync.getSnapshot().closed).toBe(true)
		expect(storage.data.has(KEY)).toBe(false)
		await sync.submit({
			clientId: 'b',
			itemId: 'itm_2',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		expect(send).toHaveBeenCalledTimes(1)
		expect(storage.data.has(KEY)).toBe(false)
	})

	it('keeps entries the region did not answer for', async () => {
		const sync = createCountEntrySync({
			storage: memoryStorage(),
			key: KEY,
			send: async () => ({ accepted: [], duplicates: [], refused: [] }),
		})
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		const snapshot = sync.getSnapshot()
		expect(snapshot.pending).toHaveLength(1)
		expect(snapshot.failed.has('a')).toBe(true)
	})

	it('sends one request at a time and in order, then the entries added meanwhile', async () => {
		const order: string[][] = []
		const releases: Array<() => void> = []
		const send = vi.fn(
			(batch: QueuedEntry[]) =>
				new Promise<EntryResult>((resolve) => {
					order.push(batch.map((item) => item.clientId))
					releases.push(() => resolve(acceptAll(batch)))
				}),
		)
		const sync = createCountEntrySync({
			storage: memoryStorage(),
			key: KEY,
			send,
		})
		const first = sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		const second = sync.submit({
			clientId: 'b',
			itemId: 'itm_2',
			areaId: null,
			amount: 2,
			unit: 'kg',
		})
		expect(send).toHaveBeenCalledTimes(1)
		releases[0]!()
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
		releases[1]!()
		await Promise.all([first, second])
		expect(order).toEqual([['a'], ['b']])
		expect(sync.getSnapshot().pending).toEqual([])
	})

	it('splits a long queue into requests of at most 200', async () => {
		const storage = memoryStorage()
		const seeded: QueuedEntry[] = Array.from({ length: 450 }, (_, index) =>
			entry({ clientId: `c-${index}`, itemId: `itm_${index}` }),
		)
		writeQueue(storage, KEY, seeded)
		const sizes: number[] = []
		const sync = createCountEntrySync({
			storage,
			key: KEY,
			send: async (batch) => {
				sizes.push(batch.length)
				return acceptAll(batch)
			},
		})
		await sync.flush()
		expect(sizes).toEqual([
			MAX_ENTRIES_PER_REQUEST,
			MAX_ENTRIES_PER_REQUEST,
			50,
		])
		expect(sync.getSnapshot().pending).toEqual([])
	})

	it('tells subscribers when anything changes', async () => {
		const sync = createCountEntrySync({
			storage: memoryStorage(),
			key: KEY,
			send: async (batch) => acceptAll(batch),
		})
		const seen: CountSyncSnapshot[] = []
		const stop = sync.subscribe(() => seen.push(sync.getSnapshot()))
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		stop()
		expect(seen.length).toBeGreaterThanOrEqual(2)
		expect(seen.some((snapshot) => snapshot.pending.length === 1)).toBe(true)
		expect(seen.at(-1)!.pending).toEqual([])
	})

	it('clears a previous refusal for the same slot when a new entry is submitted and counts queued entries on disk', async () => {
		const storage = memoryStorage()
		const send = vi
			.fn<(batch: QueuedEntry[]) => Promise<EntryResult>>()
			.mockResolvedValueOnce({
				accepted: [],
				duplicates: [],
				refused: [{ clientId: 'a', code: 'unit_mismatch' }],
			})
			.mockImplementation(async (batch) => acceptAll(batch))
		const sync = createCountEntrySync({ storage, key: KEY, send })
		await sync.submit({
			clientId: 'a',
			itemId: 'itm_1',
			areaId: 'area_1',
			amount: 1,
			unit: 'kg',
		})
		expect(sync.getSnapshot().refused).toHaveLength(1)

		await sync.submit({
			clientId: 'b',
			itemId: 'itm_1',
			areaId: 'area_1',
			amount: 1,
			unit: 'kg',
		})
		expect(sync.getSnapshot().refused).toEqual([])
		expect(sync.getSnapshot().saved.has('itm_1|area_1|kg')).toBe(true)

		writeQueue(storage, KEY, [entry({ clientId: 'c' }), entry({ clientId: 'd', itemId: 'itm_2' })])
		expect(pendingCountEntriesCount(storage, 'acme', 'cnt_1')).toBe(2)
		sync.reloadFromStorage()
		expect(sync.getSnapshot().pending).toHaveLength(2)
	})
})
