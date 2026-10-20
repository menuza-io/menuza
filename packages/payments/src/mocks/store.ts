import { clone, type Json } from './util'

/**
 * Persistence seam for the emulators. The App backs it with the control-plane
 * SQLite (`__mock_pay_*`, created lazily, no migration); tests use the memory
 * implementation. Both pass the same contract suite (`store-contract.ts`).
 */
export type MockProvider = 'stripe' | 'checkout' | 'mock'

export type MockObjectRow = {
	provider: MockProvider
	id: string
	type: string
	parentId: string | null
	/** Provider JSON plus internal `__mock` data and the `__rev` counter. */
	json: Json
	transitionAt: number | null
	createdAt: number
	updatedAt: number
}

export type MockEventRow = {
	provider: MockProvider
	id: string
	type: string
	payload: string
	connectAccount: string | null
	createdAt: number
	deliveredAt: number | null
	attempts: number
	lastStatus: number | null
	/** Deferred mode: not due before this time. */
	deliverAfter: number | null
	/** A delivery in flight; stops two sweeps delivering one event. */
	claimedAt: number | null
}

export type MockIdempotencyRow = {
	provider: MockProvider
	key: string
	requestHash: string
	status: number
	response: string
	createdAt: number
}

export interface MockStore {
	getObject(provider: MockProvider, id: string): Promise<MockObjectRow | null>
	/** False when the id already exists. */
	insertObject(row: MockObjectRow): Promise<boolean>
	/** Replace `json` only while `json.__rev` equals `expectedRev`. */
	replaceObject(input: {
		provider: MockProvider
		id: string
		json: Json
		expectedRev: number
		transitionAt: number | null
		updatedAt: number
	}): Promise<boolean>
	listObjects(
		provider: MockProvider,
		filter?: { type?: string; parentId?: string; limit?: number },
	): Promise<MockObjectRow[]>
	dueObjects(now: number, limit?: number): Promise<MockObjectRow[]>

	getIdempotency(
		provider: MockProvider,
		key: string,
	): Promise<MockIdempotencyRow | null>
	/** False when the key was stored first by someone else. */
	putIdempotency(row: MockIdempotencyRow): Promise<boolean>

	insertEvent(row: MockEventRow): Promise<void>
	getEvent(provider: MockProvider, id: string): Promise<MockEventRow | null>
	listEvents(filter?: {
		provider?: MockProvider
		type?: string
		limit?: number
	}): Promise<MockEventRow[]>
	/** Events not delivered with a 2xx yet, oldest first. */
	undeliveredEvents(filter?: {
		provider?: MockProvider
		dueBefore?: number
		limit?: number
	}): Promise<MockEventRow[]>
	/** Take the delivery claim. False when another delivery holds it. */
	claimEvent(
		provider: MockProvider,
		id: string,
		now: number,
		staleAfterMs: number,
	): Promise<boolean>
	recordDelivery(input: {
		provider: MockProvider
		id: string
		status: number
		at: number
	}): Promise<void>

	reset(): Promise<void>
}

export const MOCK_PAY_TABLES = [
	'__mock_pay_object',
	'__mock_pay_idempotency',
	'__mock_pay_event',
] as const

/** One statement each: D1 and libSQL both run them through `db.run`. */
export const MOCK_PAY_SCHEMA_SQL = [
	`CREATE TABLE IF NOT EXISTS __mock_pay_object (
	provider TEXT NOT NULL,
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	parent_id TEXT,
	json TEXT NOT NULL,
	transition_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (provider, id)
)`,
	`CREATE INDEX IF NOT EXISTS __mock_pay_object_type ON __mock_pay_object (provider, type, parent_id)`,
	`CREATE INDEX IF NOT EXISTS __mock_pay_object_due ON __mock_pay_object (transition_at)`,
	`CREATE TABLE IF NOT EXISTS __mock_pay_idempotency (
	provider TEXT NOT NULL,
	key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	status INTEGER NOT NULL,
	response TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (provider, key)
)`,
	`CREATE TABLE IF NOT EXISTS __mock_pay_event (
	provider TEXT NOT NULL,
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL,
	connect_account TEXT,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_status INTEGER,
	deliver_after INTEGER,
	claimed_at INTEGER,
	PRIMARY KEY (provider, id)
)`,
] as const

