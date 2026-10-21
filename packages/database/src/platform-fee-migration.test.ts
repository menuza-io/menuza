/// <reference types="vitest/globals" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'

const drizzleDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle',
)

test('0025 seeds the system platform fee row once (250 bp) and is idempotent', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-fee-'))
	const client = createClient({ url: `file:${path.join(dir, 'test.db')}` })
	try {
		await migrate(drizzle(client), { migrationsFolder: drizzleDir })
		const select = `SELECT "value", "level", "organizationId" FROM "ConfigFlag" WHERE "key" = 'reservations.platform_fee_bp'`
		const first = await client.execute(select)
		expect(first.rows).toHaveLength(1)
		expect(first.rows[0]).toMatchObject({
			value: '250',
			level: 'system',
			organizationId: null,
		})

		const sqlText = fs.readFileSync(
			path.join(drizzleDir, '0025_reservations.sql'),
			'utf8',
		)
		for (const statement of sqlText.split('--> statement-breakpoint')) {
			await client.execute(statement)
		}
		expect((await client.execute(select)).rows).toHaveLength(1)
	} finally {
		client.close()
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
