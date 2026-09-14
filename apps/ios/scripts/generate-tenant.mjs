#!/usr/bin/env node
/**
 * Turns `tenants/<slug>.json` into a build-time configuration:
 *
 *   1. `Config/Generated/Tenant.xcconfig` — the tenant's bundle id, app name,
 *      endpoints, site binding, and version numbers (included by
 *      `Config/Shared.xcconfig`, so it wins over local-dev defaults).
 *   2. `Sources/TenantApp/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
 *      — the tenant's published site icon, resized to the 1024px icon the App
 *      Store requires. Falls back to the committed placeholder when the org has
 *      no icon yet.
 *
 * No secrets pass through here: App Store Connect keys live in the tenant's
 * GitHub environment (see docs/app-store-release.md).
 *
 * Usage:
 *   node scripts/generate-tenant.mjs --tenant acme [--build-number 123]
 *                                    [--icon-source <url|path>] [--no-icon]
 *                                    [--no-api] [--out <path>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICON_DIR = join(
	APP_ROOT,
	'Sources/TenantApp/Resources/Assets.xcassets/AppIcon.appiconset',
)
const ICON_PATH = join(ICON_DIR, 'AppIcon-1024.png')

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
		args[name] = inline ?? argv[index + 1]
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

/** xcconfig treats `//` as a comment, so URLs are escaped with `$()`. */
function escapeXcconfig(value) {
	return String(value).replace(/\/\//g, '/$()/')
}

function requireString(config, key, file) {
	const value = config[key]
	if (typeof value !== 'string' || value.trim() === '') {
		fail(`tenants/${file} is missing "${key}"`)
	}
	return value.trim()
}

function loadTenant(slug) {
	const file = `${slug}.json`
	const path = join(APP_ROOT, 'tenants', file)
	if (!existsSync(path)) {
		fail(`No tenant config at apps/ios/tenants/${file}`)
	}
	let config
	try {
		config = JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(`tenants/${file} is not valid JSON: ${error.message}`)
	}
	return { config, file }
}

/**
 * Reads the tenant's published branding so the icon and app name match what the
 * app will render at runtime.
 */
async function fetchOrganization(config, { useApi }) {
	if (!useApi) return null
	const scheme = /^localhost|^127\./.test(config.appUrl) ? 'http' : 'https'
	const site = config.site ?? {}
	const params = new URLSearchParams()
	if (site.host) params.set('host', site.host)
	else if (site.slug) params.set('slug', site.slug)
	if (!params.size) return null

	const url = `${scheme}://${config.appUrl}/resources/sites?${params}`
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
		log(
			`Could not reach ${url} (${error.message}); continuing without API data`,
		)
		return null
	}
}

function resizeIcon(source, destination) {
	const isMac = process.platform === 'darwin'
	try {
		if (isMac) {
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
				{
					stdio: 'pipe',
				},
			)
		} else {
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
					destination,
				],
				{ stdio: 'pipe' },
			)
		}
		return true
	} catch (error) {
		const tool = isMac ? 'sips' : 'magick (ImageMagick)'
		log(`Could not resize the icon with ${tool}: ${error.message}`)
		return false
	}
}

async function resolveIcon(config, organization, { iconSource, useIcon }) {
	if (!useIcon) return { applied: false, reason: 'icon generation disabled' }

	const source =
		iconSource ??
		(organization?.siteIcon?.original
			? `${/^localhost|^127\./.test(config.appUrl) ? 'http' : 'https'}://${config.appUrl}${organization.siteIcon.original}`
			: null)

	if (!source) {
		return {
			applied: false,
			reason: 'no site icon published; keeping the committed placeholder',
		}
	}

	const isRemote = /^https?:/.test(source)
	let localPath = source
	if (isRemote) {
		let response
		try {
			response = await fetch(source, {
				signal: AbortSignal.timeout(15_000),
			})
		} catch (error) {
			// Keep the committed placeholder rather than failing the whole build.
			return {
				applied: false,
				reason: `icon download failed (${error.message})`,
			}
		}
		if (!response.ok) {
			return {
				applied: false,
				reason: `icon download failed (${response.status})`,
			}
		}
		localPath = join(APP_ROOT, 'Config/Generated/icon-source')
		mkdirSync(dirname(localPath), { recursive: true })
		writeFileSync(localPath, Buffer.from(await response.arrayBuffer()))
	} else if (!existsSync(localPath)) {
		return { applied: false, reason: `icon source not found: ${localPath}` }
	}

	mkdirSync(ICON_DIR, { recursive: true })
	const applied = resizeIcon(localPath, ICON_PATH)
	return {
		applied,
		reason: applied
			? `icon from ${isRemote ? source : localPath}`
			: 'icon resize failed',
	}
}

