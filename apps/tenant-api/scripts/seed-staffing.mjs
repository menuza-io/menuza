/**
 * Seeds a complete demo workplace for the Staff module, in order:
 *
 *   npm run seed:staffing -w tenant-api -- <org-slug>
 *
 * It turns on every `staffing.*` flag for the organization, then runs the
 * roster, time clock, schedule and history seeds (a dozen people, positions,
 * a published week with open shifts, closed time cards including an overtime
 * week, an open shift on the clock, two applicants and onboarding checklists).
 * Each step is idempotent, so running it twice changes nothing. Local
 * development only; the steps refuse to run in production.
 */
import { spawnSync } from 'node:child_process'

const slug = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
if (!slug) {
	console.error('Usage: seed-staffing <org-slug>')
	process.exit(1)
}
if (process.env.NODE_ENV === 'production') {
	console.error('seed-staffing is for local development.')
	process.exit(1)
}

const STEPS = [
	'seed-staff',
	'seed-timeclock',
	'seed-schedule',
	'seed-staffing-history',
]
for (const step of STEPS) {
	console.info(`\n> ${step}`)
	const result = spawnSync(
		'../../node_modules/.bin/varlock',
		['run', '--', 'tsx', `scripts/${step}.ts`, slug, '--enable'],
		{ stdio: 'inherit' },
	)
	if (result.status !== 0) process.exit(result.status ?? 1)
}
