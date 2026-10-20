import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	applyTenantMigrations,
	schema,
	staffMembers,
	timeBreaks,
	voiceRecordingDeletions,
	type TenantDatabase,
} from '@repo/tenant-db'
import { loadBreaks } from '../services/time-entry-calc.ts'
import {
	insertRowsInChunks,
	MAX_IN_CHUNK,
	queryInChunks,
} from './chunked-in.ts'
import { scopeToScopes } from './staff-auth.ts'

/**
 * Durable Object SQLite refuses a statement with more than 100 bound
 * parameters, libsql does not. This wraps the libsql client so the same limit
 * applies in tests, then drives the code paths that take data-sized lists.
 */
const DO_PARAMETER_LIMIT = 100

function limitBoundParameters(client: Client): Client {
	const check = (stmt: unknown) => {
		const args = (stmt as { args?: unknown })?.args
		const count = Array.isArray(args)
			? args.length
			: args && typeof args === 'object'
				? Object.keys(args).length
				: 0
		if (count > DO_PARAMETER_LIMIT) {
			throw new Error(`too many SQL variables (${count})`)
		}
	}
	const wrapTx = <T extends object>(tx: T): T =>
		new Proxy(tx, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (prop === 'execute') {
					return (stmt: unknown) => {
						check(stmt)
						return (value as (s: unknown) => unknown).call(target, stmt)
					}
				}
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
	return new Proxy(client, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver)
			if (prop === 'execute') {
				return (stmt: unknown) => {
					check(stmt)
					return (value as (s: unknown) => unknown).call(target, stmt)
				}
			}
			if (prop === 'batch') {
				return (stmts: unknown[], ...rest: unknown[]) => {
					for (const stmt of stmts) check(stmt)
					return (value as (...a: unknown[]) => unknown).call(
						target,
						stmts,
						...rest,
					)
				}
			}
			if (prop === 'transaction') {
				return async (...a: unknown[]) =>
					wrapTx(await (value as (...b: unknown[]) => Promise<object>)(...a))
			}
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

const ids = (count: number, prefix = 'id') =>
	Array.from({ length: count }, (_, i) => `${prefix}-${i}`)

let dir: string
let client: Client
let db: TenantDatabase

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-params-'))
	client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
	db = drizzle(limitBoundParameters(client), { schema }) as TenantDatabase
	await applyTenantMigrations(db, 'bound-params')
})

afterAll(() => {
	client.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

describe('the Durable Object bound-parameter limit', () => {
	it('is enforced by the wrapper: a raw 150-value IN list is rejected', async () => {
		const error = await db
			.select()
			.from(staffMembers)
			.where(inArray(staffMembers.id, ids(150)))
			.then(
				() => null,
				(caught: unknown) => caught,
			)
		// Drizzle wraps the driver error and keeps it as the cause.
		expect(String((error as { cause?: unknown } | null)?.cause)).toMatch(
			/too many SQL variables/,
		)
	})

	it('keeps a 150-scope staff filter to one bound parameter', async () => {
		const access = scopeToScopes({ scopeIds: ids(150, 'scope') })
		const where = access.where(schema.staffScopeAssignments.scopeId)
		expect(where).toBeDefined()
		await expect(
			db.select().from(schema.staffScopeAssignments).where(where),
		).resolves.toEqual([])
	})

	it('loads break rows for 250 time entries', async () => {
		await expect(loadBreaks(db, ids(250, 'entry'))).resolves.toEqual(new Map())
		await expect(
			queryInChunks(ids(250, 'entry'), (chunk) =>
				db.select().from(timeBreaks).where(inArray(timeBreaks.entryId, chunk)),
			),
		).resolves.toEqual([])
	})

	it('inserts a wide row set in statements under the limit', async () => {
		const rows = ids(250, 'recording').map((recordingKey) => ({ recordingKey }))
		await insertRowsInChunks(voiceRecordingDeletions, rows, (part) =>
			db.insert(voiceRecordingDeletions).values(part),
		)
		const stored = await db.select().from(voiceRecordingDeletions)
		expect(stored).toHaveLength(250)
	})

	it('never splits below the chunk size constant', () => {
		expect(MAX_IN_CHUNK).toBeLessThanOrEqual(DO_PARAMETER_LIMIT)
	})
})
