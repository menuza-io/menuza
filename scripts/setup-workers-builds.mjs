#!/usr/bin/env node
/**
 * Configure Cloudflare Workers Builds from launch.config.json.
 *
 * Cloudflare still requires one browser step to authorize its GitHub App. After
 * that, this script creates the exact repository connection, configures a
 * manual-only build trigger for every Worker/environment, syncs build variables,
 * and writes the trigger UUIDs to GitHub Actions Variables.
 *
 * Usage:
 *   npm run launch:workers-builds
 *   npm run launch:workers-builds -- --app jobs-cron
 *   npm run launch:workers-builds -- --tier production
 *   npm run launch:workers-builds -- --dry-run
 *
 * @see docs/workers-builds.md
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getGhVariables, ghVariablesToBuildEnv } from './launch-github-vars.mjs'
import { resolveGitHubRepo } from './wrangler-infer.mjs'
import { WORKERS_BUILDS_MANIFEST } from './workers-builds-manifest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')
const statePath = join(rootDir, 'launch.workers-builds.json')

if (existsSync(join(rootDir, '.env'))) {
	for (const line of readFileSync(join(rootDir, '.env'), 'utf8').split('\n')) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/)
		if (match && !process.env[match[1]]) {
			process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
		}
	}
}

const BUILD_COMMAND_PREFIX = 'node scripts/cf-workers-ci.mjs build --app'
const DEPLOY_COMMAND_PREFIX = 'node scripts/cf-workers-ci.mjs deploy --app'
const DEPLOY_TIERS = ['production', 'staging']

function log(message) {
	console.log(message)
}

/** Strip values that look like API tokens or secrets from a string. */
function redactSecrets(message) {
	// Cloudflare API tokens are 40-char alphanumeric; redact any long hex-ish runs.
	return String(message).replace(/[A-Za-z0-9_-]{32,}/g, (match) =>
		// Keep UUIDs (contain dashes) and known safe patterns; redact the rest.
		/^[0-9a-f]{8}-/.test(match) ? match : `${match.slice(0, 4)}…[REDACTED]`,
	)
}

function parseArgs(argv) {
	const args = {
		app: null,
		tier: null,
		dryRun: false,
		applyGh: true,
		buildTokenUuid: process.env.CLOUDFLARE_BUILD_TOKEN_UUID || null,
		purgeCache: false,
	}
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--app') args.app = argv[++i]
		else if (arg === '--tier') args.tier = argv[++i]
		else if (arg === '--build-token') args.buildTokenUuid = argv[++i]
		else if (arg === '--dry-run') args.dryRun = true
		else if (arg === '--no-gh') args.applyGh = false
		else if (arg === '--purge-cache') args.purgeCache = true
		else if (arg === '--help' || arg === '-h') {
			console.log(
				'Usage: npm run launch:workers-builds [-- --app <app>] [--tier <production|staging>] [--build-token <uuid>] [--purge-cache] [--dry-run] [--no-gh]',
			)
			process.exit(0)
		}
	}
	return args
}

function loadLaunchConfig() {
	const path = join(rootDir, 'launch.config.json')
	if (!existsSync(path)) {
		throw new Error('Missing launch.config.json — run: npm run launch:setup')
	}
	return JSON.parse(readFileSync(path, 'utf8'))
}

function loadState() {
	if (!existsSync(statePath)) return { triggers: {} }
	return JSON.parse(readFileSync(statePath, 'utf8'))
}

function saveState(state) {
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

function ghAvailable() {
	return (
		spawnSync('gh', ['auth', 'status'], {
			cwd: rootDir,
			stdio: 'ignore',
		}).status === 0
	)
}

function setGhVariable(repo, name, value) {
	const result = spawnSync(
		'gh',
		['variable', 'set', name, '--body', value, '--repo', repo.nameWithOwner],
		{ cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	)
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `Could not set ${name}`)
	}
}

function requireValue(value, name) {
	if (!value) throw new Error(`Missing ${name}`)
	return value
}