export function createMemoryStore(): MockStore {
	let objects = new Map<string, MockObjectRow>()
	let idempotency = new Map<string, MockIdempotencyRow>()
	let events = new Map<string, MockEventRow>()
	const key = (provider: string, id: string) => `${provider}\u0000${id}`
	const rev = (json: Json) => Number(json.__rev ?? 0)

	return {
		async getObject(provider, id) {
			const row = objects.get(key(provider, id))
			return row ? clone(row) : null
		},
		async insertObject(row) {
			const k = key(row.provider, row.id)
			if (objects.has(k)) return false
			const stored = clone(row)
			stored.json.__rev = 0
			objects.set(k, stored)
			return true
		},
		async replaceObject(input) {
			const k = key(input.provider, input.id)
			const current = objects.get(k)
			if (!current || rev(current.json) !== input.expectedRev) return false
			const next = clone(input.json)
			next.__rev = input.expectedRev + 1
			objects.set(k, {
				...current,
				json: next,
				transitionAt: input.transitionAt,
				updatedAt: input.updatedAt,
			})
			return true
		},
		async listObjects(provider, filter = {}) {
			const rows = [...objects.values()]
				.filter(
					(row) =>
						row.provider === provider &&
						(!filter.type || row.type === filter.type) &&
						(filter.parentId === undefined || row.parentId === filter.parentId),
				)
				.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
			return clone(rows.slice(0, filter.limit ?? 200))
		},
		async dueObjects(now, limit = 50) {
			return clone(
				[...objects.values()]
					.filter((row) => row.transitionAt !== null && row.transitionAt <= now)
					.sort((a, b) => (a.transitionAt ?? 0) - (b.transitionAt ?? 0))
					.slice(0, limit),
			)
		},
		async getIdempotency(provider, k) {
			const row = idempotency.get(key(provider, k))
			return row ? { ...row } : null
		},
		async putIdempotency(row) {
			const k = key(row.provider, row.key)
			if (idempotency.has(k)) return false
			idempotency.set(k, { ...row })
			return true
		},
		async insertEvent(row) {
			events.set(key(row.provider, row.id), { ...row })
		},
		async getEvent(provider, id) {
			const row = events.get(key(provider, id))
			return row ? { ...row } : null
		},
		async listEvents(filter = {}) {
			return [...events.values()]
				.filter(
					(row) =>
						(!filter.provider || row.provider === filter.provider) &&
						(!filter.type || row.type === filter.type),
				)
				.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
				.slice(0, filter.limit ?? 200)
				.map((row) => ({ ...row }))
		},
		async undeliveredEvents(filter = {}) {
			return [...events.values()]
				.filter(
					(row) =>
						row.deliveredAt === null &&
						(!filter.provider || row.provider === filter.provider) &&
						(filter.dueBefore === undefined ||
							row.deliverAfter === null ||
							row.deliverAfter <= filter.dueBefore),
				)
				.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
				.slice(0, filter.limit ?? 100)
				.map((row) => ({ ...row }))
		},
		async claimEvent(provider, id, now, staleAfterMs) {
			const row = events.get(key(provider, id))
			if (!row) return false
			if (row.claimedAt !== null && now - row.claimedAt < staleAfterMs) {
				return false
			}
			row.claimedAt = now
			return true
		},
		async recordDelivery({ provider, id, status, at }) {
			const row = events.get(key(provider, id))
			if (!row) return
			row.attempts += 1
			row.lastStatus = status
			row.claimedAt = null
			if (status >= 200 && status < 300) row.deliveredAt = at
		},
		async reset() {
			objects = new Map()
			idempotency = new Map()
			events = new Map()
		},
	}
}

export type UpdateResult<T> = { row: MockObjectRow; result: T }

/**
 * Optimistic read-modify-write on one object. The mutator may throw to abort
 * (nothing is written) and may return a value that is handed back. A lost race
 * re-reads and runs the mutator again, so it must be safe to repeat.
 */
export async function updateObject<T = void>(
	store: MockStore,
	input: {
		provider: MockProvider
		id: string
		now: number
		/** Set the time-based transition (or `null` to clear it). */
		transitionAt?: (json: Json) => number | null
	},
	mutate: (json: Json, row: MockObjectRow) => T,
): Promise<UpdateResult<T>> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const row = await store.getObject(input.provider, input.id)
		if (!row)
			throw new Error(`mock object ${input.provider}/${input.id} missing`)
		const next = clone(row.json)
		const result = mutate(next, row)
		const transitionAt = input.transitionAt
			? input.transitionAt(next)
			: row.transitionAt
		const ok = await store.replaceObject({
			provider: input.provider,
			id: input.id,
			json: next,
			expectedRev: Number(row.json.__rev ?? 0),
			transitionAt,
			updatedAt: input.now,
		})
		if (ok) {
			return {
				row: {
					...row,
					json: { ...next, __rev: Number(row.json.__rev ?? 0) + 1 },
					transitionAt,
					updatedAt: input.now,
				},
				result,
			}
		}
	}
	throw new Error(`mock object ${input.provider}/${input.id} is contended`)
}
