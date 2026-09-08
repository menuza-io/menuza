import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'drizzle-kit'

const packageDir = path.dirname(fileURLToPath(import.meta.url))

function sqliteUrl() {
	const raw = process.env.DATABASE_URL?.replace(/\?.*$/, '')
	if (!raw) return `file:${path.join(packageDir, 'db/data.db')}`
	const filePath = raw.replace(/^file:/, '')
	if (path.isAbsolute(filePath)) return `file:${filePath}`
	return `file:${path.resolve(packageDir, filePath)}`
}

/**
 * Drizzle Kit config for the US control-plane SQLite database.
 * Run drizzle-kit from this package directory so schema/out stay relative.
 *
 * Intentionally uses process.env, not varlock/auto-load: drizzle-kit is invoked
 * directly (studio, generate, push), not via `varlock run`.
 */
export default defineConfig({
	schema: './src/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: sqliteUrl(),
	},
})
