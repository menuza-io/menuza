/**
 * The offline punch queue, in IndexedDB, shared by the kiosk and the Station
 * till (each with its own database name).
 *
 * A punch made while the tablet has no connection is kept here until the
 * server can confirm it. The PIN has to wait with it (the server is the only
 * thing that can check it), so the PIN is encrypted with an AES-GCM key that is
 * generated on the device and stored non-extractable: a copy of the database
 * file or a look through the browser's storage viewer shows ciphertext, not
 * digits. This is protection at rest, not against script running on the page.
 * The PIN is deleted the moment its punch is confirmed or refused.
 */

export type QueuedPunchKind =
	'clock_in' | 'break_start' | 'break_end' | 'clock_out'

export type QueuedPunch = {
	/** The punch's idempotency key: retrying the same id can never double-punch. */
	id: string
	kind: QueuedPunchKind
	staffId?: string
	positionId?: string
	breakKind?: 'meal' | 'rest'
	cashTipsMinor?: number
	/** Who the tablet took it for, when it knew; shown if the server refuses it. */
	firstName?: string
	/** The device clock when the person tapped. */
	clientAt: number
	createdAt: number
	attempts: number
	/**
	 * 500s the server gave this punch while it answered others (so it is this
	 * punch it breaks on, not an outage), and when the first came.
	 */
	serverErrors?: number
	firstServerErrorAt?: number
	status: 'queued' | 'failed'
	/** Why the server refused it; shown to the person at the tablet. */
	failure?: string
	/** `null` once the punch is settled or refused: the PIN is gone. */
	pin: { iv: Uint8Array; data: Uint8Array } | null
}

export type EnqueueInput = Omit<
	QueuedPunch,
	'createdAt' | 'attempts' | 'status' | 'failure' | 'pin'
> & { pin: string; createdAt?: number }

export const MAX_QUEUED_PUNCHES = 500
const DB_NAME = 'kiosk-queue'
const DB_VERSION = 1
const PUNCHES = 'punches'
const KEYS = 'keys'
const PIN_KEY = 'pin-key'

export class QueueUnavailableError extends Error {
	constructor(reason: 'unsupported' | 'full') {
		super(reason === 'full' ? 'queue_full' : 'queue_unsupported')
		this.name = 'QueueUnavailableError'
	}
}

type Deps = {
	indexedDB?: IDBFactory
	crypto?: Crypto
	dbName?: string
	now?: () => number
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error ?? new Error('indexeddb_failed'))
	})
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error ?? new Error('indexeddb_failed'))
		tx.onabort = () => reject(tx.error ?? new Error('indexeddb_aborted'))
	})
}