async function cfApi(accountId, token, path, { method = 'GET', body } = {}) {
	const request = {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
	}
	if (body !== undefined) request.body = JSON.stringify(body)
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
		request,
	)
	const json = await response.json()
	if (!response.ok || !json.success) {
		const message =
			json.errors?.map((error) => error.message).join('; ') ||
			`HTTP ${response.status}`
		throw new Error(`${method} ${path}: ${message}`)
	}
	return json.result
}

async function getGitHubRepoMetadata(repo) {
	const endpoint = `repos/${repo.nameWithOwner}`
	const ghResult = spawnSync('gh', ['api', endpoint], {
		cwd: rootDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	let data
	if (ghResult.status === 0) {
		data = JSON.parse(ghResult.stdout)
	} else {
		const response = await fetch(`https://api.github.com/${endpoint}`, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'menuza-workers-builds-setup',
			},
		})
		if (!response.ok) {
			throw new Error(
				`Could not read GitHub repository metadata for ${repo.nameWithOwner}. Run gh auth login for a private repository.`,
			)
		}
		data = await response.json()
	}

	return {
		provider_type: 'github',
		provider_account_id: String(data.owner.id),
		provider_account_name: data.owner.login,
		repo_id: String(data.id),
		repo_name: data.name,
	}
}

async function upsertRepoConnection(accountId, token, repo) {
	const metadata = await getGitHubRepoMetadata(repo)
	return cfApi(accountId, token, '/builds/repos/connections', {
		method: 'PUT',
		body: metadata,
	})
}

async function getWorkerTag(accountId, token, workerName) {
	const scripts = await cfApi(accountId, token, '/workers/scripts')
	const match = scripts.find((script) => script.id === workerName)
	if (!match?.tag) {
		throw new Error(
			`Could not resolve Worker tag for ${workerName}. Deploy that environment once, then retry.`,
		)
	}
	return match.tag
}

async function listBuildTokens(accountId, token) {
	return cfApi(accountId, token, '/builds/tokens')
}

async function listTriggers(accountId, token, workerTag) {
	return cfApi(accountId, token, `/builds/workers/${workerTag}/triggers`)
}

async function createTrigger(accountId, token, payload) {
	return cfApi(accountId, token, '/builds/triggers', {
		method: 'POST',
		body: payload,
	})
}

async function updateTrigger(accountId, token, triggerUuid, payload) {
	const {
		external_script_id: _ignoredScriptId,
		repo_connection_uuid: _ignoredRepoUuid,
		...updatePayload
	} = payload
	return cfApi(accountId, token, `/builds/triggers/${triggerUuid}`, {
		method: 'PATCH',
		body: updatePayload,
	})
}

async function deleteTrigger(accountId, token, triggerUuid) {
	return cfApi(accountId, token, `/builds/triggers/${triggerUuid}`, {
		method: 'DELETE',
	})
}

export async function purgeTriggerCache(accountId, token, triggerUuid) {
	return cfApi(
		accountId,
		token,
		`/builds/triggers/${triggerUuid}/purge_build_cache`,
		{ method: 'POST' },
	)
}

async function patchTriggerEnv(accountId, token, triggerUuid, env) {
	return cfApi(
		accountId,
		token,
		`/builds/triggers/${triggerUuid}/environment_variables`,
		{ method: 'PATCH', body: env },
	)
}

function workerNameForEntry(config, entry, tier) {
	return config.bindings[tier]?.[entry.bindingKey]?.worker_name
}

function triggerVariable(entry, tier) {
	return `${entry.triggerVar}_${tier.toUpperCase()}`
}

