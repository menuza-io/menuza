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
 * the upstream sync; 0016..0018 are appended deltas. A database that stopped at
 * 0015 and then migrates forward must end with exactly the schema a fresh
 * database gets from the whole chain.
 */
const folder = path.join(
	path.dirname(path.dirname(fileURLToPath(import.meta.url))),
	'drizzle',
)
const SHIPPED_ENTRIES = 16

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
	it('a shipped-state database migrated forward equals a fresh one', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-chain-'))
		try {
			// Folder truncated to the shipped migrations.
			const old = path.join(dir, 'old')
			fs.cpSync(folder, old, { recursive: true })
			const journalPath = path.join(old, 'meta', '_journal.json')
			const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
			expect(journal.entries.length).toBeGreaterThan(SHIPPED_ENTRIES)
			journal.entries = journal.entries.slice(0, SHIPPED_ENTRIES)
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
			expect(a).toEqual(await schemaOf(freshPath))
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})
