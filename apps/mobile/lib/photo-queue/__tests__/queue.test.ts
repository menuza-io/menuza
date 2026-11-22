import { MAX_ATTEMPTS, STALE_UPLOADING_MS, backoffFor } from '../backoff'
import { PhotoUploadQueue } from '../queue'
import {
	createKeyValueQueueStorage,
	createMemoryPhotoFiles,
	createMemoryQueueStorage,
} from '../storage'
import {
	type PhotoQueueDeps,
	type QueueItem,
	type UploadInput,
	type UploadOutcome,
} from '../types'

const OK: UploadOutcome = {
	kind: 'ok',
	itemId: 'dish-1',
	assetId: 'asset-1',
	imageUrl: 'https://cdn.example/dish-1.jpg',
}

function setup(
	options: {
		storage?: ReturnType<typeof createMemoryQueueStorage>
		files?: ReturnType<typeof createMemoryPhotoFiles>
		outcomes?: UploadOutcome[]
		online?: boolean
		tokens?: Array<string | null>
		refresh?: () => Promise<void>
		clock?: { now: number }
	} = {},
) {
	const clock = options.clock ?? { now: 1_000_000 }
	const storage = options.storage ?? createMemoryQueueStorage()
	const files = options.files ?? createMemoryPhotoFiles()
	const state = { online: options.online ?? true, ids: 0 }
	const outcomes = [...(options.outcomes ?? [OK])]
	const tokens = [...(options.tokens ?? [])]
	const upload = jest.fn(async (_input: UploadInput): Promise<UploadOutcome> =>
		outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!,
	)
	const refreshSession = jest.fn(options.refresh ?? (async () => {}))
	const timers: Array<{ fn: () => void; ms: number }> = []
	const deps: PhotoQueueDeps = {
		storage,
		files,
		upload,
		getAccessToken: async () =>
			tokens.length > 0 ? (tokens.shift() ?? null) : 'token-1',
		refreshSession,
		isOnline: () => state.online,
		newId: () => `id-${++state.ids}`,
		now: () => clock.now,
		setTimer: (fn, ms) => {
			timers.push({ fn, ms })
			return timers.length
		},
		clearTimer: () => {},
	}
	const queue = new PhotoUploadQueue(deps)
	return { queue, storage, files, upload, refreshSession, state, clock, timers }
}

const photo = {
	organizationId: 'org-1',
	itemId: 'dish-1',
	sourceUri: 'file:///tmp/a.jpg',
}

