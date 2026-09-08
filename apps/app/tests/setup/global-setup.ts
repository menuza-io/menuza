import path from 'node:path'
import { execaCommand } from 'execa'
import fsExtra from 'fs-extra'
import './init-env.ts'
import 'varlock/auto-load'

import '#app/utils/cache.server.ts'

export const BASE_DATABASE_PATH = path.join(
	process.cwd(),
	`./tests/database/base.db`,
)

const CONTROL_PLANE_SCHEMA = path.resolve(
	process.cwd(),
	'../../packages/database/src/schema.ts',
)
const CONTROL_PLANE_MIGRATIONS = path.resolve(
	process.cwd(),
	'../../packages/database/drizzle',
)
const CONTROL_PLANE_DATABASE = path.resolve(
	process.cwd(),
	'../../packages/database',
)
const VARLOCK = path.resolve(process.cwd(), '../../node_modules/.bin/varlock')

async function latestSourceMtime() {
	const schemaStat = await fsExtra.stat(CONTROL_PLANE_SCHEMA)
	let latest = schemaStat.mtimeMs
	const entries = await fsExtra.readdir(CONTROL_PLANE_MIGRATIONS, {
		withFileTypes: true,
	})
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.sql')) continue
		const stat = await fsExtra.stat(
			path.join(CONTROL_PLANE_MIGRATIONS, entry.name),
		)
		if (stat.mtimeMs > latest) latest = stat.mtimeMs
	}
	const metaJournal = path.join(CONTROL_PLANE_MIGRATIONS, 'meta/_journal.json')
	if (await fsExtra.pathExists(metaJournal)) {
		const stat = await fsExtra.stat(metaJournal)
		if (stat.mtimeMs > latest) latest = stat.mtimeMs
	}
	return latest
}

export async function setup() {
	const databaseExists = await fsExtra.pathExists(BASE_DATABASE_PATH)

	if (databaseExists) {
		const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH))
			.mtimeMs
		if (databaseLastModifiedAt > (await latestSourceMtime())) {
			return
		}
		await fsExtra.remove(BASE_DATABASE_PATH)
		await fsExtra.remove(`${BASE_DATABASE_PATH}-wal`).catch(() => {})
		await fsExtra.remove(`${BASE_DATABASE_PATH}-shm`).catch(() => {})
	}

	await execaCommand(`${VARLOCK} run -- tsx src/migrate.ts`, {
		cwd: CONTROL_PLANE_DATABASE,
		stdio: 'inherit',
		env: {
			...process.env,
			DATABASE_URL: `file:${BASE_DATABASE_PATH}`,
		},
	})
}
