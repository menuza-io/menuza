#!/usr/bin/env node
/**
 * Lists tenant app configs, for the release workflow's matrix.
 *
 * Usage:
 *   node scripts/list-tenants.mjs --json [--only <slug>] [--release-only]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TENANTS_DIR = join(APP_ROOT, 'tenants')

function parseArgs(argv) {
	const args = { flags: new Set() }
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]
		if (!value.startsWith('--')) continue
		const [name, inline] = value.slice(2).split('=')
		if (['json', 'release-only'].includes(name)) {
			args.flags.add(name)
			continue
		}
		args[name] = inline ?? argv[index + 1]
		if (inline === undefined) index += 1
	}
	return args
}

const args = parseArgs(process.argv.slice(2))
const tenants = readdirSync(TENANTS_DIR)
	.filter((file) => file.endsWith('.json'))
	.map((file) => {
		const config = JSON.parse(readFileSync(join(TENANTS_DIR, file), 'utf8'))
		// The filename is a valid slug source too, so the environment fallback
		// must use the resolved slug rather than the raw config value.
		const slug = config.slug ?? file.replace(/\.json$/, '')
		return {
			slug,
			displayName: config.displayName ?? '',
			environment: config.environment ?? `tenant-${slug}`,
			release: config.release === true,
		}
	})
	.filter((tenant) => (args.flags.has('release-only') ? tenant.release : true))
	.filter((tenant) => (args.only ? tenant.slug === args.only : true))
	.sort((a, b) => a.slug.localeCompare(b.slug))

if (args.flags.has('json')) {
	// Objects (not bare slugs) so the release workflow can honour a tenant's
	// custom GitHub environment.
	console.log(
		JSON.stringify(
			tenants.map((tenant) => ({
				slug: tenant.slug,
				environment: tenant.environment,
			})),
		),
	)
} else {
	for (const tenant of tenants) {
		console.log(
			`${tenant.slug.padEnd(20)} ${tenant.release ? 'release' : 'build-only'}  ${tenant.displayName}  [${tenant.environment}]`,
		)
	}
}