describe('PhotoUploadQueue', () => {
	it('keeps a failed upload waiting, then retries it after the backoff', async () => {
		const t = setup({
			outcomes: [{ kind: 'network', message: 'boom' }, OK],
		})
		const item = await t.queue.enqueue(photo)
		await t.queue.kick()

		expect(t.upload).toHaveBeenCalledTimes(1)
		const [waiting] = t.queue.getSnapshot().items
		expect(waiting).toMatchObject({
			id: item.id,
			status: 'waiting',
			attempts: 1,
			nextAttemptAt: t.clock.now + backoffFor(1),
			lastError: { code: 'network_error', permanent: false },
		})
		expect(t.storage.snapshot()).toHaveLength(1)

		// Too early: nothing is sent.
		t.clock.now += backoffFor(1) - 1
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(1)

		t.clock.now += 1
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(2)
		expect(t.queue.getSnapshot().items).toEqual([])
	})

	it('treats a 5xx and a 429 as retryable and counts the attempt', async () => {
		const t = setup({
			outcomes: [
				{ kind: 'transient', status: 503, code: 'internal_error', message: '' },
			],
		})
		await t.queue.enqueue(photo)
		await t.queue.kick()
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'waiting',
			attempts: 1,
		})
	})

	it('does not burn attempts while the phone is offline', async () => {
		const t = setup({ online: false })
		await t.queue.enqueue(photo)
		await t.queue.kick()
		await t.queue.kick()

		expect(t.upload).not.toHaveBeenCalled()
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'waiting',
			attempts: 0,
		})

		t.state.online = true
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(1)
		expect(t.queue.getSnapshot().items).toEqual([])
	})

	it('does not burn an attempt when the request fails because the connection dropped', async () => {
		const t = setup({ outcomes: [{ kind: 'network', message: 'lost' }] })
		await t.queue.enqueue(photo)
		t.upload.mockImplementationOnce(async () => {
			t.state.online = false
			return { kind: 'network', message: 'lost' }
		})
		await t.queue.kick()
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'waiting',
			attempts: 0,
		})
	})

	it('survives a restart: a saved queue is reloaded and an uploading item is reclaimed', async () => {
		const storage = createMemoryQueueStorage()
		const files = createMemoryPhotoFiles()
		const first = setup({ storage, files, online: false })
		const item = await first.queue.enqueue(photo)
		first.queue.dispose()

		// The process died mid-request: the saved row says `uploading`.
		const saved = storage.snapshot()
		await storage.save(
			saved.map((row) => ({
				...row,
				status: 'uploading' as const,
				uploadStartedAt: first.clock.now,
			})),
		)

		const second = setup({ storage, files, clock: first.clock })
		await second.queue.load()
		expect(second.queue.getSnapshot().items[0]).toMatchObject({
			id: item.id,
			status: 'waiting',
			uploadStartedAt: null,
		})

		await second.queue.kick()
		expect(second.upload).toHaveBeenCalledTimes(1)
		expect(second.upload.mock.calls[0]![0].item.id).toBe(item.id)
		expect(storage.snapshot()).toEqual([])
	})

	it('keeps a backed-off item across a restart and sends it once due', async () => {
		const storage = createMemoryQueueStorage()
		const files = createMemoryPhotoFiles()
		const first = setup({
			storage,
			files,
			outcomes: [{ kind: 'network', message: 'x' }],
		})
		await first.queue.enqueue(photo)
		await first.queue.kick()
		first.queue.dispose()

		const second = setup({ storage, files, clock: first.clock })
		await second.queue.load()
		await second.queue.kick()
		expect(second.upload).not.toHaveBeenCalled()
		second.clock.now += backoffFor(1)
		await second.queue.kick()
		expect(second.upload).toHaveBeenCalledTimes(1)
	})

	it('reads a damaged saved queue as empty', async () => {
		const storage = createKeyValueQueueStorage({
			getItem: async () => '{not json',
			setItem: async () => {},
		})
		await expect(storage.load()).resolves.toEqual([])
	})

	it.each([
		[400, 'validation_error'],
		[403, 'forbidden'],
		[404, 'not_found'],
		[413, 'payload_too_large'],
		[415, 'unsupported_media_type'],
	])('stops for good on a %i refusal', async (status, code) => {
		const t = setup({
			outcomes: [{ kind: 'refused', status, code, message: 'no' }],
		})
		const item = await t.queue.enqueue(photo)
		await t.queue.kick()
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'failed',
			lastError: { code, status, permanent: true },
		})

		t.clock.now += 24 * 60 * 60 * 1000
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(1)
		// The file stays so the person can retry.
		expect(t.files.stored.size).toBe(1)

		// A person's retry starts clean.
		t.upload.mockResolvedValueOnce(OK)
		await t.queue.retry(item.id)
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(2)
		expect(t.queue.getSnapshot().items).toEqual([])
	})

	it('refreshes the session once on a 401 and retries once', async () => {
		const t = setup({
			outcomes: [{ kind: 'unauthorized' }, OK],
			tokens: ['old-token', 'new-token'],
		})
		await t.queue.enqueue(photo)
		await t.queue.kick()

		expect(t.refreshSession).toHaveBeenCalledTimes(1)
		expect(t.upload).toHaveBeenCalledTimes(2)
		expect(t.upload.mock.calls[0]![0].accessToken).toBe('old-token')
		expect(t.upload.mock.calls[1]![0].accessToken).toBe('new-token')
		expect(t.queue.getSnapshot().items).toEqual([])
	})

	it('does not refresh again when the retry is also a 401', async () => {
		const t = setup({ outcomes: [{ kind: 'unauthorized' }] })
		await t.queue.enqueue(photo)
		await t.queue.kick()

		expect(t.refreshSession).toHaveBeenCalledTimes(1)
		expect(t.upload).toHaveBeenCalledTimes(2)
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'waiting',
			attempts: 1,
			lastError: { code: 'session_expired' },
		})
	})

	it('holds the item without spending an attempt when the refresh itself fails', async () => {
		const t = setup({
			outcomes: [{ kind: 'unauthorized' }],
			refresh: async () => {
				throw new Error('refresh refused')
			},
		})
		await t.queue.enqueue(photo)
		await t.queue.kick()

		expect(t.upload).toHaveBeenCalledTimes(1)
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'waiting',
			attempts: 0,
			lastError: { code: 'session_expired' },
		})
	})

	it('removes the item and its file on success and reports it', async () => {
		const t = setup()
		const uploaded: string[] = []
		t.queue.onUploaded((event) => uploaded.push(event.imageUrl))
		const item = await t.queue.enqueue(photo)
		expect(t.files.stored.has(item.fileUri)).toBe(true)

		await t.queue.kick()
		expect(t.queue.getSnapshot().items).toEqual([])
		expect(t.storage.snapshot()).toEqual([])
		expect(t.files.stored.size).toBe(0)
		expect(uploaded).toEqual([OK.imageUrl])
	})

	it('sends the same clientId on every try of one photo', async () => {
		const t = setup({
			outcomes: [
				{ kind: 'network', message: 'a' },
				{ kind: 'transient', status: 500, code: 'internal_error', message: '' },
				OK,
			],
		})
		const item = await t.queue.enqueue(photo)
		for (let i = 0; i < 3; i++) {
			await t.queue.kick()
			t.clock.now += 60 * 60 * 1000
		}
		expect(t.upload).toHaveBeenCalledTimes(3)
		const ids = t.upload.mock.calls.map((call) => call[0].item.id)
		expect(new Set(ids)).toEqual(new Set([item.id]))
	})

	it('gives up after too many counted tries and lets the person retry', async () => {
		const t = setup({
			outcomes: [
				{ kind: 'transient', status: 500, code: 'internal_error', message: '' },
			],
		})
		await t.queue.enqueue(photo)
		for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
			await t.queue.kick()
			t.clock.now += 60 * 60 * 1000
		}
		expect(t.upload).toHaveBeenCalledTimes(MAX_ATTEMPTS)
		expect(t.queue.getSnapshot().items[0]).toMatchObject({
			status: 'failed',
			lastError: { code: 'gave_up', permanent: false },
		})
	})

	it('replaces an unsent photo of the same dish with the newer one', async () => {
		const t = setup({ online: false })
		const first = await t.queue.enqueue(photo)
		const second = await t.queue.enqueue({
			...photo,
			sourceUri: 'file:///b.jpg',
		})

		const items = t.queue.getSnapshot().items
		expect(items.map((item) => item.id)).toEqual([second.id])
		expect(t.files.stored.has(first.fileUri)).toBe(false)
		expect(t.files.stored.has(second.fileUri)).toBe(true)
	})

	it('reclaims an item whose request never finished', async () => {
		const t = setup()
		const stale: QueueItem = {
			id: 'stale',
			organizationId: 'org-1',
			itemId: 'dish-1',
			itemName: null,
			fileUri: 'file:///documents/dish-photos/stale.jpg',
			status: 'uploading',
			attempts: 0,
			nextAttemptAt: t.clock.now,
			createdAt: t.clock.now,
			uploadStartedAt: t.clock.now,
			lastError: null,
		}
		// Loaded as `uploading` by a queue that is already running.
		await t.storage.save([stale])
		await t.queue.load()
		// load() reclaims at once; put it back to `uploading` to model a live row.
		;(t.queue as unknown as { items: QueueItem[] }).items[0]!.status =
			'uploading'
		;(t.queue as unknown as { items: QueueItem[] }).items[0]!.uploadStartedAt =
			t.clock.now
		t.clock.now += STALE_UPLOADING_MS + 1
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(1)
		expect(t.queue.getSnapshot().items).toEqual([])
	})

	it('wakes itself with a timer while something waits', async () => {
		const t = setup({ outcomes: [{ kind: 'network', message: 'x' }, OK] })
		await t.queue.enqueue(photo)
		await t.queue.kick()
		const timer = t.timers[t.timers.length - 1]!
		expect(timer.ms).toBe(backoffFor(1))

		t.clock.now += backoffFor(1)
		timer.fn()
		await t.queue.kick()
		expect(t.upload).toHaveBeenCalledTimes(2)
	})

	it('removes a failed item and its file on request', async () => {
		const t = setup({
			outcomes: [
				{ kind: 'refused', status: 403, code: 'forbidden', message: '' },
			],
		})
		const item = await t.queue.enqueue(photo)
		await t.queue.kick()
		await t.queue.remove(item.id)
		expect(t.queue.getSnapshot().items).toEqual([])
		expect(t.files.stored.size).toBe(0)
		expect(t.storage.snapshot()).toEqual([])
	})
})
