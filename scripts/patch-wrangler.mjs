#!/usr/bin/env node
/**
 * Patch a Wrangler config from environment variables or launch.config.json.
 *
 * Writes wrangler.deploy.jsonc (JSONC apps) or wrangler.deploy.toml (TOML apps)
 * so committed configs keep local-dev defaults and CI can inject bindings/URLs.
 *
 * Usage:
 *   node scripts/patch-wrangler.mjs --app app [--env production|staging] [--require-bindings]
 *
 * @see docs/launch-checklist.md
 * @see launch.config.example.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagingHostnames } from './staging-hostnames.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

/** @type {Record<string, { dir: string, format: 'jsonc' | 'toml' }>} */
const APPS = {
	app: { dir: 'apps/app', format: 'jsonc' },
	admin: { dir: 'apps/admin', format: 'jsonc' },
	'jobs-cron': { dir: 'apps/jobs-cron', format: 'jsonc' },
	'tenant-api': { dir: 'apps/tenant-api', format: 'jsonc' },
	web: { dir: 'apps/web', format: 'toml' },
	sites: { dir: 'apps/sites', format: 'toml' },
}

function parseArgs(argv) {
	const args = { app: null, env: 'production', requireBindings: false }
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--app') args.app = argv[++i]
		else if (arg === '--env') args.env = argv[++i]
		else if (arg === '--require-bindings') args.requireBindings = true
		else if (arg === '--help' || arg === '-h') {
			console.log(
				`Usage: node scripts/patch-wrangler.mjs --app <${Object.keys(APPS).join('|')}> [--env production|staging|preview] [--require-bindings]`,
			)
			process.exit(0)
		}
	}
	if (!args.app || !APPS[args.app]) {
		console.error(`--app is required (${Object.keys(APPS).join(', ')})`)
		process.exit(1)
	}
	if (!['production', 'staging', 'preview'].includes(args.env)) {
		console.error('--env must be production, staging, or preview')
		process.exit(1)
	}
	return args
}

function loadLaunchConfig() {
	const path = join(rootDir, 'launch.config.json')
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		console.warn(`Could not parse launch.config.json: ${error.message}`)
		return null
	}
}

function envSuffix(deployEnv) {
	return deployEnv === 'staging' ? '_STAGING' : ''
}

/** Preview PR deploys reuse production bindings (D1/R2) on a separate worker name. */
function bindingEnvKey(deployEnv) {
	return deployEnv === 'staging' ? 'staging' : 'production'
}

function previewWebWorkerName(launchConfig) {
	return (
		readEnv(
			'WEB_WORKER_NAME_PREVIEW',
			launchConfig,
			'bindings.preview.web.worker_name',
		) || 'epic-startup-preview'
	)
}

function hostnameFromUrl(url) {
	if (!url) return null
	try {
		const normalized = url.includes('://') ? url : `https://${url}`
		return new URL(normalized).hostname
	} catch {
		return null
	}
}

function readRootApp(_suffix, launchConfig) {
	// Route patterns use the production zone apex (zone_name).
	return readEnv('ROOT_APP', launchConfig, 'urls.root_app')
}

function stagingUrlDefaults(rootApp) {
	return stagingHostnames(rootApp)
}

/**
 * @param {string[]} envNames
 * @param {(string | null)[]} launchPaths
 * @param {Record<string, unknown> | null} launchConfig
 * @param {string | undefined} fallbackUrl
 */
function readPlatformUrl(envNames, launchPaths, launchConfig, fallbackUrl) {
	for (const envName of envNames) {
		const value = readEnv(envName, launchConfig, null)
		if (value) return value
	}
	for (const launchPath of launchPaths) {
		if (!launchPath) continue
		const value = readEnv(`__launch__`, launchConfig, launchPath)
		if (value) return value
	}
	return fallbackUrl
}

/** @param {string[]} hostPatterns @param {string} zoneName */
function buildZoneRoutes(hostPatterns, zoneName) {
	if (!zoneName) return []
	return hostPatterns
		.filter(Boolean)
		.map((host) => ({ pattern: `${host}/*`, zone_name: zoneName }))
}

/**
 * @param {Record<string, unknown>} target
 * @param {{ pattern: string, zone_name: string }[]} routes
 * @param {string[]} patches
 * @param {string} label
 */
function applyZoneRoutes(target, routes, patches, label) {
	if (routes.length === 0) return
	target.routes = routes
	patches.push(
		`routes ← ${label}: ${routes.map((route) => route.pattern).join(', ')}`,
	)
}

/**
 * @param {string} appKey
 * @param {'production' | 'staging' | 'preview'} deployEnv
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown> | null} launchConfig
 * @param {string[]} patches
 */
