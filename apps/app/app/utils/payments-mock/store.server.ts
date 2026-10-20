import { db, sql } from '@repo/database'
import {
	MOCK_PAY_SCHEMA_SQL,
	MOCK_PAY_TABLES,
	type MockEventRow,
	type MockIdempotencyRow,
	type MockObjectRow,
	type MockProvider,
	type MockStore,
} from '@repo/payments/mock'

/**
 * Emulator state in the control-plane database (local D1 in Workers dev,
 * LibSQL in Node). Dev and CI only: the tables are created lazily on first use
 * and no migration ever creates them, so a production database never has them.
 */
type ObjectRow = {
	provider: string
	id: string
	type: string
	parent_id: string | null
	json: string
	transition_at: number | null
	created_at: number
	updated_at: number
}

type EventRow = {
	provider: string
	id: string
	type: string
	payload: string
	connect_account: string | null
	created_at: number
	delivered_at: number | null
	attempts: number
	last_status: number | null
	deliver_after: number | null
	claimed_at: number | null
}

type IdempotencyRow = {
	provider: string
	key: string
	request_hash: string
	status: number
	response: string
	created_at: number
}

const toObject = (row: ObjectRow): MockObjectRow => ({
	provider: row.provider as MockProvider,
	id: row.id,
	type: row.type,
	parentId: row.parent_id,
	json: JSON.parse(row.json) as MockObjectRow['json'],
	transitionAt: row.transition_at === null ? null : Number(row.transition_at),
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
})

const toEvent = (row: EventRow): MockEventRow => ({
	provider: row.provider as MockProvider,
	id: row.id,
	type: row.type,
	payload: row.payload,
	connectAccount: row.connect_account,
	createdAt: Number(row.created_at),
	deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
	attempts: Number(row.attempts),
	lastStatus: row.last_status === null ? null : Number(row.last_status),
	deliverAfter: row.deliver_after === null ? null : Number(row.deliver_after),
	claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
})

const OBJECT_COLUMNS = sql.raw(
	'provider, id, type, parent_id, json, transition_at, created_at, updated_at',
)
const EVENT_COLUMNS = sql.raw(
	'provider, id, type, payload, connect_account, created_at, delivered_at, attempts, last_status, deliver_after, claimed_at',
)

let schemaReady: Promise<void> | null = null

function ensureSchema() {
	schemaReady ??= (async () => {
		for (const statement of MOCK_PAY_SCHEMA_SQL) {
			await db.run(sql.raw(statement))
		}
	})().catch((error) => {
		schemaReady = null
		throw error
	})
	return schemaReady
}

/** Forget that the tables exist (tests that swap the database). */
export function resetPaymentsMockSchemaCache() {
	schemaReady = null
}