function writeXcconfig({ config, file, buildNumber, out }) {
	const site = config.site ?? {}
	const useTls =
		typeof config.useTls === 'boolean'
			? config.useTls
			: !/^localhost|^127\./.test(config.appUrl)
	const lines = [
		`// Generated from apps/ios/tenants/${file} — do not edit by hand.`,
		`// Regenerate with: npm run ios:tenant -w ios -- --tenant ${config.slug}`,
		'',
		`EPIC_APP_DISPLAY_NAME = ${config.displayName}`,
		`EPIC_USE_TLS = ${useTls ? 'YES' : 'NO'}`,
		`EPIC_APP_BASE_URL = ${config.appUrl}`,
		`EPIC_BRAND_DOMAIN = ${config.brandDomain ?? 'epic-startup.com'}`,
		`EPIC_TENANT_API_US_BASE_URL = ${config.tenantApiUs}`,
	]

	if (config.tenantApiKsa) {
		lines.push(`EPIC_TENANT_API_KSA_BASE_URL = ${config.tenantApiKsa}`)
	}
	if (site.host) {
		lines.push(`EPIC_SITE_HOST = ${site.host}`)
	} else if (site.slug) {
		lines.push(`EPIC_SITE_SLUG = ${site.slug}`)
	}
	if (site.origin) {
		lines.push(`EPIC_SITE_ORIGIN = ${escapeXcconfig(site.origin)}`)
	}

	lines.push(
		'',
		`PRODUCT_BUNDLE_IDENTIFIER = ${config.bundleId}`,
		`MARKETING_VERSION = ${config.marketingVersion ?? '1.0.0'}`,
		`CURRENT_PROJECT_VERSION = ${buildNumber}`,
	)
	if (config.appleTeamId) {
		lines.push(`DEVELOPMENT_TEAM = ${config.appleTeamId}`)
	}
	lines.push('')

	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, lines.join('\n'))
	return out
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const slug = args.tenant ?? process.env.TENANT_SLUG
	if (!slug) {
		fail('Pass --tenant <slug> (or set TENANT_SLUG)')
	}

	const { config, file } = loadTenant(slug)
	requireString(config, 'displayName', file)
	requireString(config, 'bundleId', file)
	requireString(config, 'appUrl', file)
	if (!config.site?.slug && !config.site?.host) {
		fail(
			`tenants/${file} needs site.slug or site.host — a published app must be bound to one tenant`,
		)
	}

	const buildNumber = String(
		args['build-number'] ?? process.env.GITHUB_RUN_NUMBER ?? '1',
	)
	const out = resolve(
		args.out ?? join(APP_ROOT, 'Config/Generated/Tenant.xcconfig'),
	)
	const useApi = !args.flags.has('no-api')

	const organization = await fetchOrganization(config, { useApi })
	if (
		organization &&
		organization.name &&
		organization.name !== config.displayName
	) {
		log(
			`Note: the published site is named "${organization.name}" but tenants/${file} says "${config.displayName}" — the App Store name comes from the config, the in-app name from the API.`,
		)
	}

	const icon = await resolveIcon(config, organization, {
		iconSource: args['icon-source'],
		useIcon: !args.flags.has('no-icon'),
	})

	const xcconfig = writeXcconfig({ config, file, buildNumber, out })

	console.log('')
	console.log(`✓ ${config.displayName} (${config.slug})`)
	console.log(`  bundle id     ${config.bundleId}`)
	console.log(
		`  version       ${config.marketingVersion ?? '1.0.0'} (${buildNumber})`,
	)
	console.log(
		`  site          ${config.site.origin ?? config.site.host ?? config.site.slug}`,
	)
	console.log(`  xcconfig      ${xcconfig}`)
	console.log(
		`  app icon      ${icon.applied ? icon.reason : `placeholder (${icon.reason})`}`,
	)
}

main().catch((error) => {
	fail(error.stack ?? error.message)
})