function patchRoutesForApp(appKey, deployEnv, target, launchConfig, patches) {
	// PR preview workers deploy to *.workers.dev only — no zone routes.
	if (deployEnv === 'preview') return

	const suffix = envSuffix(deployEnv)
	const rootApp = readRootApp(suffix, launchConfig)
	if (!rootApp) return

	const isStaging = deployEnv === 'staging'

	const stagingDefaults = stagingUrlDefaults(rootApp)

	if (appKey === 'app') {
		const url = readPlatformUrl(
			[`APP_BASE_URL${suffix}`, 'APP_BASE_URL'],
			[isStaging ? 'urls.app_base_url_staging' : null, 'urls.app_base_url'],
			launchConfig,
			isStaging ? stagingDefaults.app_base_url_staging : undefined,
		)
		applyZoneRoutes(
			target,
			buildZoneRoutes([hostnameFromUrl(url)], rootApp),
			patches,
			'app',
		)
		return
	}

	if (appKey === 'admin') {
		const url = readPlatformUrl(
			[`ADMIN_BASE_URL${suffix}`, 'ADMIN_BASE_URL'],
			[isStaging ? 'urls.admin_base_url_staging' : null, 'urls.admin_base_url'],
			launchConfig,
			isStaging ? stagingDefaults.admin_base_url_staging : undefined,
		)
		applyZoneRoutes(
			target,
			buildZoneRoutes([hostnameFromUrl(url)], rootApp),
			patches,
			'admin',
		)
		return
	}

	if (appKey === 'jobs-cron') {
		const url = readPlatformUrl(
			[`JOBS_CRON_WORKER_URL${suffix}`, 'JOBS_CRON_WORKER_URL'],
			[
				isStaging ? 'urls.jobs_cron_worker_url_staging' : null,
				'urls.jobs_cron_worker_url',
			],
			launchConfig,
			isStaging ? stagingDefaults.jobs_cron_worker_url_staging : undefined,
		)
		applyZoneRoutes(
			target,
			buildZoneRoutes([hostnameFromUrl(url)], rootApp),
			patches,
			'jobs-cron',
		)
		return
	}

	if (appKey === 'tenant-api') {
		const url = readPlatformUrl(
			[`TENANT_API_URL${suffix}`, 'TENANT_API_URL'],
			[isStaging ? 'urls.tenant_api_url_staging' : null, 'urls.tenant_api_url'],
			launchConfig,
			isStaging ? stagingDefaults.tenant_api_url_staging : undefined,
		)
		applyZoneRoutes(
			target,
			buildZoneRoutes([hostnameFromUrl(url)], rootApp),
			patches,
			'tenant-api',
		)
		return
	}

	if (appKey === 'web') {
		const url = readPlatformUrl(
			[`WEB_BASE_URL${suffix}`, 'WEB_BASE_URL'],
			[isStaging ? 'urls.web_base_url_staging' : null, 'urls.web_base_url'],
			launchConfig,
			isStaging ? stagingDefaults.web_base_url_staging : `https://${rootApp}`,
		)
		const apex = hostnameFromUrl(url) ?? rootApp
		const hosts = [apex]
		if (!apex.startsWith('www.')) {
			hosts.push(`www.${apex}`)
		}
		const routes = isStaging
			? buildZoneRoutes(hosts, rootApp)
			: [
					{ pattern: apex, custom_domain: true },
					...buildZoneRoutes(
						hosts.filter((h) => h !== apex),
						rootApp,
					),
				]
		applyZoneRoutes(target, routes, patches, 'web')
		return
	}

	if (appKey === 'sites') {
		if (isStaging) {
			const demoHost =
				readEnv('__launch__', launchConfig, 'urls.demo_site_host_staging') ??
				stagingDefaults.demo_site_host_staging
			applyZoneRoutes(
				target,
				buildZoneRoutes([demoHost], rootApp),
				patches,
				'sites-staging',
			)
			return
		}

		const wildcard = `*.${rootApp}`
		applyZoneRoutes(
			target,
			[{ pattern: `${wildcard}/*`, zone_name: rootApp }],
			patches,
			'sites',
		)
	}
}

const TOML_ROUTES_BEGIN = '# BEGIN patch-wrangler routes'
const TOML_ROUTES_END = '# END patch-wrangler routes'

/** @param {{ pattern: string, zone_name: string }[]} routes */
function injectTomlRoutes(content, deployEnv, routes) {
	const stripped = content.replace(
		new RegExp(`${TOML_ROUTES_BEGIN}[\\s\\S]*?${TOML_ROUTES_END}\\n?`, 'm'),
		'',
	)
	if (routes.length === 0) {
		return stripped.trimEnd() + '\n'
	}

	const tablePrefix = deployEnv === 'staging' ? 'env.staging.' : ''
	const lines = routes.flatMap((route) => [
		`[[${tablePrefix}routes]]`,
		`pattern = "${route.pattern}"`,
		route.custom_domain
			? 'custom_domain = true'
			: `zone_name = "${route.zone_name}"`,
		'',
	])

	return `${stripped.trimEnd()}\n\n${TOML_ROUTES_BEGIN}\n${lines.join('\n')}${TOML_ROUTES_END}\n`
}

/** @returns {{ pattern: string, zone_name: string }[]} */
function collectRoutesForApp(appKey, deployEnv, launchConfig) {
	const target = {}
	const patches = []
	patchRoutesForApp(appKey, deployEnv, target, launchConfig, patches)
	return /** @type {{ pattern: string, zone_name: string }[]} */ (
		target.routes ?? []
	)
}

function readEnv(name, launchConfig, launchPath) {
	if (process.env[name]) return process.env[name]
	if (launchConfig && launchPath) {
		const parts = launchPath.split('.')
		let value = launchConfig
		for (const part of parts) {
			value = value?.[part]
		}
		if (value != null && value !== '') return String(value)
	}
	return undefined
}

