function stripJsoncComments(content) {
	return content.replace(
		/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g,
		(match, stringGroup) => {
			if (stringGroup) return stringGroup
			return ''
		},
	)
}

/**
 * Infer launch.config values from wrangler CLI, Cloudflare API, and local .env files.
 *
 * @see scripts/launch-setup.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CF_D1, CF_KV, CF_R2 } from './cloudflare-resource-names.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const D1_BY_NAME = {
	[CF_D1.app]: ['production', 'app', 'd1_database_id'],
	[CF_D1.appStaging]: ['staging', 'app', 'd1_database_id'],
	[CF_D1.web]: ['production', 'web', 'd1_database_id'],
	[CF_D1.webStaging]: ['staging', 'web', 'd1_database_id'],
}

const KV_NAME_HINTS = {
	production: [CF_KV.app],
	staging: [CF_KV.appStaging],
}

const R2_NAME_HINTS = {
	production: [CF_R2.web],
	staging: [CF_R2.webStaging],
}

function tryWrangler(args, cwd) {
	const result = spawnSync('npx', ['wrangler', ...args], {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.status !== 0) {
		return {
			ok: false,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
		}
	}
	return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function parseAccountIdFromWhoami(output) {
	const match = output.match(/│[^│]+│\s*([0-9a-f]{32})\s*│/i)
	return match?.[1] ?? null
}

function readEnvValue(envPath, key) {
	if (!existsSync(envPath)) return null
	const content = readFileSync(envPath, 'utf8')
	const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
	if (!match) return null
	return match[1].replace(/^["']|["']$/g, '').trim() || null
}

function readWorkerNameFromWranglerConfig(configPath) {
	if (!existsSync(configPath)) return null
	const content = readFileSync(configPath, 'utf8')
	const jsonMatch = content.match(/"name"\s*:\s*"([^"]+)"/)
	if (jsonMatch) return jsonMatch[1]
	const tomlMatch = content.match(/^name\s*=\s*"([^"]+)"/m)
	return tomlMatch?.[1] ?? null
}

function readTomlValue(configPath, key) {
	if (!existsSync(configPath)) return null
	const content = readFileSync(configPath, 'utf8')
	const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))
	return match?.[1] ?? null
}

function readJsoncBinding(configPath, bindingKey, field) {
	if (!existsSync(configPath)) return null
	const content = readFileSync(configPath, 'utf8')
	const stripped = stripJsoncComments(content)
	const withoutTrailingCommas = stripped.replace(/,(\s*[}\]])/g, '$1')
	try {
		const config = JSON.parse(withoutTrailingCommas)
		const list = config[bindingKey]
		if (!Array.isArray(list) || list.length === 0) return null
		return list[0][field] ?? null
	} catch {
		return null
	}
}

function pickKvNamespace(namespaces, hints) {
	for (const hint of hints) {
		const exact = namespaces.find((ns) => ns.title === hint || ns.name === hint)
		if (exact) return exact.id
	}
	const fuzzy = namespaces.find((ns) => {
		const title = (ns.title ?? ns.name ?? '').toLowerCase()
		return hints.some((hint) => title.includes(hint.toLowerCase()))
	})
	return fuzzy?.id ?? null
}

function isPlaceholderBindingId(value) {
	if (!value) return true
	return (
		value.startsWith('00000000-0000-0000-0000-00000000000') ||
		value === '00000000000000000000000000000001'
	)
}

function pickR2Bucket(output, hints) {
	for (const hint of hints) {
		const match = output.match(new RegExp(`name:\\s+${hint}\\b`, 'i'))
		if (match) return hint
	}
	for (const hint of hints) {
		if (output.toLowerCase().includes(hint.toLowerCase())) return hint
	}
	return null
}

function setBinding(target, env, app, field, value) {
	if (!value) return
	if (!target.bindings[env]) target.bindings[env] = {}
	if (!target.bindings[env][app]) target.bindings[env][app] = {}
	target.bindings[env][app][field] = value
}

function inferRepoUrls(rootDir) {
	const appEnv = join(rootDir, 'apps/app/.env')
	const adminEnv = join(rootDir, 'apps/admin/.env')
	const sitesEnv = join(rootDir, 'apps/sites/.env')

	const rootApp = readEnvValue(appEnv, 'ROOT_APP')
	const appBaseUrl = readEnvValue(appEnv, 'BASE_URL')
	const adminBaseUrl = readEnvValue(adminEnv, 'BASE_URL')
	const tenantApiUrl = readEnvValue(appEnv, 'TENANT_API_URL')
	const tenantApiUrlKsa = readEnvValue(appEnv, 'TENANT_API_URL_KSA')
	const publicAppUrl = readEnvValue(sitesEnv, 'PUBLIC_APP_URL') ?? appBaseUrl

	let apex = rootApp
	if (!apex && appBaseUrl) {
		try {
			apex = new URL(appBaseUrl).hostname.replace(/^app\./, '')
		} catch {
			apex = null
		}
	}

	const jobsCronWorkerUrl = apex ? `https://jobs.${apex}` : null

	return {
		root_app: rootApp,
		app_base_url: appBaseUrl,
		admin_base_url: adminBaseUrl,
		public_app_url: publicAppUrl,
		tenant_api_url: tenantApiUrl,
		tenant_api_url_ksa: tenantApiUrlKsa,
		jobs_cron_worker_url: jobsCronWorkerUrl,
		apex,
	}
}

function readJsoncEnvName(configPath, envName) {
	if (!existsSync(configPath)) return null
	const content = readFileSync(configPath, 'utf8')
	const envSection = new RegExp(
		`"${envName}"\\s*:\\s*\\{[\\s\\S]*?"name"\\s*:\\s*"([^"]+)"`,
		'm',
	)
	const match = content.match(envSection)
	if (match?.[1]) return match[1]

	const stripped = stripJsoncComments(content)
	const withoutTrailingCommas = stripped.replace(/,(\s*[}\]])/g, '$1')
	try {
		const config = JSON.parse(withoutTrailingCommas)
		return config.env?.[envName]?.name ?? null
	} catch {
		return null
	}
}

function readTomlEnvName(configPath, envName) {
	if (!existsSync(configPath)) return null
	const content = readFileSync(configPath, 'utf8')
	const section = new RegExp(
		`\\[env\\.${envName}\\][\\s\\S]*?^name\\s*=\\s*"([^"]+)"`,
		'm',
	)
	const match = content.match(section)
	return match?.[1] ?? null
}

function inferWorkerNames(rootDir) {
	const production = {
		app: readWorkerNameFromWranglerConfig(
			join(rootDir, 'apps/app/wrangler.jsonc'),
		),
		admin: readWorkerNameFromWranglerConfig(
			join(rootDir, 'apps/admin/wrangler.jsonc'),
		),
		web: readWorkerNameFromWranglerConfig(
			join(rootDir, 'apps/web/wrangler.toml'),
		),
		sites: readWorkerNameFromWranglerConfig(
			join(rootDir, 'apps/sites/wrangler.toml'),
		),
		jobs_cron: readWorkerNameFromWranglerConfig(
			join(rootDir, 'apps/jobs-cron/wrangler.jsonc'),
		),
		tenant_api: readWorkerNameFromWranglerConfig(
			join(rootDir, 'apps/tenant-api/wrangler.jsonc'),
		),
	}
	const staging = {
		app: readJsoncEnvName(join(rootDir, 'apps/app/wrangler.jsonc'), 'staging'),
		admin: readJsoncEnvName(
			join(rootDir, 'apps/admin/wrangler.jsonc'),
			'staging',
		),
		web: readTomlEnvName(join(rootDir, 'apps/web/wrangler.toml'), 'staging'),
		sites: readTomlEnvName(
			join(rootDir, 'apps/sites/wrangler.toml'),
			'staging',
		),
		jobs_cron: readJsoncEnvName(
			join(rootDir, 'apps/jobs-cron/wrangler.jsonc'),
			'staging',
		),
		tenant_api: readJsoncEnvName(
			join(rootDir, 'apps/tenant-api/wrangler.jsonc'),
			'staging',
		),
	}
	return { production, staging }
}

function parseGitHubRemoteUrl(remoteUrl) {
	const trimmed = remoteUrl.trim()
	const patterns = [
		/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
		/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
		/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
	]
	for (const pattern of patterns) {
		const match = trimmed.match(pattern)
		if (match) {
			return `${match[1]}/${match[2]}`
		}
	}
	return null
}

function tryGitOriginRepo(rootDir) {
	const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
		cwd: rootDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.status !== 0) return null
	const nameWithOwner = parseGitHubRemoteUrl(result.stdout)
	if (!nameWithOwner) return null
	return {
		nameWithOwner,
		url: `https://github.com/${nameWithOwner}`,
	}
}

function tryGhRepoView(rootDir) {
	const result = spawnSync(
		'gh',
		['repo', 'view', '--json', 'url,nameWithOwner'],
		{
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	)
	if (result.status !== 0) return null
	try {
		const data = JSON.parse(result.stdout)
		if (!data.nameWithOwner || !data.url) return null
		return { nameWithOwner: data.nameWithOwner, url: data.url }
	} catch {
		return null
	}
}

/** Prefer git `origin` — `gh repo view` alone can target a stale default repo. */
export function resolveGitHubRepo(rootDir) {
	return tryGitOriginRepo(rootDir) ?? tryGhRepoView(rootDir)
}

