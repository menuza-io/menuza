import { describe, expect, it } from 'vitest'
import {
	backoffDelay,
	createUploadQueue,
	rememberedKey,
	type KeyValueStore,
	type UploadResult,
} from './upload-queue.ts'

type TestFile = { name: string; size: number }

function memoryStore(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial))
	const store: KeyValueStore & { data: Map<string, string> } = {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
	}
	return store
}

function harness(
	upload: (file: TestFile, attempt: number) => Promise<UploadResult>,
	extra: { store?: KeyValueStore | null; online?: boolean } = {},
) {
	let now = 1_000
	let online = extra.online ?? true
	const listeners = new Set<() => void>()
	const slept: number[] = []
	const attempts = new Map<string, number>()
	const queue = createUploadQueue<TestFile>({
		upload: async (file) => {
			const attempt = (attempts.get(file.name) ?? 0) + 1
			attempts.set(file.name, attempt)
			return upload(file, attempt)
		},
		isOnline: () => online,
		onOnline: (callback) => {
			listeners.add(callback)
			return () => void listeners.delete(callback)
		},
		sleep: async (ms) => {
			slept.push(ms)
			now += ms
		},
		now: () => now,
		store: extra.store === undefined ? memoryStore() : extra.store,
		storageKey: 'bulk:org1',
	})
	return {
		queue,
		slept,
		attempts,
		setOnline(value: boolean) {
			online = value
			if (value) for (const listener of [...listeners]) listener()
		},
	}
}

const ok = (name: string): UploadResult => ({
	ok: true,
	assetId: `asset-${name}`,
})

