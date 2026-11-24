import {
	createCountQueue,
	createKeyValueEntryStore,
	type EntryAnswer,
	type EntryStore,
	type QueuedEntry,
} from '../count-queue'

function memoryStore(initial: QueuedEntry[] = []): EntryStore & {
	saved: () => QueuedEntry[]
} {
	let saved = JSON.stringify(initial)
	return {
		async load() {
			return JSON.parse(saved) as QueuedEntry[]
		},
		async save(entries) {
			saved = JSON.stringify(entries)
		},
		saved: () => JSON.parse(saved) as QueuedEntry[],
	}
}

const entry = (
	clientId: string,
	itemId: string,
	amount: number | null,
	unit = 'kg',
) => ({ clientId, itemId, areaId: 'a1', amount, unit })

const ok = (...ids: string[]): EntryAnswer => ({
	accepted: ids.map((clientId) => ({ clientId })),
	duplicates: [],
	refused: [],
})

describe('the phone count queue (#516)', () => {
	it('keeps entries made offline on the device and sends them when the connection returns', async () => {
		const store = memoryStore()
		let online = false
		const sent: Array<{ ids: string[]; unsent: number }> = []
		const queue = createCountQueue({
			store,
			send: async (batch, unsent) => {
				if (!online) throw new Error('offline')
				sent.push({ ids: batch.map((item) => item.clientId), unsent })
				return ok(...batch.map((item) => item.clientId))
			},
		})
		await queue.submit(entry('c-1', 'rice', 4))
		await queue.submit(entry('c-2', 'beans', 2))
		// Offline: nothing was sent, both are on the device and marked failed.
		expect(queue.getState().pending.map((e) => e.clientId)).toEqual([
			'c-1',
			'c-2',
		])
		expect(queue.getState().failed).toBe(true)
		expect(store.saved().map((e) => e.clientId)).toEqual(['c-1', 'c-2'])

		online = true
		await queue.flush()
		expect(sent).toEqual([{ ids: ['c-1', 'c-2'], unsent: 0 }])
		expect(queue.getState()).toMatchObject({ pending: [], failed: false })
		expect(store.saved()).toEqual([])
	})

	it('survives a restart: a new session loads and sends what the last one left', async () => {
		const store = memoryStore()
		const offline = createCountQueue({
			store,
			send: async () => {
				throw new Error('offline')
			},
		})
		await offline.submit(entry('c-1', 'rice', 4))

		const sent: string[] = []
		const restarted = createCountQueue({
			store,
			send: async (batch) => {
				sent.push(...batch.map((item) => item.clientId))
				return ok(...batch.map((item) => item.clientId))
			},
		})
		await restarted.load()
		expect(restarted.getState().pending.map((e) => e.clientId)).toEqual(['c-1'])
		await restarted.flush()
		expect(sent).toEqual(['c-1'])
	})

	it('replaces an unsent entry for the same slot and reports how many it still holds', async () => {
		const store = memoryStore()
		const seen: Array<{ amounts: Array<number | null>; unsent: number }> = []
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => (release = resolve))
		const queue = createCountQueue({
			store,
			send: async (batch, unsent) => {
				seen.push({ amounts: batch.map((item) => item.amount), unsent })
				await gate
				return ok(...batch.map((item) => item.clientId))
			},
		})
		const first = queue.submit(entry('c-1', 'rice', 4))
		// Typed again before the request goes out: the slot keeps the newest.
		const second = queue.submit(entry('c-2', 'rice', 5))
		const third = queue.submit(entry('c-3', 'beans', 1))
		release()
		await Promise.all([first, second, third])
		expect(seen[0]).toEqual({ amounts: [5, 1], unsent: 0 })
		expect(queue.getState().pending).toEqual([])
	})

	it('settles duplicates and refusals, and stops at a closed count', async () => {
		const queue = createCountQueue({
			store: memoryStore(),
			send: async (batch) => ({
				accepted: [],
				duplicates: batch
					.filter((item) => item.clientId === 'c-1')
					.map((item) => item.clientId),
				refused: batch
					.filter((item) => item.clientId !== 'c-1')
					.map((item) => ({
						clientId: item.clientId,
						code: item.clientId === 'c-3' ? 'count_closed' : 'unit_mismatch',
					})),
			}),
		})
		await queue.submit(entry('c-1', 'rice', 4))
		await queue.submit(entry('c-2', 'beans', 1))
		const state = queue.getState()
		expect(state.pending).toEqual([])
		expect(state.refused.map((item) => item.code)).toEqual(['unit_mismatch'])
		await queue.submit(entry('c-3', 'salt', 1))
		expect(queue.getState().closed).toBe(true)
		await queue.submit(entry('c-4', 'sugar', 1))
		expect(queue.getState().pending).toEqual([])
	})

	it('counts the entries the region kept as late entries of an approved count', async () => {
		const queue = createCountQueue({
			store: memoryStore(),
			send: async (batch) => ({
				...ok(...batch.map((item) => item.clientId)),
				late: batch.map((item) => item.clientId),
			}),
		})
		await queue.submit(entry('c-1', 'rice', 4))
		expect(queue.getState().lateCount).toBe(1)
	})

	it('reads a damaged stored value as an empty queue', async () => {
		const store = createKeyValueEntryStore(
			{
				getItem: async () => '{not json',
				setItem: async () => {},
				removeItem: async () => {},
			},
			'k',
		)
		expect(await store.load()).toEqual([])
	})
})
