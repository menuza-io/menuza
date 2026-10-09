#!/usr/bin/env -S npx tsx
/**
 * Backfills store coordinates for locations whose address has no real lat/lng
 * (missing or the 0,0 placeholder). Radius delivery zones are centred on the
 * store, so without coordinates delivery quotes answer
 * `unavailable/store_location_missing`.
 *
 * Reads and writes the App's D1 through `wrangler d1 execute`, so the same
 * script works for local dev and remote environments:
 *
 *   npm run locations:backfill-coordinates -w app               # local D1, dev fixtures OK
 *   npm run locations:backfill-coordinates -w app -- --dry-run
 *   GOOGLE_MAPS_API_KEY=… npm run locations:backfill-coordinates -w app -- --remote [--env staging]
 *
 * Options: --local (default) | --remote, --env <name>, --org <slug>, --dry-run.
 * Remote runs require GOOGLE_MAPS_API_KEY (dev fixtures are local-only).
 * Afterwards, republish or purge the org site cache so Sites picks up the new
 * coordinates; the regional tenant-api reads order context fresh.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevGeocoder, createGoogleGeocoder } from '@repo/geo'
import { ensureLocationCoordinates } from '../app/utils/location/geocoder.server.ts'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv: string[]) {
	const options = {
		remote: false,
		env: null as string | null,
		org: null as string | null,
		dryRun: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--remote') options.remote = true
		else if (arg === '--local') options.remote = false
		else if (arg === '--dry-run') options.dryRun = true
		else if (arg === '--env') options.env = argv[++i] ?? null
		else if (arg === '--org') options.org = argv[++i] ?? null
		else throw new Error(`Unknown argument: ${arg}`)
	}
	return options
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function d1(options: ReturnType<typeof parseArgs>, sql: string): unknown[] {
	const args = [
		'wrangler',
		'd1',
		'execute',
		'DB',
		options.remote ? '--remote' : '--local',
		'--json',
		'--command',
		sql,
	]
	if (options.env) args.push('--env', options.env)
	const output = execFileSync('npx', args, {
		cwd: appDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		env: { ...process.env, CI: 'true' },
	})
	const parsed = JSON.parse(output) as Array<{ results?: unknown[] }>
	return parsed.flatMap((entry) => entry.results ?? [])
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim()
	if (options.remote && !apiKey) {
		throw new Error('GOOGLE_MAPS_API_KEY is required for --remote backfills')
	}
	const geocoder = apiKey
		? createGoogleGeocoder({ apiKey })
		: createDevGeocoder()
	console.log(
		`Backfilling store coordinates (${options.remote ? 'remote' : 'local'} D1, ${geocoder.name} geocoder${options.dryRun ? ', dry run' : ''})`,
	)

	const orgFilter = options.org ? ` AND o.slug = ${sqlString(options.org)}` : ''
	const rows = d1(
		options,
		`SELECT l.id AS id, l.name AS name, o.slug AS org, l.address AS address
		 FROM OrganizationLocation l JOIN Organization o ON o.id = l.organizationId
		 WHERE l.address IS NOT NULL${orgFilter}`,
	) as Array<{ id: string; name: string; org: string; address: string }>

	let updated = 0
	for (const row of rows) {
		const result = await ensureLocationCoordinates(row.address, geocoder)
		const label = `${row.org}/${row.id}`
		if (result.status === 'unchanged') continue
		if (result.status !== 'geocoded' || !result.address) {
			console.log(`  ${label}: ${result.status}`)
			continue
		}
		console.log(`  ${label}: ${result.lat}, ${result.lng}`)
		if (!options.dryRun) {
			d1(
				options,
				`UPDATE OrganizationLocation SET address = ${sqlString(result.address)}, updatedAt = ${Date.now()} WHERE id = ${sqlString(row.id)}`,
			)
			updated++
		}
	}
	console.log(`Done: ${updated} location(s) updated of ${rows.length} scanned.`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})