function buildTriggerPayload({
	workerTag,
	repoConnectionUuid,
	buildTokenUuid,
	entry,
	tier,
	workerName,
}) {
	return {
		external_script_id: workerTag,
		repo_connection_uuid: repoConnectionUuid,
		build_token_uuid: buildTokenUuid,
		trigger_name: `${workerName || `menuza-${entry.app}-${tier}`}-ci`,
		build_command: `${BUILD_COMMAND_PREFIX} ${entry.app}`,
		deploy_command: `${DEPLOY_COMMAND_PREFIX} ${entry.app}`,
		root_directory: '/',
		// GitHub Actions starts builds only after CI passes. Using a dedicated branch
		// name with empty excludes prevents Cloudflare from building automatically on git push,
		// while adhering to Cloudflare API's schema requirements.
		branch_includes: ['cf-builds-manual-only'],
		branch_excludes: [],
		path_includes: entry.watchPaths,
		path_excludes: [],
		// Dependency caching is disabled because cf-workers-ci.mjs uses SKIP_DEPENDENCY_INSTALL: 1
		// and runs a deterministic npm ci. Archiving large monorepo node_modules is redundant
		// and causes extraction crashes ("Failed: error occurred while installing tools or dependencies")
		// during Cloudflare's tool bootstrap phase.
		build_caching_enabled: false,
	}
}

function reusableTrigger(triggers, triggerName, repoConnectionUuid) {
	return (
		triggers.find((trigger) => trigger.trigger_name === triggerName) ??
		triggers.find(
			(trigger) =>
				trigger.trigger_name?.includes('-ci') &&
				trigger.repo_connection?.repo_connection_uuid === repoConnectionUuid,
		) ??
		triggers.find(
			(trigger) =>
				trigger.repo_connection?.repo_connection_uuid === repoConnectionUuid &&
				trigger.branch_includes?.includes('main'),
		) ??
		triggers.find((trigger) => trigger.branch_includes?.includes('main')) ??
		(triggers.length === 1 ? triggers[0] : null)
	)
}

async function ensureTrigger({
	accountId,
	token,
	workerTag,
	repoConnectionUuid,
	buildTokenUuid,
	entry,
	tier,
	workerName,
}) {
	const payload = buildTriggerPayload({
		workerTag,
		repoConnectionUuid,
		buildTokenUuid,
		entry,
		tier,
		workerName,
	})
	const triggers = await listTriggers(accountId, token, workerTag)
	const existing = reusableTrigger(
		triggers,
		payload.trigger_name,
		repoConnectionUuid,
	)

	let triggerUuid
	if (existing?.trigger_uuid) {
		const updated = await updateTrigger(
			accountId,
			token,
			existing.trigger_uuid,
			payload,
		)
		triggerUuid = updated.trigger_uuid ?? existing.trigger_uuid
		log(`  updated trigger: ${payload.trigger_name} (${triggerUuid})`)
	} else {
		const created = await createTrigger(accountId, token, payload)
		triggerUuid = created.trigger_uuid
		log(`  created trigger: ${payload.trigger_name} (${triggerUuid})`)
	}

	// Dashboard-created preview triggers ("Deploy non-production branches") or legacy triggers
	// would run on every git push before GHA CI completes. Delete them so only
	// our dedicated manual/CI trigger remains.
	for (const trigger of triggers) {
		if (!trigger.trigger_uuid || trigger.trigger_uuid === triggerUuid) continue
		if (
			trigger.repo_connection?.repo_connection_uuid &&
			trigger.repo_connection.repo_connection_uuid !== repoConnectionUuid
		) {
			continue
		}
		try {
			await deleteTrigger(accountId, token, trigger.trigger_uuid)
			log(
				`  deleted unmanaged trigger: ${trigger.trigger_name} (${trigger.trigger_uuid})`,
			)
		} catch (error) {
			log(
				`  warning: could not delete unmanaged trigger ${trigger.trigger_uuid}: ${error.message}`,
			)
		}
	}

	return triggerUuid
}