/**
 * @param {string} rootDir
 */
export async function inferLaunchConfig(rootDir) {
	const result = {
		wranglerLoggedIn: false,
		accountId: null,
		githubRepo: resolveGitHubRepo(rootDir),
		bindings: {
			production: {
				app: {},
				admin: {},
				web: {},
				sites: {},
				jobs_cron: {},
				tenant_api: {},
			},
			staging: {
				app: {},
				admin: {},
				web: {},
				sites: {},
				jobs_cron: {},
				tenant_api: {},
			},
		},
		urls: inferRepoUrls(rootDir),
		notes: [],
	}

	const whoami = tryWrangler(['whoami'], join(rootDir, 'apps/app'))
	if (!whoami.ok) {
		result.notes.push(
			'wrangler whoami failed — run `npx wrangler login` to auto-detect Cloudflare resources',
		)
		return result
	}

	result.wranglerLoggedIn = true
	result.accountId = parseAccountIdFromWhoami(whoami.stdout)

	const d1 = tryWrangler(['d1', 'list', '--json'], join(rootDir, 'apps/app'))
	if (d1.ok) {
		try {
			const databases = JSON.parse(d1.stdout)
			for (const db of databases) {
				const mapping = D1_BY_NAME[db.name]
				if (!mapping) continue
				const [env, app, field] = mapping
				setBinding(result, env, app, field, db.uuid)
				if (app === 'app') {
					setBinding(result, env, 'admin', field, db.uuid)
				}
			}
			if (result.bindings.production.app.d1_database_id) {
				result.notes.push(
					`D1 ${CF_D1.app}: ${result.bindings.production.app.d1_database_id}`,
				)
			}
		} catch {
			result.notes.push('Could not parse `wrangler d1 list --json` output')
		}
	}

	const kv = tryWrangler(['kv', 'namespace', 'list'], join(rootDir, 'apps/app'))
	if (kv.ok) {
		try {
			const namespaces = JSON.parse(kv.stdout)
			const prodKv = pickKvNamespace(namespaces, KV_NAME_HINTS.production)
			const stagingKv = pickKvNamespace(namespaces, KV_NAME_HINTS.staging)
			if (prodKv) {
				setBinding(result, 'production', 'app', 'kv_namespace_id', prodKv)
				setBinding(result, 'production', 'admin', 'kv_namespace_id', prodKv)
				result.notes.push(`KV namespace (prod): ${prodKv}`)
			}
			if (stagingKv) {
				setBinding(result, 'staging', 'app', 'kv_namespace_id', stagingKv)
				setBinding(result, 'staging', 'admin', 'kv_namespace_id', stagingKv)
				result.notes.push(`KV namespace (staging): ${stagingKv}`)
			}
			const prodSitesKv = pickKvNamespace(namespaces, [CF_KV.sitesData])
			const stagingSitesKv = pickKvNamespace(namespaces, [CF_KV.sitesDataStaging])
			if (prodSitesKv) {
				setBinding(result, 'production', 'sites', 'sites_data_kv_id', prodSitesKv)
				setBinding(result, 'production', 'app', 'sites_data_kv_id', prodSitesKv)
				result.notes.push(`KV sites data (prod): ${prodSitesKv}`)
			}
			if (stagingSitesKv) {
				setBinding(result, 'staging', 'sites', 'sites_data_kv_id', stagingSitesKv)
				setBinding(result, 'staging', 'app', 'sites_data_kv_id', stagingSitesKv)
				result.notes.push(`KV sites data (staging): ${stagingSitesKv}`)
			}
		} catch {
			result.notes.push('Could not parse `wrangler kv namespace list` output')
		}
	}

	const r2 = tryWrangler(['r2', 'bucket', 'list'], join(rootDir, 'apps/web'))
	if (r2.ok) {
		const prodBucket = pickR2Bucket(r2.stdout, R2_NAME_HINTS.production)
		const stagingBucket = pickR2Bucket(r2.stdout, R2_NAME_HINTS.staging)
		if (prodBucket) {
			setBinding(result, 'production', 'web', 'r2_bucket_name', prodBucket)
			result.notes.push(`R2 bucket (prod): ${prodBucket}`)
		}
		if (stagingBucket) {
			setBinding(result, 'staging', 'web', 'r2_bucket_name', stagingBucket)
			result.notes.push(`R2 bucket (staging): ${stagingBucket}`)
		}
	}

	const wranglerBindings = {
		production: {
			app: {
				d1_database_id: readJsoncBinding(
					join(rootDir, 'apps/app/wrangler.jsonc'),
					'd1_databases',
					'database_id',
				),
				kv_namespace_id: readJsoncBinding(
					join(rootDir, 'apps/app/wrangler.jsonc'),
					'kv_namespaces',
					'id',
				),
			},
			web: {
				d1_database_id: readTomlValue(
					join(rootDir, 'apps/web/wrangler.toml'),
					'database_id',
				),
				r2_bucket_name: readTomlValue(
					join(rootDir, 'apps/web/wrangler.toml'),
					'bucket_name',
				),
			},
		},
	}

	for (const [env, apps] of Object.entries(wranglerBindings)) {
		for (const [app, fields] of Object.entries(apps)) {
			for (const [field, value] of Object.entries(fields)) {
				if (value && !isPlaceholderBindingId(value)) {
					setBinding(result, env, app, field, value)
				}
			}
		}
	}

	const workerNames = inferWorkerNames(rootDir)
	for (const [env, apps] of Object.entries(workerNames)) {
		for (const [app, name] of Object.entries(apps)) {
			if (name) setBinding(result, env, app, 'worker_name', name)
		}
	}

	if (result.urls.apex) {
		result.notes.push(`Platform domain from .env: ${result.urls.apex}`)
	}
	if (result.urls.jobs_cron_worker_url) {
		result.notes.push(`Jobs cron URL: ${result.urls.jobs_cron_worker_url}`)
	}
	if (result.githubRepo?.nameWithOwner) {
		result.notes.push(
			`GitHub repo (origin): ${result.githubRepo.nameWithOwner}`,
		)
	}

	return result
}

export function printInferredSummary(inferred, log) {
	if (inferred.notes.length === 0) {
		log(
			'No Cloudflare resources auto-detected (wrangler login may be required).',
			'gray',
		)
		return
	}
	log('\nAuto-detected from wrangler / local .env:', 'bright')
	for (const note of inferred.notes) {
		log(`  • ${note}`, 'green')
	}
}

/**
 * Merge inferred bindings into a launch config object (inferred wins when present).
 */
export function mergeInferredBindings(config, inferred) {
	for (const env of ['production', 'staging']) {
		for (const app of Object.keys(config.bindings[env] ?? {})) {
			const detected = inferred.bindings[env]?.[app] ?? {}
			config.bindings[env][app] = {
				...config.bindings[env][app],
				...Object.fromEntries(
					Object.entries(detected).filter(([, value]) => Boolean(value)),
				),
			}
		}
	}
}
