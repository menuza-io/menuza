/**
 * Local development launcher for the Admin server.
 *
 * In production App and Admin are bound to the same D1 database, so an
 * operator signed in to App is signed in to Admin too. Locally App runs on
 * Wrangler with its own D1 file, while this Node server would otherwise read
 * `packages/database/db/data.db`, so App sessions and platform roles do not
 * exist here and "Super Admin" lands on a 404.
 *
 * This points Admin at App's local D1 file instead. It is only used by the
 * `dev*` scripts; `start` and the Cloudflare deploy never run it. Set
 * DATABASE_URL yourself, or ADMIN_DEV_SHARE_APP_DB=false (the Playwright
 * server does), to keep Admin on packages/database/db/data.db.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appD1Dir = path.resolve(
	here,
	'../../app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
)

/** App's local D1 file: the one that actually holds the control-plane schema. */
function findAppD1File() {
	if (!existsSync(appD1Dir)) return null
	const candidates = readdirSync(appD1Dir)
		.filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
		.map((name) => path.join(appD1Dir, name))
		.sort((a, b) => statSync(b).size - statSync(a).size)
	for (const file of candidates) {
		let db
		try {
			db = new DatabaseSync(file, { readOnly: true })
			const row = db
				.prepare(
					"SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'Session'",
				)
				.get()
			if (row) return file
		} catch {
			// Not a readable control-plane database; try the next one.
		} finally {
			db?.close()
		}
	}
	return null
}

const env = { ...process.env }
if (env.ADMIN_DEV_SHARE_APP_DB === 'false') {
	// Keep the default database (E2E tests seed it from their own process).
} else if (env.DATABASE_URL) {
	console.info('[admin dev] Using DATABASE_URL from the environment.')
} else {
	const file = findAppD1File()
	if (file) {
		env.DATABASE_URL = `file:${file}`
		console.info(
			`[admin dev] Sharing App's local D1 database: ${path.relative(process.cwd(), file)}`,
		)
	} else {
		console.warn(
			"[admin dev] App's local D1 database was not found (start App once with `npm run dev:app`). " +
				'Falling back to packages/database/db/data.db; App sessions will not work in Admin.',
		)
	}
}

const child = spawn(
	process.execPath,
	['--conditions', 'development', 'index.ts', ...process.argv.slice(2)],
	{ stdio: 'inherit', env },
)
child.on('exit', (code, signal) => {
	if (signal) process.kill(process.pid, signal)
	else process.exit(code ?? 0)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => child.kill(signal))
}
