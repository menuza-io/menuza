import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'

/**
 * Migrations 0000..0015 shipped (and are applied to deployed databases) before
 * the upstream sync; 0016..0018 are the upstream deltas appended by the sync,
 * and 0019 is the whole reservations module in one migration. A database that stopped at any
 * shipped state and then migrates forward must end with exactly the schema a
 * fresh database gets from the whole chain.
 *
 * Drizzle's migrator applies only the journal entries whose `when` is greater
 * than the `created_at` of the last migration a database applied. An entry
 * appended with an older `when` would be skipped silently on every database
 * that already ran the entries before it, so the journal order is asserted too.
 */
const folder = path.join(
	path.dirname(path.dirname(fileURLToPath(import.meta.url))),
	'drizzle',
)
/**
 * Journal entries that had shipped at each point: 16 is the state before the
 * upstream sync, 19 the state of `main` when the reservations migrations were
 * appended (the last entry is `0018_customer_subscription_confirmation_sent`).
 */
const SHIPPED_STATES = [16, 19]
/** `when` of `0018_customer_subscription_confirmation_sent`, the last entry on main. */
const MAIN_LAST_WHEN = 1792532036810
/** The one early entry whose `when` is older than its predecessor's. */
const HISTORIC_UNORDERED_IDX = 4
/** Index of the first reservations migration (`0019_reservations`). */
const FIRST_RESERVATIONS_IDX = 19

async function schemaOf(dbPath: string) {
	const client = createClient({ url: `file:${dbPath}` })
	const objects = await client.execute(
		"select type, name from sqlite_master where name not like 'sqlite_%' and name <> '__drizzle_migrations' order by type, name",
	)
	const out: Record<string, unknown> = {}
	for (const row of objects.rows) {
		const name = String(row.name)
		if (row.type === 'table') {
			const info = await client.execute(`pragma table_info('${name}')`)
			out[`table:${name}`] = info.rows.map((r) => [
				r.name,
				r.type,
				r.notnull,
				r.dflt_value,
				r.pk,
			])
		} else if (row.type === 'index') {
			const info = await client.execute(`pragma index_xinfo('${name}')`)
			out[`index:${name}`] = info.rows.map((r) => [r.name, r.desc])
		}
	}
	client.close()
	return out
}

describe('tenant migration chain', () => {
	for (const shipped of SHIPPED_STATES) {
		it(`a database shipped at ${shipped} entries, migrated forward, equals a fresh one`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-chain-'))
			try {
				// Folder truncated to the shipped migrations.
				const old = path.join(dir, 'old')
				fs.cpSync(folder, old, { recursive: true })
				const journalPath = path.join(old, 'meta', '_journal.json')
				const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
				expect(journal.entries.length).toBeGreaterThan(shipped)
				journal.entries = journal.entries.slice(0, shipped)
				fs.writeFileSync(journalPath, JSON.stringify(journal))

				const forwardPath = path.join(dir, 'forward.db')
				const freshPath = path.join(dir, 'fresh.db')
				const forward = createClient({ url: `file:${forwardPath}` })
				await migrate(drizzle(forward), { migrationsFolder: old })
				await migrate(drizzle(forward), { migrationsFolder: folder })
				forward.close()
				const fresh = createClient({ url: `file:${freshPath}` })
				await migrate(drizzle(fresh), { migrationsFolder: folder })
				fresh.close()

				const a = await schemaOf(forwardPath)
				expect(a['table:person_erasure_log']).toBeDefined()
				expect(a['table:rsv_reservations']).toBeDefined()
				expect(a['table:rsv_payments']).toBeDefined()
				expect(a).toEqual(await schemaOf(freshPath))
			} finally {
				fs.rmSync(dir, { recursive: true, force: true })
			}
			// Two full migrations of the whole chain: slow on CI runners with coverage.
		}, 30_000)
	}

	it('keeps the journal strictly increasing, and the reservations entries after main', () => {
		const journal = JSON.parse(
			fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8'),
		) as { entries: Array<{ idx: number; when: number; tag: string }> }
		const { entries } = journal
		entries.forEach((entry, position) => {
			expect(entry.idx).toBe(position)
			expect(entry.tag.startsWith(String(position).padStart(4, '0'))).toBe(true)
			expect(fs.existsSync(path.join(folder, `${entry.tag}.sql`))).toBe(true)
			expect(
				fs.existsSync(
					path.join(
						folder,
						'meta',
						`${String(position).padStart(4, '0')}_snapshot.json`,
					),
				),
			).toBe(true)
			// Entry 4 predates entry 3 by history (shipped and applied long ago, so
			// no database depends on its order); everything after it must increase.
			if (position > HISTORIC_UNORDERED_IDX) {
				expect(entry.when).toBeGreaterThan(entries[position - 1]!.when)
			}
		})
		expect(entries[FIRST_RESERVATIONS_IDX - 1]!.when).toBe(MAIN_LAST_WHEN)
		for (const entry of entries.slice(FIRST_RESERVATIONS_IDX)) {
			expect(entry.when).toBeGreaterThan(MAIN_LAST_WHEN)
		}
	})

	it('chains every snapshot to the previous one', () => {
		const meta = path.join(folder, 'meta')
		const snapshots = fs
			.readdirSync(meta)
			.filter((name) => name.endsWith('_snapshot.json'))
			.sort()
			.map((name) => JSON.parse(fs.readFileSync(path.join(meta, name), 'utf8')))
		snapshots.forEach((snapshot, position) => {
			if (position === 0) return
			expect(snapshot.prevId).toBe(snapshots[position - 1].id)
		})
		expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(
			snapshots.length,
		)
	})
})