export function createSqlMockStore(): MockStore {
	return {
		async getObject(provider, id) {
			await ensureSchema()
			const rows = await db.all<ObjectRow>(
				sql`SELECT ${OBJECT_COLUMNS} FROM __mock_pay_object WHERE provider = ${provider} AND id = ${id}`,
			)
			return rows[0] ? toObject(rows[0]) : null
		},

		async insertObject(row) {
			await ensureSchema()
			const json = JSON.stringify({ ...row.json, __rev: 0 })
			const inserted = await db.all<{ id: string }>(
				sql`INSERT INTO __mock_pay_object (provider, id, type, parent_id, json, transition_at, created_at, updated_at)
					VALUES (${row.provider}, ${row.id}, ${row.type}, ${row.parentId}, ${json}, ${row.transitionAt}, ${row.createdAt}, ${row.updatedAt})
					ON CONFLICT (provider, id) DO NOTHING RETURNING id`,
			)
			return inserted.length > 0
		},

		async replaceObject(input) {
			await ensureSchema()
			const json = JSON.stringify({
				...input.json,
				__rev: input.expectedRev + 1,
			})
			const updated = await db.all<{ id: string }>(
				sql`UPDATE __mock_pay_object
					SET json = ${json}, transition_at = ${input.transitionAt}, updated_at = ${input.updatedAt}
					WHERE provider = ${input.provider} AND id = ${input.id}
						AND json_extract(json, '$.__rev') = ${input.expectedRev}
					RETURNING id`,
			)
			return updated.length > 0
		},

		async listObjects(provider, filter = {}) {
			await ensureSchema()
			const conditions = [sql`provider = ${provider}`]
			if (filter.type) conditions.push(sql`type = ${filter.type}`)
			if (filter.parentId !== undefined) {
				conditions.push(sql`parent_id = ${filter.parentId}`)
			}
			const limit = Math.min(Math.max(1, filter.limit ?? 200), 500)
			const rows = await db.all<ObjectRow>(
				sql`SELECT ${OBJECT_COLUMNS} FROM __mock_pay_object
					WHERE ${sql.join(conditions, sql` AND `)}
					ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
			)
			return rows.map(toObject)
		},

		async dueObjects(now, limit = 50) {
			await ensureSchema()
			const rows = await db.all<ObjectRow>(
				sql`SELECT ${OBJECT_COLUMNS} FROM __mock_pay_object
					WHERE transition_at IS NOT NULL AND transition_at <= ${now}
					ORDER BY transition_at ASC LIMIT ${limit}`,
			)
			return rows.map(toObject)
		},

		async getIdempotency(provider, key) {
			await ensureSchema()
			const rows = await db.all<IdempotencyRow>(
				sql`SELECT provider, key, request_hash, status, response, created_at
					FROM __mock_pay_idempotency WHERE provider = ${provider} AND key = ${key}`,
			)
			const row = rows[0]
			return row
				? ({
						provider: row.provider as MockProvider,
						key: row.key,
						requestHash: row.request_hash,
						status: Number(row.status),
						response: row.response,
						createdAt: Number(row.created_at),
					} satisfies MockIdempotencyRow)
				: null
		},

		async putIdempotency(row) {
			await ensureSchema()
			const inserted = await db.all<{ key: string }>(
				sql`INSERT INTO __mock_pay_idempotency (provider, key, request_hash, status, response, created_at)
					VALUES (${row.provider}, ${row.key}, ${row.requestHash}, ${row.status}, ${row.response}, ${row.createdAt})
					ON CONFLICT (provider, key) DO NOTHING RETURNING key`,
			)
			return inserted.length > 0
		},

		async insertEvent(row) {
			await ensureSchema()
			await db.run(
				sql`INSERT INTO __mock_pay_event (provider, id, type, payload, connect_account, created_at, delivered_at, attempts, last_status, deliver_after, claimed_at)
					VALUES (${row.provider}, ${row.id}, ${row.type}, ${row.payload}, ${row.connectAccount}, ${row.createdAt}, ${row.deliveredAt}, ${row.attempts}, ${row.lastStatus}, ${row.deliverAfter}, ${row.claimedAt})`,
			)
		},

		async getEvent(provider, id) {
			await ensureSchema()
			const rows = await db.all<EventRow>(
				sql`SELECT ${EVENT_COLUMNS} FROM __mock_pay_event WHERE provider = ${provider} AND id = ${id}`,
			)
			return rows[0] ? toEvent(rows[0]) : null
		},

		async listEvents(filter = {}) {
			await ensureSchema()
			const conditions = [sql`1 = 1`]
			if (filter.provider) conditions.push(sql`provider = ${filter.provider}`)
			if (filter.type) conditions.push(sql`type = ${filter.type}`)
			const limit = Math.min(Math.max(1, filter.limit ?? 200), 500)
			const rows = await db.all<EventRow>(
				sql`SELECT ${EVENT_COLUMNS} FROM __mock_pay_event
					WHERE ${sql.join(conditions, sql` AND `)}
					ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
			)
			return rows.map(toEvent)
		},

		async undeliveredEvents(filter = {}) {
			await ensureSchema()
			const conditions = [sql`delivered_at IS NULL`]
			if (filter.provider) conditions.push(sql`provider = ${filter.provider}`)
			if (filter.dueBefore !== undefined) {
				conditions.push(
					sql`(deliver_after IS NULL OR deliver_after <= ${filter.dueBefore})`,
				)
			}
			const limit = Math.min(Math.max(1, filter.limit ?? 100), 500)
			const rows = await db.all<EventRow>(
				sql`SELECT ${EVENT_COLUMNS} FROM __mock_pay_event
					WHERE ${sql.join(conditions, sql` AND `)}
					ORDER BY created_at ASC, rowid ASC LIMIT ${limit}`,
			)
			return rows.map(toEvent)
		},

		async claimEvent(provider, id, now, staleAfterMs) {
			await ensureSchema()
			const claimed = await db.all<{ id: string }>(
				sql`UPDATE __mock_pay_event SET claimed_at = ${now}
					WHERE provider = ${provider} AND id = ${id}
						AND (claimed_at IS NULL OR ${now} - claimed_at >= ${staleAfterMs})
					RETURNING id`,
			)
			return claimed.length > 0
		},

		async recordDelivery({ provider, id, status, at }) {
			await ensureSchema()
			const delivered = status >= 200 && status < 300
			await db.run(
				sql`UPDATE __mock_pay_event
					SET attempts = attempts + 1, last_status = ${status}, claimed_at = NULL,
						delivered_at = CASE WHEN ${delivered ? 1 : 0} = 1 THEN ${at} ELSE delivered_at END
					WHERE provider = ${provider} AND id = ${id}`,
			)
		},

		async reset() {
			await ensureSchema()
			for (const table of MOCK_PAY_TABLES) {
				await db.run(sql.raw(`DELETE FROM ${table}`))
			}
		},
	}
}