/**
 * Resolve a URL-related GitHub Variable or launch.config field for production/staging.
 * Staging prefers `*_STAGING` env vars and `urls.<key>_staging` before production fallbacks.
 *
 * @param {string} envBase e.g. `APP_BASE_URL`, `ROOT_APP`
 * @param {string} urlKey launch.config key under `urls` without `_staging`
 * @param {'production' | 'staging'} deployEnv
 * @param {Record<string, unknown> | null} launchConfig
 */
function readUrlSetting(envBase, urlKey, deployEnv, launchConfig) {
	const suffix = envSuffix(deployEnv)
	const envNames = deployEnv === 'staging' ? [`${envBase}${suffix}`] : [envBase]
	for (const name of envNames) {
		if (process.env[name]) return process.env[name]
	}
	const launchPaths =
		deployEnv === 'staging' ? [`urls.${urlKey}_staging`] : [`urls.${urlKey}`]
	for (const launchPath of launchPaths) {
		const value = readEnv('__launch__', launchConfig, launchPath)
		if (value) return value
	}
	if (deployEnv === 'staging' && launchConfig) {
		const apex = readEnv('__launch__', launchConfig, 'urls.root_app')
		if (apex) {
			const defaults = stagingHostnames(apex)
			if (urlKey === 'root_app') return defaults.root_app_staging
			if (urlKey === 'public_site_host_suffixes') {
				return defaults.public_site_host_suffixes_staging
			}
			if (urlKey === 'public_app_url') {
				const appStaging = readEnv(
					'__launch__',
					launchConfig,
					'urls.app_base_url_staging',
				)
				if (appStaging) return appStaging
			}
			if (urlKey === 'tenant_api_url_ksa') {
				const ksaVal = readEnv(
					'__launch__',
					launchConfig,
					'urls.tenant_api_url_ksa',
				)
				if (ksaVal) return ksaVal
			}
		}
	}
	return undefined
}

function stripJsoncComments(text) {
	let result = ''
	let inString = false
	let escaped = false

	for (let index = 0; index < text.length; index++) {
		const current = text[index]
		const next = text[index + 1]

		if (inString) {
			result += current
			if (escaped) escaped = false
			else if (current === '\\') escaped = true
			else if (current === '"') inString = false
			continue
		}

		if (current === '"') {
			inString = true
			result += current
			continue
		}

		if (current === '/' && next === '/') {
			while (index < text.length && text[index] !== '\n') index++
			result += '\n'
			continue
		}

		if (current === '/' && next === '*') {
			index += 2
			while (
				index < text.length &&
				!(text[index] === '*' && text[index + 1] === '/')
			) {
				if (text[index] === '\n') result += '\n'
				index++
			}
			index++
			continue
		}

		result += current
	}

	return result
}

function parseJsonc(path) {
	const stripped = stripJsoncComments(readFileSync(path, 'utf8'))
	const withoutTrailingCommas = stripped.replace(/,(\s*[}\]])/g, '$1')
	return JSON.parse(withoutTrailingCommas)
}

