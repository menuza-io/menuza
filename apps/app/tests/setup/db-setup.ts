import path from 'node:path'
import fsExtra from 'fs-extra'
import { forget } from '@epic-web/remember'
import { afterAll, beforeAll } from 'vitest'
import { BASE_DATABASE_PATH } from './database-paths.ts'

const workerId =
	process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
const databaseFile = `./tests/database/data.${workerId}.db`
const databasePath = path.join(process.cwd(), databaseFile)

async function seedWorkerDatabase() {
	await fsExtra.remove(databasePath).catch(() => {})
	await fsExtra.copyFile(BASE_DATABASE_PATH, databasePath)
	const copied = await fsExtra.stat(databasePath)
	const base = await fsExtra.stat(BASE_DATABASE_PATH)
	if (copied.size < base.size / 2) {
		throw new Error(
			`Worker DB copy failed (${databasePath}: ${copied.size} bytes, expected ~${base.size})`,
		)
	}

	if (fsExtra.existsSync(`${BASE_DATABASE_PATH}-wal`)) {
		await fsExtra.copyFile(`${BASE_DATABASE_PATH}-wal`, `${databasePath}-wal`)
	} else {
		await fsExtra.remove(`${databasePath}-wal`).catch(() => {})
	}

	if (fsExtra.existsSync(`${BASE_DATABASE_PATH}-shm`)) {
		await fsExtra.copyFile(`${BASE_DATABASE_PATH}-shm`, `${databasePath}-shm`)
	} else {
		await fsExtra.remove(`${databasePath}-shm`).catch(() => {})
	}
}

// Copy before any test file imports `@repo/database` (imports run after setup files).
await seedWorkerDatabase()

beforeAll(async () => {
	// Vitest may clear worker env between setup evaluation and hooks; re-apply.
	process.env.VITEST = 'true'
	process.env.DATABASE_URL = `file:${databasePath}`
	forget('libsql')
	forget('drizzle')
	const { resetSqliteClientForTests, sqliteClient } =
		await import('@repo/database')
	resetSqliteClientForTests()
	await sqliteClient.execute('PRAGMA busy_timeout = 30000')
})

afterAll(async () => {
	const { sqliteClient } = await import('@repo/database')
	await sqliteClient.close()
	await fsExtra.remove(databasePath)
	await fsExtra.remove(`${databasePath}-wal`).catch(() => {})
	await fsExtra.remove(`${databasePath}-shm`).catch(() => {})
})
