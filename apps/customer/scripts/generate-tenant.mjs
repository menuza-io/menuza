#!/usr/bin/env node
/**
 * Prepares a white-label build of the customer app from `tenants/<slug>.json`.
 *
 * `app.config.ts` reads the tenant file itself (name, bundle ids, endpoints,
 * site binding) when `CUSTOMER_TENANT=<slug>` is set. This script adds what
 * needs the network: the tenant's published site icon, written to
 * `tenants/generated/<slug>/icon.png` (1024 px, App Store and Play) and
 * `adaptive-icon.png` (the Android adaptive-icon foreground). Without them the
 * build uses the committed placeholders in `assets/`.
 *
 * Every run starts by deleting `tenants/generated/<slug>/`, so a tenant whose
 * icon download fails can never ship a stale icon from an earlier run.
 *
 * Resizing uses `sips` on macOS or ImageMagick (`magick`) elsewhere; the
 * adaptive icon needs ImageMagick everywhere. Without the tool the placeholder
 * stays and the build continues. No secrets pass through here.
 *
 * Usage:
 *   node scripts/generate-tenant.mjs --tenant acme [--icon-source <url|path>]
 *                                    [--no-icon] [--no-api]
 */
import { execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const LOCAL_HOST = /^(localhost|127\.|10\.0\.2\.2|\[::1\])/
/** Share of the adaptive-icon canvas the artwork may use (its safe zone). */
const ADAPTIVE_SCALE = 0.6

function parseArgs(argv) {
	const args = { flags: new Set() }
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]
		if (!value.startsWith('--')) continue
		const [name, inline] = value.slice(2).split('=')
		if (['no-icon', 'no-api'].includes(name)) {
			args.flags.add(name)
			continue
		}
		const argument = inline ?? argv[index + 1]
		if (!argument || argument.startsWith('--')) {
			fail(`--${name} requires a value`)
		}
		args[name] = argument
		if (inline === undefined) index += 1
	}
	return args
}

function fail(message) {
	console.error(`✖ ${message}`)
	process.exit(1)
}

function log(message) {
	console.log(`• ${message}`)
}

function loadTenant(slug) {
	if (!TENANT_SLUG.test(slug)) fail(`Not a tenant slug: ${slug}`)
	const file = `${slug}.json`
	const path = join(APP_ROOT, 'tenants', file)
	if (!existsSync(path))
		fail(`No tenant config at apps/customer/tenants/${file}`)
	let config
	try {
		config = JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(`tenants/${file} is not valid JSON: ${error.message}`)
	}
	for (const key of ['displayName', 'bundleId', 'appUrl', 'tenantApiUs']) {
		if (typeof config[key] !== 'string' || config[key].trim() === '') {
			fail(`tenants/${file} is missing "${key}"`)
		}
	}
	if (!config.site?.slug && !config.site?.host) {
		fail(
			`tenants/${file} needs site.slug or site.host: a white-label app is bound to one tenant`,
		)
	}
	return { config, file }
}

function appOrigin(config) {
	const useTls =
		typeof config.useTls === 'boolean'
			? config.useTls
			: !LOCAL_HOST.test(config.appUrl)
	return `${useTls ? 'https' : 'http'}://${config.appUrl}`
}

/** The published branding, so the icon matches what the app shows. */
async function fetchOrganization(config) {
	const site = config.site ?? {}
	const params = new URLSearchParams()
	if (site.host) params.set('host', site.host)
	else params.set('slug', site.slug)
	const url = `${appOrigin(config)}/resources/sites?${params}`
	try {
		const response = await fetch(url, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) {
			log(
				`No published site for this tenant yet (${response.status} from ${url})`,
			)
			return null
		}
		return await response.json()
	} catch (error) {
		log(`Could not reach ${url} (${error.message}); continuing without it`)
		return null
	}
}