function writeJsonc(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`)
}

/**
 * @param {Record<string, unknown>} target
 * @param {string} path
 * @param {unknown} value
 */
function setPath(target, path, value) {
	const parts = path.split('.')
	let node = target
	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i]
		const match = key.match(/^(.+)\[(\d+)\]$/)
		if (match) {
			const [, arrayKey, index] = match
			if (!Array.isArray(node[arrayKey])) node[arrayKey] = []
			if (!node[arrayKey][Number(index)]) node[arrayKey][Number(index)] = {}
			node = node[arrayKey][Number(index)]
			continue
		}
		if (!node[key] || typeof node[key] !== 'object') node[key] = {}
		node = /** @type {Record<string, unknown>} */ (node[key])
	}
	const last = parts[parts.length - 1]
	const lastMatch = last.match(/^(.+)\[(\d+)\]$/)
	if (lastMatch) {
		const [, arrayKey, index] = lastMatch
		if (!Array.isArray(node[arrayKey])) node[arrayKey] = []
		node[arrayKey][Number(index)] = value
		return
	}
	node[last] = value
}

function ensureEnvSection(config, deployEnv) {
	if (deployEnv !== 'staging') return config
	if (!config.env) config.env = {}
	if (!config.env.staging) config.env.staging = {}
	return config.env.staging
}

function viteBuiltWranglerPath(appKey) {
	return join(rootDir, APPS[appKey].dir, 'build/server/wrangler.json')
}

function usesViteWorkerBuild(appKey) {
	return (
		(appKey === 'app' || appKey === 'admin') &&
		existsSync(viteBuiltWranglerPath(appKey))
	)
}

function applyTargetPatches(
	target,
	appKey,
	targetEnv,
	launchConfig,
	patches,
	missing,
) {
	const suffix = envSuffix(targetEnv)
	const prefix = appKey === 'app' ? 'APP' : 'ADMIN'
	const bindingEnv = targetEnv === 'staging' ? 'staging' : 'production'

	function patch(path, envNames, launchPath) {
		for (const envName of envNames) {
			const value = readEnv(envName, launchConfig, launchPath)
			if (value) {
				setPath(target, path, value)
				patches.push(`${path} [${targetEnv}] ← ${envName}`)
				return true
			}
		}
		return false
	}

	function patchVar(key, envBase, urlKey) {
		if (!target.vars) target.vars = {}
		const value = readUrlSetting(envBase, urlKey, targetEnv, launchConfig)
		if (value) {
			target.vars[key] = value
			patches.push(`vars.${key} [${targetEnv}] ← ${envBase}${suffix || ''}`)
		}
	}

	if (appKey === 'app' || appKey === 'admin') {
		if (
			!patch(
				'd1_databases[0].database_id',
				[`${prefix}_D1_DATABASE_ID${suffix}`, `${prefix}_D1_DATABASE_ID`],
				`bindings.${bindingEnv}.${appKey}.d1_database_id`,
			)
		) {
			if (missing) missing.push(`${prefix}_D1_DATABASE_ID${suffix}`)
		}
		if (
			!patch(
				'kv_namespaces[0].id',
				[`${prefix}_KV_NAMESPACE_ID${suffix}`, `${prefix}_KV_NAMESPACE_ID`],
				`bindings.${bindingEnv}.${appKey}.kv_namespace_id`,
			)
		) {
			if (missing) missing.push(`${prefix}_KV_NAMESPACE_ID${suffix}`)
		}
		if (appKey === 'app') {
			const envNames =
				targetEnv === 'staging'
					? [`${prefix}_SITES_DATA_KV_ID_STAGING`]
					: [`${prefix}_SITES_DATA_KV_ID`]
			if (
				!patch(
					'kv_namespaces[1].id',
					envNames,
					`bindings.${bindingEnv}.${appKey}.sites_data_kv_id`,
				)
			) {
				if (missing) missing.push(envNames[0])
			}
		}
		patch(
			'name',
			[`${prefix}_WORKER_NAME${suffix}`, `${prefix}_WORKER_NAME`],
			`bindings.${bindingEnv}.${appKey}.worker_name`,
		)
		if (appKey === 'app') {
			patchVar('BASE_URL', 'APP_BASE_URL', 'app_base_url')
			patchVar('DOCS_URL', 'DOCS_URL', 'docs_url')
			patch('vars.POSTHOG_PROJECT_TOKEN', [
				`POSTHOG_PROJECT_TOKEN${suffix}`,
				'POSTHOG_PROJECT_TOKEN',
			])
			patchVar('POSTHOG_HOST', 'POSTHOG_HOST', 'posthog_host')

			const logsDestination = readEnv(
				`POSTHOG_LOGS_DESTINATION${suffix}`,
				launchConfig,
				`observability.${bindingEnv}.posthog_logs_destination`,
			)
			if (logsDestination) {
				setPath(target, 'observability.logs.enabled', true)
				setPath(target, 'observability.logs.destinations', [logsDestination])
				patches.push(`observability.logs [${targetEnv}] ← ${logsDestination}`)
			}
			patchVar(
				'PUBLIC_SITE_HOST_SUFFIXES',
				'PUBLIC_SITE_HOST_SUFFIXES',
				'public_site_host_suffixes',
			)
			patchVar(
				'JOBS_CRON_WORKER_URL',
				'JOBS_CRON_WORKER_URL',
				'jobs_cron_worker_url',
			)
		} else {
			patchVar('BASE_URL', 'ADMIN_BASE_URL', 'admin_base_url')
		}
		patchVar('ROOT_APP', 'ROOT_APP', 'root_app')
		patchVar('TENANT_API_URL', 'TENANT_API_URL', 'tenant_api_url')
		patchVar('TENANT_API_URL_KSA', 'TENANT_API_URL_KSA', 'tenant_api_url_ksa')

		if (appKey === 'app') {
			const tenantApiWorkerName = readEnv(
				`TENANT_API_US_WORKER_NAME${suffix}`,
				launchConfig,
				`bindings.${bindingEnv}.tenant_api.worker_name`,
			)
			if (tenantApiWorkerName) {
				target.services = [
					{
						binding: 'TENANT_API',
						service: tenantApiWorkerName,
					},
				]
				patches.push(
					`services.TENANT_API [${targetEnv}] ← ${tenantApiWorkerName}`,
				)
			}
		}
	}

	if (appKey === 'jobs-cron') {
		patch(
			'name',
			[`JOBS_CRON_WORKER_NAME${suffix}`, 'JOBS_CRON_WORKER_NAME'],
			`bindings.${targetEnv === 'staging' ? 'staging' : 'production'}.jobs_cron.worker_name`,
		)
		patchVar('APP_BASE_URL', 'APP_BASE_URL', 'app_base_url')
		patchVar('TENANT_API_URL', 'TENANT_API_URL', 'tenant_api_url')
		patchVar('TENANT_API_URL_KSA', 'TENANT_API_URL_KSA', 'tenant_api_url_ksa')
	}

	if (appKey === 'tenant-api') {
		patch(
			'name',
			[`TENANT_API_US_WORKER_NAME${suffix}`, 'TENANT_API_US_WORKER_NAME'],
			`bindings.${targetEnv === 'staging' ? 'staging' : 'production'}.tenant_api.worker_name`,
		)
		patchVar('APP_URL', 'APP_BASE_URL', 'app_base_url')
		patchVar('ROOT_APP', 'ROOT_APP', 'root_app')
	}

	patchRoutesForApp(appKey, targetEnv, target, launchConfig, patches)
}

function patchJsoncApp(appKey, deployEnv, launchConfig, requireBindings) {
	const meta = APPS[appKey]
	const sourcePath = join(rootDir, meta.dir, 'wrangler.jsonc')
	const isAppOrAdmin = appKey === 'app' || appKey === 'admin'
	const useViteBuild = usesViteWorkerBuild(appKey)

	const patches = []
	const missing = []

	// For app/admin, always generate/update wrangler.deploy.jsonc from source wrangler.jsonc.
	// This ensures migrations and wrangler commands always have valid database IDs and bindings.
	if (isAppOrAdmin) {
		const deployJsoncPath = join(rootDir, meta.dir, 'wrangler.deploy.jsonc')
		const deployJsoncConfig = parseJsonc(sourcePath)

		// Patch production on top-level
		applyTargetPatches(
			deployJsoncConfig,
			appKey,
			'production',
			launchConfig,
			patches,
			deployEnv === 'production' ? missing : null,
		)

		// Patch staging on env.staging
		ensureEnvSection(deployJsoncConfig, 'staging')
		applyTargetPatches(
			deployJsoncConfig.env.staging,
			appKey,
			'staging',
			launchConfig,
			patches,
			deployEnv === 'staging' ? missing : null,
		)

		delete deployJsoncConfig.account_id
		if (deployJsoncConfig.env?.staging)
			delete deployJsoncConfig.env.staging.account_id

		writeJsonc(deployJsoncPath, deployJsoncConfig)
		console.log(`Wrote ${deployJsoncPath}`)
	}

	// Deploy output config: build/server/wrangler.deploy.json for Vite apps,
	// or wrangler.deploy.jsonc for other apps like jobs-cron and tenant-api.
	if (useViteBuild) {
		const viteOutputPath = join(
			rootDir,
			meta.dir,
			'build/server/wrangler.deploy.json',
		)
		const viteConfig = JSON.parse(
			readFileSync(viteBuiltWranglerPath(appKey), 'utf8'),
		)

		// Patch production on top-level
		applyTargetPatches(
			viteConfig,
			appKey,
			'production',
			launchConfig,
			patches,
			deployEnv === 'production' ? missing : null,
		)

		// Patch staging on env.staging
		const source = parseJsonc(sourcePath)
		if (source.env?.staging) {
			viteConfig.env = { staging: structuredClone(source.env.staging) }
		} else {
			ensureEnvSection(viteConfig, 'staging')
		}
		applyTargetPatches(
			viteConfig.env.staging,
			appKey,
			'staging',
			launchConfig,
			patches,
			deployEnv === 'staging' ? missing : null,
		)

		delete viteConfig.account_id
		if (viteConfig.env?.staging) delete viteConfig.env.staging.account_id

		writeJsonc(viteOutputPath, viteConfig)
		console.log(`Wrote ${viteOutputPath}`)
		console.log(
			'  Deploy: npx wrangler deploy --config build/server/wrangler.deploy.json',
		)
	} else if (!isAppOrAdmin) {
		const outputPath = join(rootDir, meta.dir, 'wrangler.deploy.jsonc')
		const config = parseJsonc(sourcePath)
		const target =
			deployEnv === 'staging' ? ensureEnvSection(config, deployEnv) : config
		applyTargetPatches(
			target,
			appKey,
			deployEnv,
			launchConfig,
			patches,
			missing,
		)

		delete config.account_id
		if (config.env?.staging) delete config.env.staging.account_id

		writeJsonc(outputPath, config)
		console.log(`Wrote ${outputPath}`)
	}

	if (requireBindings && missing.length > 0) {
		console.error(
			`Missing required binding env vars for ${appKey} (${deployEnv}): ${missing.join(', ')}`,
		)
		console.error('Set GitHub repository variables or run npm run launch:setup')
		process.exit(1)
	}

	if (patches.length > 0) {
		console.log(patches.map((line) => `  • ${line}`).join('\n'))
	} else {
		console.log('  (no env overrides applied — using committed defaults)')
	}
	return useViteBuild
		? join(rootDir, meta.dir, 'build/server/wrangler.deploy.json')
		: join(rootDir, meta.dir, 'wrangler.deploy.jsonc')
}

function patchTomlApp(appKey, deployEnv, launchConfig, requireBindings) {
	const meta = APPS[appKey]
	const sourcePath = join(rootDir, meta.dir, 'wrangler.toml')
	const outputPath = join(rootDir, meta.dir, 'wrangler.deploy.toml')
	const suffix = envSuffix(deployEnv)
	let content = readFileSync(sourcePath, 'utf8')
	const bindingEnv = bindingEnvKey(deployEnv)
	const patches = []
	const missing = []

	function applyToml(regex, replacement, label) {
		if (regex.test(content)) {
			content = content.replace(regex, replacement)
			patches.push(label)
			return true
		}
		return false
	}

	if (appKey === 'web') {
		const d1Id = readEnv(
			`WEB_D1_DATABASE_ID${suffix}`,
			launchConfig,
			`bindings.${bindingEnv}.web.d1_database_id`,
		)
		if (d1Id) {
			applyToml(
				/(database_id\s*=\s*")[^"]+(")/,
				`$1${d1Id}$2`,
				`database_id ← WEB_D1_DATABASE_ID${suffix}`,
			)
		} else if (requireBindings) {
			missing.push(`WEB_D1_DATABASE_ID${suffix}`)
		}

		const bucket = readEnv(
			`WEB_R2_BUCKET_NAME${suffix}`,
			launchConfig,
			`bindings.${bindingEnv}.web.r2_bucket_name`,
		)
		if (bucket) {
			applyToml(
				/(bucket_name\s*=\s*")[^"]+(")/,
				`$1${bucket}$2`,
				`bucket_name ← WEB_R2_BUCKET_NAME${suffix}`,
			)
		}

		const rootApp = readUrlSetting(
			'ROOT_APP',
			'root_app',
			deployEnv,
			launchConfig,
		)
		if (rootApp) {
			applyToml(
				/(PUBLIC_ROOT_APP\s*=\s*")[^"]+(")/,
				`$1${rootApp}$2`,
				`PUBLIC_ROOT_APP ← ROOT_APP${suffix}`,
			)
		}

		const publicAppUrl = readUrlSetting(
			'PUBLIC_APP_URL',
			'public_app_url',
			deployEnv,
			launchConfig,
		)
		if (publicAppUrl) {
			applyToml(
				/(PUBLIC_APP_URL\s*=\s*")[^"]+(")/,
				`$1${publicAppUrl}$2`,
				`PUBLIC_APP_URL ← PUBLIC_APP_URL${suffix}`,
			)
		}

		const posthogProjectToken = readEnv(
			`POSTHOG_PROJECT_TOKEN${suffix}`,
			launchConfig,
			`observability.${bindingEnv}.posthog_project_token`,
		)
		if (posthogProjectToken) {
			applyToml(
				/(PUBLIC_POSTHOG_PROJECT_TOKEN\s*=\s*")[^"]*(")/,
				`$1${posthogProjectToken}$2`,
				`PUBLIC_POSTHOG_PROJECT_TOKEN ← POSTHOG_PROJECT_TOKEN${suffix}`,
			)
		}

		const posthogHost = readEnv(
			`POSTHOG_HOST${suffix}`,
			launchConfig,
			`observability.${bindingEnv}.posthog_host`,
		)
		if (posthogHost) {
			applyToml(
				/(PUBLIC_POSTHOG_HOST\s*=\s*")[^"]*(")/,
				`$1${posthogHost}$2`,
				`PUBLIC_POSTHOG_HOST ← POSTHOG_HOST${suffix}`,
			)
		}

		const release = readEnv('COMMIT_SHA', launchConfig)
		if (release) {
			applyToml(
				/(PUBLIC_POSTHOG_RELEASE\s*=\s*")[^"]*(")/,
				`$1${release}$2`,
				'PUBLIC_POSTHOG_RELEASE ← COMMIT_SHA',
			)
		}

		const logsDestination = readEnv(
			`POSTHOG_LOGS_DESTINATION${suffix}`,
			launchConfig,
			`observability.${bindingEnv}.posthog_logs_destination`,
		)
		if (logsDestination) {
			const logsTable =
				deployEnv === 'staging'
					? 'env.staging.observability.logs'
					: 'observability.logs'
			content += `\n[${logsTable}]\nenabled = true\ndestinations = [ ${JSON.stringify(logsDestination)} ]\n`
			patches.push(`observability.logs ← ${logsDestination}`)
		}

		if (deployEnv === 'preview') {
			applyToml(
				/^name\s*=\s*"[^"]+"/m,
				`name = "${previewWebWorkerName(launchConfig)}"`,
				'name ← WEB_WORKER_NAME_PREVIEW',
			)
		} else {
			const workerName = readEnv(
				`WEB_WORKER_NAME${suffix}`,
				launchConfig,
				`bindings.${bindingEnv}.web.worker_name`,
			)
			if (workerName) {
				applyToml(
					/^name\s*=\s*"[^"]+"/m,
					`name = "${workerName}"`,
					`name ← WEB_WORKER_NAME${suffix}`,
				)
			}
		}
	}

	if (appKey === 'sites') {
		const publicAppUrl = readUrlSetting(
			'PUBLIC_APP_URL',
			'public_app_url',
			deployEnv,
			launchConfig,
		)
		if (publicAppUrl) {
			applyToml(
				/(PUBLIC_APP_URL\s*=\s*")[^"]+(")/,
				`$1${publicAppUrl}$2`,
				`PUBLIC_APP_URL ← PUBLIC_APP_URL${suffix}`,
			)
		}

		const tenantApiUrl = readUrlSetting(
			'TENANT_API_URL',
			'tenant_api_url',
			deployEnv,
			launchConfig,
		)
		if (tenantApiUrl) {
			applyToml(
				/(TENANT_API_URL\s*=\s*")[^"]+(")/,
				`$1${tenantApiUrl}$2`,
				`TENANT_API_URL ← TENANT_API_URL${suffix}`,
			)
		}

		const rootApp = readUrlSetting(
			'ROOT_APP',
			'root_app',
			deployEnv,
			launchConfig,
		)
		if (rootApp) {
			applyToml(
				/(ROOT_APP\s*=\s*")[^"]+(")/,
				`$1${rootApp}$2`,
				`ROOT_APP ← ROOT_APP${suffix}`,
			)
		}

		const hostSuffixes = readUrlSetting(
			'PUBLIC_SITE_HOST_SUFFIXES',
			'public_site_host_suffixes',
			deployEnv,
			launchConfig,
		)
		if (hostSuffixes) {
			applyToml(
				/(PUBLIC_SITE_HOST_SUFFIXES\s*=\s*")[^"]+(")/,
				`$1${hostSuffixes}$2`,
				`PUBLIC_SITE_HOST_SUFFIXES ← PUBLIC_SITE_HOST_SUFFIXES${suffix}`,
			)
		}

		const workerName = readEnv(
			`SITES_WORKER_NAME${suffix}`,
			launchConfig,
			`bindings.${bindingEnv}.sites.worker_name`,
		)
		if (workerName) {
			applyToml(
				/^name\s*=\s*"[^"]+"/m,
				`name = "${workerName}"`,
				`name ← SITES_WORKER_NAME${suffix}`,
			)
		}

		const appWorkerName = readEnv(
			`APP_WORKER_NAME${suffix}`,
			launchConfig,
			`bindings.${bindingEnv}.app.worker_name`,
		)
		if (appWorkerName) {
			const serviceTable =
				deployEnv === 'staging' ? '[[env.staging.services]]' : '[[services]]'
			if (!content.includes(`service = "${appWorkerName}"`)) {
				content += `\n${serviceTable}\nbinding = "APP"\nservice = "${appWorkerName}"\n`
				patches.push(`services.APP ← ${appWorkerName}`)
			}
		}

		const sitesDataKvId =
			readEnv(
				`SITES_DATA_KV_ID${suffix}`,
				launchConfig,
				`bindings.${bindingEnv}.sites.sites_data_kv_id`,
			) ||
			readEnv(`APP_SITES_DATA_KV_ID${suffix}`, launchConfig, null)
		if (sitesDataKvId) {
			if (deployEnv === 'staging') {
				const stagingKvPattern =
					/(\[\[env\.staging\.kv_namespaces\]\]\s*\n\s*binding\s*=\s*"SITES_DATA_KV"\s*\n\s*id\s*=\s*")[^"]+(")/
				if (stagingKvPattern.test(content)) {
					content = content.replace(
						stagingKvPattern,
						`$1${sitesDataKvId}$2`,
					)
				} else {
					content += `\n[[env.staging.kv_namespaces]]\nbinding = "SITES_DATA_KV"\nid = "${sitesDataKvId}"\n`
				}
				patches.push(
					`env.staging.kv_namespaces (SITES_DATA_KV) ← SITES_DATA_KV_ID${suffix}`,
				)
			} else {
				applyToml(
					/(binding\s*=\s*"SITES_DATA_KV"\s*\n\s*id\s*=\s*")[^"]+(")/,
					`$1${sitesDataKvId}$2`,
					`SITES_DATA_KV id ← SITES_DATA_KV_ID${suffix}`,
				)
			}
		} else if (requireBindings) {
			missing.push(`SITES_DATA_KV_ID${suffix}`)
		}
	}

	if (requireBindings && missing.length > 0) {
		console.error(
			`Missing required binding env vars for ${appKey} (${deployEnv}): ${missing.join(', ')}`,
		)
		process.exit(1)
	}

	const routes = collectRoutesForApp(appKey, deployEnv, launchConfig)
	content = injectTomlRoutes(content, deployEnv, routes)
	if (routes.length > 0) {
		patches.push(
			`routes ← ${appKey}: ${routes.map((route) => route.pattern).join(', ')}`,
		)
	}

	writeFileSync(outputPath, content)
	console.log(`Wrote ${outputPath}`)
	if (patches.length > 0) {
		console.log(patches.map((line) => `  • ${line}`).join('\n'))
	}
	return outputPath
}

function astroBuiltWranglerPath(appKey) {
	return join(rootDir, APPS[appKey].dir, 'dist/server/wrangler.json')
}

function usesAstroWorkerBuild(appKey) {
	return (
		(appKey === 'web' || appKey === 'sites') &&
		existsSync(astroBuiltWranglerPath(appKey))
	)
}

function patchAstroTomlApp(appKey, deployEnv, launchConfig, requireBindings) {
	const meta = APPS[appKey]
	const config = JSON.parse(
		readFileSync(astroBuiltWranglerPath(appKey), 'utf8'),
	)
	const outputPath = join(rootDir, meta.dir, 'dist/server/wrangler.deploy.json')
	const suffix = envSuffix(deployEnv)
	const bindingEnv = bindingEnvKey(deployEnv)
	const patches = []
	const missing = []

	function patch(path, envNames, launchPath) {
		for (const envName of envNames) {
			const value = readEnv(envName, launchConfig, launchPath)
			if (value) {
				setPath(config, path, value)
				patches.push(`${path} ← ${envName}`)
				return true
			}
		}
		return false
	}

	function patchUrlVar(path, envBase, urlKey) {
		const value = readUrlSetting(envBase, urlKey, deployEnv, launchConfig)
		if (value) {
			setPath(config, path, value)
			patches.push(`${path} ← ${envBase}${suffix}`)
			return true
		}
		return false
	}

	if (appKey === 'web') {
		if (
			!patch(
				'd1_databases[0].database_id',
				[`WEB_D1_DATABASE_ID${suffix}`, 'WEB_D1_DATABASE_ID'],
				`bindings.${bindingEnv}.web.d1_database_id`,
			) &&
			requireBindings
		) {
			missing.push(`WEB_D1_DATABASE_ID${suffix}`)
		}
		patch(
			'r2_buckets[0].bucket_name',
			[`WEB_R2_BUCKET_NAME${suffix}`, 'WEB_R2_BUCKET_NAME'],
			`bindings.${bindingEnv}.web.r2_bucket_name`,
		)
		patchUrlVar('vars.PUBLIC_ROOT_APP', 'ROOT_APP', 'root_app')
		patchUrlVar('vars.PUBLIC_APP_URL', 'PUBLIC_APP_URL', 'public_app_url')
		patch(
			'vars.PUBLIC_POSTHOG_PROJECT_TOKEN',
			[`POSTHOG_PROJECT_TOKEN${suffix}`, 'POSTHOG_PROJECT_TOKEN'],
			`observability.${bindingEnv}.posthog_project_token`,
		)
		patch(
			'vars.PUBLIC_POSTHOG_HOST',
			[`POSTHOG_HOST${suffix}`, 'POSTHOG_HOST'],
			`observability.${bindingEnv}.posthog_host`,
		)
		patch('vars.PUBLIC_POSTHOG_RELEASE', ['COMMIT_SHA'], 'build.commit_sha')
		const logsDestination = readEnv(
			`POSTHOG_LOGS_DESTINATION${suffix}`,
			launchConfig,
			`observability.${bindingEnv}.posthog_logs_destination`,
		)
		if (logsDestination) {
			setPath(config, 'observability.logs.enabled', true)
			setPath(config, 'observability.logs.destinations', [logsDestination])
			patches.push(`observability.logs ← ${logsDestination}`)
		}
		if (deployEnv === 'preview') {
			setPath(config, 'name', previewWebWorkerName(launchConfig))
			patches.push('name ← WEB_WORKER_NAME_PREVIEW')
		} else {
			patch(
				'name',
				[`WEB_WORKER_NAME${suffix}`, 'WEB_WORKER_NAME'],
				`bindings.${bindingEnv}.web.worker_name`,
			)
		}
	}

	if (appKey === 'sites') {
		patchUrlVar('vars.PUBLIC_APP_URL', 'PUBLIC_APP_URL', 'public_app_url')
		patchUrlVar('vars.TENANT_API_URL', 'TENANT_API_URL', 'tenant_api_url')
		patchUrlVar('vars.ROOT_APP', 'ROOT_APP', 'root_app')
		patchUrlVar(
			'vars.PUBLIC_SITE_HOST_SUFFIXES',
			'PUBLIC_SITE_HOST_SUFFIXES',
			'public_site_host_suffixes',
		)
		patch(
			'name',
			[`SITES_WORKER_NAME${suffix}`, 'SITES_WORKER_NAME'],
			`bindings.${bindingEnv}.sites.worker_name`,
		)

		const sitesDataKvId =
			readEnv(
				`SITES_DATA_KV_ID${suffix}`,
				launchConfig,
				`bindings.${bindingEnv}.sites.sites_data_kv_id`,
			) ||
			readEnv(`APP_SITES_DATA_KV_ID${suffix}`, launchConfig, null)
		if (sitesDataKvId) {
			if (!Array.isArray(config.kv_namespaces)) config.kv_namespaces = []
			const binding = config.kv_namespaces.find(
				(namespace) => namespace.binding === 'SITES_DATA_KV',
			)
			if (binding) {
				binding.id = sitesDataKvId
			} else {
				config.kv_namespaces.push({
					binding: 'SITES_DATA_KV',
					id: sitesDataKvId,
				})
			}
			patches.push(
				`kv_namespaces.SITES_DATA_KV ← SITES_DATA_KV_ID${suffix}`,
			)
		} else if (requireBindings) {
			missing.push(`SITES_DATA_KV_ID${suffix}`)
		}

		const appWorkerName = readEnv(
			`APP_WORKER_NAME${suffix}`,
			launchConfig,
			`bindings.${bindingEnv}.app.worker_name`,
		)
		if (appWorkerName) {
			config.services = [
				{
					binding: 'APP',
					service: appWorkerName,
				},
			]
			patches.push(`services.APP ← ${appWorkerName}`)
		}
	}

	patchRoutesForApp(appKey, deployEnv, config, launchConfig, patches)

	if (requireBindings && missing.length > 0) {
		console.error(
			`Missing required binding env vars for ${appKey} (${deployEnv}): ${missing.join(', ')}`,
		)
		console.error('Set GitHub repository variables or run npm run launch:setup')
		process.exit(1)
	}

	delete config.account_id

	writeJsonc(outputPath, config)
	console.log(`Wrote ${outputPath}`)
	console.log(
		'  Deploy: npx wrangler deploy --config dist/server/wrangler.deploy.json --env=""',
	)
	if (patches.length > 0) {
		console.log(patches.map((line) => `  • ${line}`).join('\n'))
	}
	return outputPath
}

function main() {
	const args = parseArgs(process.argv)
	const launchConfig = loadLaunchConfig()

	if (APPS[args.app].format === 'jsonc') {
		patchJsoncApp(args.app, args.env, launchConfig, args.requireBindings)
		return
	}
	if (usesAstroWorkerBuild(args.app)) {
		patchAstroTomlApp(args.app, args.env, launchConfig, args.requireBindings)
		return
	}
	patchTomlApp(args.app, args.env, launchConfig, args.requireBindings)
}

main()