function selectBuildToken(tokens, preferredUuid) {
	if (preferredUuid) {
		const preferred = tokens.find(
			(item) => item.build_token_uuid === preferredUuid,
		)
		if (!preferred) {
			throw new Error(
				`CLOUDFLARE_BUILD_TOKEN_UUID ${preferredUuid} was not found in this account.`,
			)
		}
		return preferred
	}

	const named = tokens.find((item) =>
		item.build_token_name?.toLowerCase().includes('menuza'),
	)
	if (named) return named
	if (tokens.length === 1) return tokens[0]
	if (tokens.length === 0) {
		throw new Error(
			'No Workers Builds API token exists. In a Worker, open Settings → Builds and create/select an API token.',
		)
	}

	throw new Error(
		`Multiple Workers Builds API tokens exist (${tokens
			.map((item) => `${item.build_token_name}: ${item.build_token_uuid}`)
			.join(', ')}). Set CLOUDFLARE_BUILD_TOKEN_UUID and retry.`,
	)
}

async function findExistingBuildTokenUuid(accountId, token, plans) {
	for (const { workerName } of plans) {
		if (!workerName) continue
		try {
			const workerTag = await getWorkerTag(accountId, token, workerName)
			const triggers = await listTriggers(accountId, token, workerTag)
			const triggerWithToken = triggers.find(
				(trigger) => trigger.build_token_uuid,
			)
			if (triggerWithToken) return triggerWithToken.build_token_uuid
		} catch {
			// A missing environment is reported during the per-Worker setup below.
		}
	}
	return null
}

