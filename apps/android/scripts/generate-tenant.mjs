#!/usr/bin/env node
/**
 * Turns `tenants/<slug>.json` into a build-time configuration:
 *
 *   1. `app/tenant.properties` — application id, app name, version, endpoints,
 *      site binding, and icon background (read by `app/build.gradle.kts`).
 *   2. `app/src/main/res/values/ic_launcher_background.xml` — the adaptive icon
 *      background colour.
 *   3. `app/src/main/res/mipmap-<density>/ic_launcher_foreground.png` — the
 *      tenant's published site icon, centred in the adaptive icon's safe zone.
 *
 * Every run starts by restoring the committed placeholder icon and background
 * colour, so a tenant without a published icon can never inherit the previous
 * tenant's icon (same rule as apps/ios/scripts/generate-tenant.mjs). The
 * placeholders are committed per density (`scripts/assets/
 * ic-launcher-foreground-<density>.png`), so restoring them needs no tooling.
 *
 * Composing a tenant's own icon needs ImageMagick (`magick`): `brew install
 * imagemagick`, `apt-get install imagemagick`, or `choco install imagemagick`
 * on Windows. Without it the placeholder icon is restored and the build
 * continues.
 *
 * The committed placeholders are `scripts/assets/ic-launcher-placeholder.png`
 * composited onto a transparent canvas; regenerate them after changing that
 * artwork with `node scripts/generate-tenant.mjs --write-placeholders`.
 *
 * No secrets pass through here: the Play upload key lives in the tenant's
 * GitHub environment (see docs/play-store-release.md).
 *
 * Usage:
 *   node scripts/generate-tenant.mjs --tenant acme [--build-number 123]
 *                                    [--icon-source <url|path>] [--no-icon]
 *                                    [--no-api] [--out <path>]
 *   node scripts/generate-tenant.mjs --write-placeholders
 */
import { execFileSync } from 'node:child_process'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RES_ROOT = join(APP_ROOT, 'app/src/main/res')
const ASSETS_DIR = join(APP_ROOT, 'scripts/assets')
const PLACEHOLDER_ICON = join(ASSETS_DIR, 'ic-launcher-placeholder.png')
const BACKGROUND_FILE = join(RES_ROOT, 'values/ic_launcher_background.xml')

/**
 * Adaptive icons: a 108dp canvas whose outer 18dp may be masked away. Each
 * density has a committed placeholder foreground, copied (not composed) when a
 * tenant has no icon of its own.
 */
const FOREGROUND_DENSITIES = [
	{
		dir: 'mipmap-mdpi',
		size: 108,
		placeholder: 'ic-launcher-foreground-mdpi.png',
	},
	{
		dir: 'mipmap-hdpi',
		size: 162,
		placeholder: 'ic-launcher-foreground-hdpi.png',
	},
	{
		dir: 'mipmap-xhdpi',
		size: 216,
		placeholder: 'ic-launcher-foreground-xhdpi.png',
	},
	{
		dir: 'mipmap-xxhdpi',
		size: 324,
		placeholder: 'ic-launcher-foreground-xxhdpi.png',
	},
	{
		dir: 'mipmap-xxxhdpi',
		size: 432,
		placeholder: 'ic-launcher-foreground-xxxhdpi.png',
	},
]
/** Share of the canvas the artwork occupies (inside the 66dp safe zone). */
const FOREGROUND_SCALE = 0.6

const DEFAULT_BACKGROUND = '#0F172A'