function have(command, versionFlag) {
	try {
		execFileSync(command, [versionFlag], { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

function resizeSquare(source, destination) {
	if (process.platform === 'darwin' && have('sips', '--help')) {
		execFileSync(
			'sips',
			[
				'-s',
				'format',
				'png',
				'-z',
				'1024',
				'1024',
				source,
				'--out',
				destination,
			],
			{ stdio: 'pipe' },
		)
		return
	}
	execFileSync(
		'magick',
		[
			source,
			'-resize',
			'1024x1024',
			'-background',
			'none',
			'-gravity',
			'center',
			'-extent',
			'1024x1024',
			`PNG32:${destination}`,
		],
		{ stdio: 'pipe' },
	)
}

function composeAdaptive(source, destination) {
	const inner = Math.round(1024 * ADAPTIVE_SCALE)
	execFileSync(
		'magick',
		[
			'-size',
			'1024x1024',
			'xc:none',
			'(',
			source,
			'-resize',
			`${inner}x${inner}`,
			')',
			'-gravity',
			'center',
			'-composite',
			'-strip',
			`PNG32:${destination}`,
		],
		{ stdio: 'pipe' },
	)
}

async function downloadIcon(source, outDir) {
	if (!/^https?:/.test(source)) {
		return existsSync(source) ? source : null
	}
	const response = await fetch(source, { signal: AbortSignal.timeout(15_000) })
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	const path = join(outDir, 'icon-source')
	writeFileSync(path, Buffer.from(await response.arrayBuffer()))
	return path
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const slug = args.tenant ?? process.env.CUSTOMER_TENANT
	if (!slug) fail('Pass --tenant <slug> (or set CUSTOMER_TENANT)')

	const { config, file } = loadTenant(slug)
	const outDir = join(APP_ROOT, 'tenants/generated', slug)
	rmSync(outDir, { recursive: true, force: true })

	const organization = args.flags.has('no-api')
		? null
		: await fetchOrganization(config)
	if (organization?.name && organization.name !== config.displayName) {
		log(
			`Note: the published site is named "${organization.name}" but tenants/${file} says "${config.displayName}". The store name comes from the file, the in-app name from the site.`,
		)
	}

	const icons = []
	const iconSource =
		args['icon-source'] ??
		(organization?.siteIcon?.original
			? `${appOrigin(config)}${organization.siteIcon.original}`
			: null)

	if (args.flags.has('no-icon')) {
		log('Icon generation disabled (--no-icon); using the placeholder')
	} else if (!iconSource) {
		log('No site icon published; using the placeholder')
	} else {
		mkdirSync(outDir, { recursive: true })
		let local = null
		try {
			local = await downloadIcon(iconSource, outDir)
		} catch (error) {
			log(`Icon download failed (${error.message}); using the placeholder`)
		}
		if (!local && !/^https?:/.test(iconSource)) {
			log(`Icon source not found: ${iconSource}; using the placeholder`)
		}
		if (local) {
			try {
				resizeSquare(local, join(outDir, 'icon.png'))
				icons.push('icon.png')
			} catch (error) {
				rmSync(join(outDir, 'icon.png'), { force: true })
				log(
					`Could not resize the icon (${error.message}); using the placeholder`,
				)
			}
			if (have('magick', '-version')) {
				try {
					composeAdaptive(local, join(outDir, 'adaptive-icon.png'))
					icons.push('adaptive-icon.png')
				} catch (error) {
					rmSync(join(outDir, 'adaptive-icon.png'), { force: true })
					log(`Could not compose the Android icon (${error.message})`)
				}
			} else {
				log(
					'ImageMagick (magick) not found; the Android icon keeps the placeholder',
				)
			}
			rmSync(join(outDir, 'icon-source'), { force: true })
		}
	}

	console.log('')
	console.log(`✓ ${config.displayName} (${slug})`)
	console.log(`  bundle id   ${config.bundleId}`)
	console.log(`  package     ${config.androidPackage ?? config.bundleId}`)
	console.log(`  version     ${config.marketingVersion ?? '1.0.0'}`)
	console.log(
		`  site        ${config.site.origin ?? config.site.host ?? config.site.slug}`,
	)
	console.log(
		`  icons       ${icons.length ? icons.map((name) => `tenants/generated/${slug}/${name}`).join(', ') : 'placeholders'}`,
	)
	console.log('')
	console.log(
		`Build with CUSTOMER_TENANT=${slug} (and CUSTOMER_BUILD_NUMBER=<n>), for example: CUSTOMER_TENANT=${slug} npx expo prebuild`,
	)
}

main().catch((error) => {
	fail(error.stack ?? error.message)
})