export function workersBuildsSettingsUrl(accountId, workerName) {
	return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers/services/view/${encodeURIComponent(workerName)}/production/settings/builds`
}

export async function configureWorkersBuilds({
	config = loadLaunchConfig(),
	accountId,
	token,
	githubRepo = resolveGitHubRepo(rootDir),
	app = null,
	tiers = DEPLOY_TIERS,
	dryRun = false,
	applyGh = true,
	buildTokenUuid = process.env.CLOUDFLARE_BUILD_TOKEN_UUID || null,
	purgeCache = false,
} = {}) {
	const selectedManifest = app
		? WORKERS_BUILDS_MANIFEST.filter((entry) => entry.app === app)
		: WORKERS_BUILDS_MANIFEST
	const selectedTiers = tiers.filter((tier) => DEPLOY_TIERS.includes(tier))

	if (selectedManifest.length === 0) throw new Error(`Unknown app: ${app}`)
	if (selectedTiers.length === 0) {
		throw new Error('Choose at least one tier: production or staging')
	}
	if (!githubRepo?.nameWithOwner) {
		throw new Error('Could not detect a GitHub repository from git origin.')
	}

	const plans = selectedManifest.flatMap((entry) =>
		selectedTiers.map((tier) => ({
			entry,
			tier,
			workerName: workerNameForEntry(config, entry, tier),
		})),
	)

	if (dryRun) {
		log('\n[dry-run] Workers Builds plan:')
		for (const { entry, tier, workerName } of plans) {
			log(
				`  ${entry.app}/${tier}: ${workerName || '(missing worker name)'} → ${triggerVariable(entry, tier)}`,
			)
		}
		return { configured: [], failures: [], state: loadState() }
	}

	const resolvedAccountId = requireValue(
		accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
		'CLOUDFLARE_ACCOUNT_ID',
	)
	const resolvedToken = requireValue(
		token ??
			process.env.CLOUDFLARE_BUILDS_API_TOKEN ??
			process.env.CLOUDFLARE_API_TOKEN,
		'CLOUDFLARE_BUILDS_API_TOKEN (or CLOUDFLARE_API_TOKEN)',
	)
	const state = loadState()
	const buildEnv = ghVariablesToBuildEnv(getGhVariables(config))
	const repoConnection = await upsertRepoConnection(
		resolvedAccountId,
		resolvedToken,
		githubRepo,
	)
	const repoConnectionUuid = requireValue(
		repoConnection.repo_connection_uuid,
		'Cloudflare repository connection UUID',
	)
	const detectedBuildTokenUuid =
		buildTokenUuid ||
		(await findExistingBuildTokenUuid(resolvedAccountId, resolvedToken, plans))
	const buildToken = selectBuildToken(
		await listBuildTokens(resolvedAccountId, resolvedToken),
		detectedBuildTokenUuid,
	)

	log(`\nUsing GitHub repository ${githubRepo.nameWithOwner}`)
	log(
		`Using Workers Builds token ${buildToken.build_token_name} (${buildToken.build_token_uuid})`,
	)

	const configured = []
	const failures = []
	for (const { entry, tier, workerName } of plans) {
		if (!workerName) {
			failures.push({
				app: entry.app,
				tier,
				message: 'missing worker_name in launch.config.json',
			})
			continue
		}

		log(`\n⚙️  ${entry.app}/${tier} (${workerName})`)
		try {
			const workerTag = await getWorkerTag(
				resolvedAccountId,
				resolvedToken,
				workerName,
			)
			const triggerUuid = await ensureTrigger({
				accountId: resolvedAccountId,
				token: resolvedToken,
				workerTag,
				repoConnectionUuid,
				buildTokenUuid: buildToken.build_token_uuid,
				entry,
				tier,
				workerName,
			})
			await patchTriggerEnv(
				resolvedAccountId,
				resolvedToken,
				triggerUuid,
				buildEnv,
			)
			log(`  synced ${Object.keys(buildEnv).length} build variables`)

			if (purgeCache) {
				try {
					await purgeTriggerCache(resolvedAccountId, resolvedToken, triggerUuid)
					log('  purged trigger build cache')
				} catch (purgeError) {
					log(
						`  warning: could not purge cache for ${triggerUuid}: ${purgeError instanceof Error ? purgeError.message : String(purgeError)}`,
					)
				}
			}

			const variable = triggerVariable(entry, tier)
			state.triggers[entry.app] ??= {}
			state.triggers[entry.app][tier] = {
				workerName,
				triggerUuid,
				triggerVar: variable,
			}
			configured.push({
				app: entry.app,
				tier,
				workerName,
				triggerUuid,
				triggerVar: variable,
				dashboardUrl: workersBuildsSettingsUrl(resolvedAccountId, workerName),
			})
		} catch (error) {
			failures.push({
				app: entry.app,
				tier,
				message: error instanceof Error ? error.message : String(error),
			})
			log(`  failed: ${failures.at(-1).message}`)
		}
	}

	saveState(state)

	if (applyGh && ghAvailable()) {
		log('\n📦 Applying GitHub Actions trigger variables:')
		for (const item of configured) {
			setGhVariable(githubRepo, item.triggerVar, item.triggerUuid)
			log(`  set ${item.triggerVar}`)
		}
	} else if (configured.length > 0) {
		log('\n📦 Set these GitHub Actions Variables manually:')
		for (const item of configured) {
			log(`  ${item.triggerVar}=${item.triggerUuid}`)
		}
	}

	return { configured, failures, state }
}

async function main() {
	const args = parseArgs(process.argv)
	if (args.tier && !DEPLOY_TIERS.includes(args.tier)) {
		throw new Error(`Unknown tier: ${args.tier}`)
	}

	if (!args.dryRun) {
		log('\nOne-time prerequisite:')
		log('  Open any Worker → Settings → Builds → Connect')
		log('  Authorize the Cloudflare GitHub App for this repository.')
	}

	const result = await configureWorkersBuilds({
		app: args.app,
		tiers: args.tier ? [args.tier] : DEPLOY_TIERS,
		dryRun: args.dryRun,
		applyGh: args.applyGh,
		buildTokenUuid: args.buildTokenUuid,
		purgeCache: args.purgeCache,
	})

	if (args.dryRun) return
	if (result.failures.length > 0) {
		log('\n⚠️  Workers Builds was only partially configured:')
		for (const failure of result.failures) {
			log(`  ${failure.app}/${failure.tier}: ${failure.message}`)
		}
		process.exitCode = 1
		return
	}

	log('\n✅ Workers Builds configured.')
	log('   GHA triggers exact tested commits after CI passes.')
	log('   State saved to launch.workers-builds.json (gitignored).\n')
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
	main().catch((error) => {
		console.error(redactSecrets(error.message))
		process.exit(1)
	})
}