function parseArgs(argv) {
	const args = { flags: new Set() }
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]
		if (!value.startsWith('--')) continue
		const [name, inline] = value.slice(2).split('=')
		if (['no-icon', 'no-api', 'write-placeholders'].includes(name)) {
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
	if (!existsSync(path))
		fail(`No tenant config at apps/android/tenants/${file}`)
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
 * app renders at runtime.
 */
async function fetchOrganization(config, { useApi }) {
	if (!useApi) return null
	const scheme = /^localhost|^127\.|^10\.0\.2\.2/.test(config.appUrl)
		? 'http'
		: 'https'
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

function haveImageMagick() {
	try {
		execFileSync('magick', ['-version'], { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

/** Composes one adaptive-icon foreground: transparent canvas + centred logo. */
function composeForeground(source, destination, size) {
	const inner = Math.round(size * FOREGROUND_SCALE)
	execFileSync(
		'magick',
		[
			'-size',
			`${size}x${size}`,
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

/** Restores the committed placeholder icon and background (every run starts here). */
function resetIcons() {
	for (const { dir, placeholder } of FOREGROUND_DENSITIES) {
		const source = join(ASSETS_DIR, placeholder)
		if (!existsSync(source)) {
			fail(
				`Missing placeholder icon at ${source} (regenerate with --write-placeholders)`,
			)
		}
		const target = join(RES_ROOT, dir, 'ic_launcher_foreground.png')
		mkdirSync(dirname(target), { recursive: true })
		// A copy, not a composition: restoring the placeholder must work (and
		// must remove a previous tenant's icon) even without ImageMagick.
		copyFileSync(source, target)
	}
	writeBackground(DEFAULT_BACKGROUND)
}

/** Rebuilds the committed placeholders from the artwork, so the two never drift. */
function writePlaceholders() {
	if (!haveImageMagick())
		fail('ImageMagick (magick) is required to rebuild the placeholder icons')
	if (!existsSync(PLACEHOLDER_ICON))
		fail(`Missing placeholder artwork at ${PLACEHOLDER_ICON}`)
	for (const { placeholder, size } of FOREGROUND_DENSITIES) {
		composeForeground(PLACEHOLDER_ICON, join(ASSETS_DIR, placeholder), size)
	}
}

function writeBackground(color) {
	if (!/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
		fail(`iconBackground must be a #RRGGBB or #AARRGGBB hex color: ${color}`)
	}
	mkdirSync(dirname(BACKGROUND_FILE), { recursive: true })
	writeFileSync(
		BACKGROUND_FILE,
		[
			'<?xml version="1.0" encoding="utf-8"?>',
			'<!-- Generated by apps/android/scripts/generate-tenant.mjs — do not edit by hand. -->',
			'<resources>',
			`\t<color name="ic_launcher_background">${color}</color>`,
			'</resources>',
			'',
		].join('\n'),
	)
}

async function resolveIcon(config, organization, { iconSource, useIcon }) {
	resetIcons()
	if (!useIcon)
		return { applied: false, reason: 'icon generation disabled (--no-icon)' }
	if (!haveImageMagick()) {
		return {
			applied: false,
			reason:
				'ImageMagick (magick) not found; the placeholder icon was restored',
		}
	}

	const scheme = /^localhost|^127\.|^10\.0\.2\.2/.test(config.appUrl)
		? 'http'
		: 'https'
	const source =
		iconSource ??
		(organization?.siteIcon?.original
			? `${scheme}://${config.appUrl}${organization.siteIcon.original}`
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
			response = await fetch(source, { signal: AbortSignal.timeout(15_000) })
		} catch (error) {
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
		localPath = join(APP_ROOT, 'app/build/icon-source')
		mkdirSync(dirname(localPath), { recursive: true })
		writeFileSync(localPath, Buffer.from(await response.arrayBuffer()))
	} else if (!existsSync(localPath)) {
		return { applied: false, reason: `icon source not found: ${localPath}` }
	}

	try {
		for (const { dir, size } of FOREGROUND_DENSITIES) {
			composeForeground(
				localPath,
				join(RES_ROOT, dir, 'ic_launcher_foreground.png'),
				size,
			)
		}
	} catch (error) {
		// Composition can fail part-way through the densities, which would leave
		// a mix of the tenant's icon and the placeholder: put the placeholder
		// back everywhere before reporting that the icon was not applied.
		resetIcons()
		return { applied: false, reason: `icon resize failed (${error.message})` }
	}

	writeBackground(
		typeof config.iconBackground === 'string' &&
			config.iconBackground.trim() !== ''
			? config.iconBackground.trim()
			: DEFAULT_BACKGROUND,
	)
	return { applied: true, reason: `icon from ${isRemote ? source : localPath}` }
}

/** Java `.properties` values only need backslashes escaped. */
function escapeProperty(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

/** A build talking to a public host uses TLS; a local one does not. */
function resolveUseTls(config) {
	if (typeof config.useTls === 'boolean') return config.useTls
	return !/^localhost|^127\.|^10\.0\.2\.2/.test(config.appUrl)
}

/**
 * The `Origin` the app sends on sign-in. tenant-api resolves the tenant from
 * it, so a published tenant needs one: `site.origin`, or `site.host` (the
 * scheme follows the build: `https` unless this is a local one).
 */
function resolveSiteOrigin(site, useTls, file) {
	const configured = typeof site.origin === 'string' ? site.origin.trim() : ''
	const host = typeof site.host === 'string' ? site.host.trim() : ''
	const raw =
		configured || (host ? `${useTls ? 'https' : 'http'}://${host}` : '')
	if (!raw) {
		fail(
			`tenants/${file} needs site.origin (or site.host): tenant-api resolves the tenant from the Origin header the app sends on sign-in`,
		)
	}
	let url
	try {
		url = new URL(raw)
	} catch {
		fail(`tenants/${file} has an invalid site.origin: ${raw}`)
	}
	if (!url.host || !['http:', 'https:'].includes(url.protocol)) {
		fail(`tenants/${file} has an invalid site.origin: ${raw}`)
	}
	if (useTls && url.protocol !== 'https:') {
		fail(
			`tenants/${file} site.origin must be https for a published tenant: ${raw}`,
		)
	}
	// An `Origin` header carries no path, so normalize what a browser sends.
	return url.origin
}

function writeTenantProperties({
	config,
	file,
	buildNumber,
	out,
	useTls,
	siteOrigin,
}) {
	const site = config.site ?? {}
	const entries = [
		['applicationId', config.bundleId],
		['appName', config.displayName],
		['versionName', config.marketingVersion ?? '1.0.0'],
		['versionCode', buildNumber],
		['useTls', useTls ? 'true' : 'false'],
		['appBaseUrl', config.appUrl],
		['brandDomain', config.brandDomain ?? 'epic-startup.com'],
		['tenantApiUs', config.tenantApiUs],
		['tenantApiKsa', config.tenantApiKsa ?? ''],
		['siteSlug', site.host ? '' : (site.slug ?? '')],
		['siteHost', site.host ?? ''],
		['siteOrigin', siteOrigin],
		['iconBackground', config.iconBackground ?? DEFAULT_BACKGROUND],
	]

	const lines = [
		`# Generated from apps/android/tenants/${file} — do not edit by hand.`,
		`# Regenerate with: npm run android:tenant -w android -- --tenant ${config.slug}`,
		'',
		...entries.map(([key, value]) => `${key}=${escapeProperty(value ?? '')}`),
		'',
	]

	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, lines.join('\n'))
	return out
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.flags.has('write-placeholders')) {
		writePlaceholders()
		log(
			'Rebuilt the committed placeholder icons from scripts/assets/ic-launcher-placeholder.png',
		)
		return
	}

	const slug = args.tenant ?? process.env.TENANT_SLUG
	if (!slug) fail('Pass --tenant <slug> (or set TENANT_SLUG)')

	const { config, file } = loadTenant(slug)
	requireString(config, 'displayName', file)
	requireString(config, 'bundleId', file)
	requireString(config, 'appUrl', file)
	requireString(config, 'tenantApiUs', file)
	if (!config.site?.slug && !config.site?.host) {
		fail(
			`tenants/${file} needs site.slug or site.host — a published app must be bound to one tenant`,
		)
	}
	const useTls = resolveUseTls(config)
	const siteOrigin = resolveSiteOrigin(config.site ?? {}, useTls, file)

	const buildNumber = String(
		args['build-number'] ?? process.env.GITHUB_RUN_NUMBER ?? '1',
	)
	const out = resolve(args.out ?? join(APP_ROOT, 'app/tenant.properties'))

	const organization = await fetchOrganization(config, {
		useApi: !args.flags.has('no-api'),
	})
	if (organization?.name && organization.name !== config.displayName) {
		log(
			`Note: the published site is named "${organization.name}" but tenants/${file} says "${config.displayName}" — the store name comes from the config, the in-app name from the API.`,
		)
	}

	const icon = await resolveIcon(config, organization, {
		iconSource: args['icon-source'],
		useIcon: !args.flags.has('no-icon'),
	})
	const properties = writeTenantProperties({
		config,
		file,
		buildNumber,
		out,
		useTls,
		siteOrigin,
	})

	console.log('')
	console.log(`✓ ${config.displayName} (${config.slug})`)
	console.log(`  application id ${config.bundleId}`)
	console.log(
		`  version        ${config.marketingVersion ?? '1.0.0'} (${buildNumber})`,
	)
	console.log(`  site           ${siteOrigin}`)
	console.log(`  properties     ${properties}`)
	console.log(
		`  app icon       ${icon.applied ? icon.reason : `placeholder (${icon.reason})`}`,
	)
}

main().catch((error) => {
	fail(error.stack ?? error.message)
})