export function createClockQueue(deps: Deps = {}) {
	const idb =
		deps.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
	const cryptoImpl =
		deps.crypto ?? (typeof crypto === 'undefined' ? undefined : crypto)
	const now = deps.now ?? (() => Date.now())
	const dbName = deps.dbName ?? DB_NAME

	const supported = Boolean(idb && cryptoImpl?.subtle)
	let opened: Promise<IDBDatabase> | null = null

	function open(): Promise<IDBDatabase> {
		if (!idb) return Promise.reject(new QueueUnavailableError('unsupported'))
		opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const req = idb.open(dbName, DB_VERSION)
			req.onupgradeneeded = () => {
				const db = req.result
				if (!db.objectStoreNames.contains(PUNCHES)) {
					const table = db.createObjectStore(PUNCHES, { keyPath: 'id' })
					table.createIndex('createdAt', 'createdAt')
				}
				if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS)
			}
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => {
				opened = null
				reject(req.error ?? new Error('indexeddb_open_failed'))
			}
		})
		return opened
	}

	async function getKey(): Promise<CryptoKey> {
		const subtle = cryptoImpl?.subtle
		if (!subtle) throw new QueueUnavailableError('unsupported')
		const db = await open()
		const existing = await request<CryptoKey | undefined>(
			db.transaction(KEYS, 'readonly').objectStore(KEYS).get(PIN_KEY),
		)
		if (existing) return existing
		const key = await subtle.generateKey(
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt'],
		)
		const tx = db.transaction(KEYS, 'readwrite')
		tx.objectStore(KEYS).put(key, PIN_KEY)
		await done(tx)
		return key
	}

	async function encryptPin(pin: string) {
		const key = await getKey()
		const iv = cryptoImpl!.getRandomValues(new Uint8Array(12))
		const data = new Uint8Array(
			await cryptoImpl!.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				key,
				new TextEncoder().encode(pin),
			),
		)
		return { iv, data }
	}

	async function all(): Promise<QueuedPunch[]> {
		const db = await open()
		const rows = await request<QueuedPunch[]>(
			db.transaction(PUNCHES, 'readonly').objectStore(PUNCHES).getAll(),
		)
		return rows.sort((a, b) => a.createdAt - b.createdAt)
	}

	return {
		supported,

		async enqueue(input: EnqueueInput): Promise<void> {
			if (!supported) throw new QueueUnavailableError('unsupported')
			const existing = await all()
			if (existing.some((row) => row.id === input.id)) return
			if (existing.length >= MAX_QUEUED_PUNCHES) {
				throw new QueueUnavailableError('full')
			}
			const { pin, createdAt, ...rest } = input
			const row: QueuedPunch = {
				...rest,
				createdAt: createdAt ?? now(),
				attempts: 0,
				status: 'queued',
				pin: await encryptPin(pin),
			}
			const db = await open()
			const tx = db.transaction(PUNCHES, 'readwrite')
			tx.objectStore(PUNCHES).add(row)
			await done(tx)
		},

		/** Waiting punches, oldest first (the order they must reach the server). */
		async pending(): Promise<QueuedPunch[]> {
			if (!supported) return []
			return (await all()).filter((row) => row.status === 'queued')
		},

		async failed(): Promise<QueuedPunch[]> {
			if (!supported) return []
			return (await all()).filter((row) => row.status === 'failed')
		},

		async counts(): Promise<{ queued: number; failed: number }> {
			if (!supported) return { queued: 0, failed: 0 }
			const rows = await all()
			return {
				queued: rows.filter((row) => row.status === 'queued').length,
				failed: rows.filter((row) => row.status === 'failed').length,
			}
		},

		/** The plaintext PIN of a waiting punch. Only the sync step calls this. */
		async readPin(row: QueuedPunch): Promise<string> {
			if (!row.pin) throw new Error('pin_removed')
			const key = await getKey()
			const plain = await cryptoImpl!.subtle.decrypt(
				{ name: 'AES-GCM', iv: row.pin.iv as BufferSource },
				key,
				row.pin.data as BufferSource,
			)
			return new TextDecoder().decode(plain)
		},

		async recordAttempt(id: string): Promise<void> {
			const db = await open()
			const tx = db.transaction(PUNCHES, 'readwrite')
			const table = tx.objectStore(PUNCHES)
			const row = await request<QueuedPunch | undefined>(table.get(id))
			if (row) table.put({ ...row, attempts: row.attempts + 1 })
			await done(tx)
		},

		/** A 500 on this punch while the server answered others; returns the running totals. */
		async recordServerError(
			id: string,
			at: number,
		): Promise<{ count: number; firstAt: number } | null> {
			const db = await open()
			const tx = db.transaction(PUNCHES, 'readwrite')
			const table = tx.objectStore(PUNCHES)
			const row = await request<QueuedPunch | undefined>(table.get(id))
			let totals: { count: number; firstAt: number } | null = null
			if (row) {
				totals = {
					count: (row.serverErrors ?? 0) + 1,
					firstAt: row.firstServerErrorAt ?? at,
				}
				table.put({
					...row,
					serverErrors: totals.count,
					firstServerErrorAt: totals.firstAt,
				})
			}
			await done(tx)
			return totals
		},

		/** The server refused this punch for good: keep the reason, drop the PIN. */
		async markFailed(id: string, failure: string): Promise<void> {
			const db = await open()
			const tx = db.transaction(PUNCHES, 'readwrite')
			const table = tx.objectStore(PUNCHES)
			const row = await request<QueuedPunch | undefined>(table.get(id))
			if (row) table.put({ ...row, status: 'failed', failure, pin: null })
			await done(tx)
		},

		async remove(id: string): Promise<void> {
			const db = await open()
			const tx = db.transaction(PUNCHES, 'readwrite')
			tx.objectStore(PUNCHES).delete(id)
			await done(tx)
		},

		/**
		 * Forget refused punches once someone has seen them: only `ids` when given
		 * (the ones on screen), so one refused while the list was open stays.
		 */
		async clearFailed(ids?: readonly string[]): Promise<void> {
			const only = ids ? new Set(ids) : null
			const rows = await all()
			const db = await open()
			const tx = db.transaction(PUNCHES, 'readwrite')
			for (const row of rows) {
				if (row.status !== 'failed') continue
				if (only && !only.has(row.id)) continue
				tx.objectStore(PUNCHES).delete(row.id)
			}
			await done(tx)
		},

		/** Everything, including the key: used when a tablet is unpaired. */
		async wipe(): Promise<void> {
			if (!supported) return
			const db = await open()
			const tx = db.transaction([PUNCHES, KEYS], 'readwrite')
			tx.objectStore(PUNCHES).clear()
			tx.objectStore(KEYS).clear()
			await done(tx)
		},
	}
}

export type ClockQueue = ReturnType<typeof createClockQueue>