function files(count: number, prefix = 'dish') {
	return Array.from({ length: count }, (_, index) => ({
		file: { name: `${prefix}-${index}.jpg`, size: 1000 + index },
		hash: `hash-${prefix}-${index}`,
	}))
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe('upload queue', () => {
	it('uploads every file and never more than three at once', async () => {
		let inFlight = 0
		let peak = 0
		const h = harness(async (file) => {
			inFlight += 1
			peak = Math.max(peak, inFlight)
			await tick(2)
			inFlight -= 1
			return ok(file.name)
		})
		h.queue.add(files(10))
		await h.queue.start()
		expect(h.queue.snapshot().counts).toEqual({
			waiting: 0,
			uploading: 0,
			done: 10,
			failed: 0,
		})
		expect(peak).toBe(3)
		expect(h.queue.peakConcurrency()).toBe(3)
	})

	it('retries a failed upload with exponential backoff', async () => {
		const h = harness(async (file, attempt) =>
			attempt < 3
				? { ok: false, retryable: true, error: 'Server busy' }
				: ok(file.name),
		)
		h.queue.add(files(1))
		await h.queue.start()
		expect(h.queue.snapshot().items[0]).toMatchObject({
			state: 'done',
			attempts: 2,
			assetId: 'asset-dish-0.jpg',
		})
		expect(h.slept).toEqual([
			backoffDelay(1, 1000, 15000),
			backoffDelay(2, 1000, 15000),
		])
		expect(h.slept).toEqual([1000, 2000])
	})

	it('caps the backoff delay', () => {
		expect(backoffDelay(10, 1000, 15000)).toBe(15000)
	})

	it('treats a thrown network error as retryable', async () => {
		const h = harness(async (file, attempt) => {
			if (attempt === 1) throw new Error('Failed to fetch')
			return ok(file.name)
		})
		h.queue.add(files(1))
		await h.queue.start()
		expect(h.queue.snapshot().items[0]).toMatchObject({ state: 'done' })
	})

	it('gives up after the last try and keeps the error', async () => {
		const h = harness(async () => ({
			ok: false,
			retryable: true,
			error: 'Nope',
		}))
		h.queue.add(files(1))
		await h.queue.start()
		expect(h.queue.snapshot().items[0]).toMatchObject({
			state: 'failed',
			attempts: 4,
			error: 'Nope',
		})
		expect(h.attempts.get('dish-0.jpg')).toBe(4)
	})

	it('does not retry a refusal (not an image, too large)', async () => {
		const h = harness(async () => ({
			ok: false,
			retryable: false,
			error: 'Use a JPEG, PNG, GIF, WebP, or AVIF image.',
		}))
		h.queue.add(files(1))
		await h.queue.start()
		expect(h.attempts.get('dish-0.jpg')).toBe(1)
		expect(h.queue.snapshot().items[0]!.state).toBe('failed')
	})

	it('retryFailed gives failed files a fresh set of tries', async () => {
		let healthy = false
		const h = harness(async (file) =>
			healthy ? ok(file.name) : { ok: false, retryable: false, error: 'Boom' },
		)
		h.queue.add(files(2))
		await h.queue.start()
		expect(h.queue.snapshot().counts.failed).toBe(2)
		healthy = true
		await h.queue.retryFailed()
		expect(h.queue.snapshot().counts).toMatchObject({ done: 2, failed: 0 })
	})

	it('pauses while offline and resumes on the online event without using tries', async () => {
		const h = harness(async (file) => ok(file.name), { online: false })
		h.queue.add(files(3))
		const running = h.queue.start()
		await tick()
		expect(h.attempts.size).toBe(0)
		expect(h.queue.snapshot().paused).toBe(true)
		expect(h.queue.snapshot().counts.waiting).toBe(3)
		h.setOnline(true)
		await running
		expect(h.queue.snapshot()).toMatchObject({
			paused: false,
			counts: { done: 3 },
		})
	})

	it('a drop in the middle of an upload waits for the connection and keeps its tries', async () => {
		let dropOnce = true
		let setOnline: (value: boolean) => void = () => undefined
		const h = harness(async (file) => {
			if (dropOnce) {
				dropOnce = false
				setOnline(false)
				return { ok: false, retryable: true, error: 'Failed to fetch' }
			}
			return ok(file.name)
		})
		setOnline = h.setOnline
		h.queue.add(files(1))
		const running = h.queue.start()
		await tick()
		expect(h.queue.snapshot()).toMatchObject({
			paused: true,
			items: [{ state: 'waiting', attempts: 0 }],
		})
		h.setOnline(true)
		await running
		expect(h.queue.snapshot().items[0]).toMatchObject({
			state: 'done',
			attempts: 0,
		})
	})

	it('skips files finished in an earlier visit (same content, name and size)', async () => {
		const store = memoryStore()
		const first = harness(async (file) => ok(file.name), { store })
		first.queue.add(files(3))
		await first.queue.start()
		expect(first.attempts.size).toBe(3)

		const second = harness(async (file) => ok(file.name), { store })
		// Two are the same files, one is new.
		second.queue.add([...files(2), ...files(1, 'new')])
		expect(
			second.queue.snapshot().items.map((item) => [item.state, item.resumed]),
		).toEqual([
			['done', true],
			['done', true],
			['waiting', false],
		])
		await second.queue.start()
		expect([...second.attempts.keys()]).toEqual(['new-0.jpg'])
		expect(second.queue.snapshot().items[0]!.assetId).toBe('asset-dish-0.jpg')
	})

	it('does not treat a file with another size as already uploaded', () => {
		const store = memoryStore()
		store.setItem(
			'bulk:org1',
			JSON.stringify({
				[rememberedKey({ hash: 'h', name: 'a.jpg', size: 10 })!]: 'asset-1',
			}),
		)
		const h = harness(async (file) => ok(file.name), { store })
		const [same, bigger] = h.queue.add([
			{ file: { name: 'a.jpg', size: 10 }, hash: 'h' },
			{ file: { name: 'a.jpg', size: 11 }, hash: 'h' },
		])
		expect(same!.state).toBe('done')
		expect(bigger!.state).toBe('waiting')
	})

	it('forget makes a file upload again', async () => {
		const store = memoryStore()
		const h = harness(async (file) => ok(file.name), { store })
		h.queue.add(files(1))
		await h.queue.start()
		h.queue.forget(['asset-dish-0.jpg'])
		const [again] = h.queue.add(files(1))
		expect(again!.state).toBe('waiting')
	})

	it('works when storage is blocked', async () => {
		const blocked: KeyValueStore = {
			getItem() {
				throw new Error('blocked')
			},
			setItem() {
				throw new Error('blocked')
			},
		}
		const h = harness(async (file) => ok(file.name), { store: blocked })
		h.queue.add(files(2))
		await h.queue.start()
		expect(h.queue.snapshot().counts.done).toBe(2)
	})

	it('ignores corrupt remembered data', async () => {
		const store = memoryStore({ 'bulk:org1': '{not json' })
		const h = harness(async (file) => ok(file.name), { store })
		h.queue.add(files(1))
		await h.queue.start()
		expect(h.queue.snapshot().counts.done).toBe(1)
	})

	it('does not remember files without a content hash', async () => {
		const store = memoryStore()
		const h = harness(async (file) => ok(file.name), { store })
		h.queue.add([{ file: { name: 'a.jpg', size: 5 }, hash: null }])
		await h.queue.start()
		expect(store.data.get('bulk:org1')).toBeUndefined()
	})
})
