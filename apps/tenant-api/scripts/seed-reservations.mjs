/**
 * Seeds a complete demo venue for the Reservations module:
 *
 *   npm run seed:reservations -w tenant-api -- <org-slug>
 *
 * Turns on every `reservations.*` flag for the organization, ensures the
 * organization and its primary location exist in the control plane (`acme` in
 * `us` / `America/New_York`, `riyadh-grill` in `ksa` / `Asia/Riyadh`),
 * provisions the regional tenant database, and idempotently seeds location
 * settings, 3 areas, 12 tables, 2 combinations, 3 services, 4 turn-time
 * brackets, pacing rules, 1 experience, 8 guests, today's reservations across
 * statuses, and waitlist entries.
 *
 * Local development only; refuses to run in production.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const slug = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
if (!slug) {
	console.error('Usage: seed-reservations <org-slug>')
	process.exit(1)
}
if (process.env.NODE_ENV === 'production') {
	console.error(
		'seed-reservations is for local development and refuses to run in production.',
	)
	process.exit(1)
}

const result = spawnSync(
	'../../node_modules/.bin/varlock',
	['run', '--', 'tsx', 'scripts/seed-reservations.ts', ...process.argv.slice(2)],
	{ stdio: 'inherit' },
)
if (result.status !== 0) {
	process.exit(result.status ?? 1)
}

if (slug === 'riyadh-grill' && !process.env.TENANT_DB_DIR) {
	const ksaDir = path.resolve(
		import.meta.dirname,
		'../../../packages/database/db/ksa',
	)
	const ksaResult = spawnSync(
		'../../node_modules/.bin/varlock',
		[
			'run',
			'--',
			'tsx',
			'scripts/seed-reservations.ts',
			...process.argv.slice(2),
		],
		{
			stdio: 'inherit',
			env: { ...process.env, TENANT_DB_DIR: ksaDir },
		},
	)
	if (ksaResult.status !== 0) {
		process.exit(ksaResult.status ?? 1)
	}
}
