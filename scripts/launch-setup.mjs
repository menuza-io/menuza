#!/usr/bin/env node
/**
 * Interactive first-time launch setup for Epic Startup.
 *
 * - Creates Cloudflare D1 / KV / R2 resources (optional)
 * - Writes launch.config.json for local patching
 * - Generates shared secrets in launch.secrets.json (gitignored)
 * - Applies generated Wrangler secrets after deploy (optional)
 * - Configures Cloudflare Workers Builds after the first deploy (optional)
 * - Prints GitHub Variables/Secrets commands
 * - Opens Cloudflare / GitHub setup pages (optional)
 *
 * Usage: npm run launch:setup
 *
 * @see docs/launch-checklist.md
 */

import { execSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { confirm, input, password, select } from '@inquirer/prompts'
import { CF_D1, CF_KV, CF_R2 } from './cloudflare-resource-names.mjs'
import { getGhVariables } from './launch-github-vars.mjs'
import {
	configureWorkersBuilds,
	workersBuildsSettingsUrl,
} from './setup-workers-builds.mjs'
import { stagingHostnames } from './staging-hostnames.mjs'
import {
	inferLaunchConfig,
	mergeInferredBindings,
	printInferredSummary,
} from './wrangler-infer.mjs'

function readConfiguredBrandDomain() {
	try {
		const brandPath = join(rootDir, 'packages/config/brand.ts')
		const content = readFileSync(brandPath, 'utf8')
		return content.match(/^\tdomain:\s*'([^']+)'/m)?.[1] ?? ''
	} catch {
		return ''
	}
}

function readConfiguredLocalDomain() {
	try {
		const brandPath = join(rootDir, 'packages/config/brand.ts')
		const content = readFileSync(brandPath, 'utf8')
		const slug = content.match(/^\tslug:\s*'([^']+)'/m)?.[1]
		return slug ? `${slug}.test` : 'epic-startup.test'
	} catch {
		return 'epic-startup.test'
	}
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

const colors = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[36m',
	gray: '\x1b[90m',
}

function log(message, color = 'reset') {
	console.log(`${colors[color]}${message}${colors.reset}`)
}

/** Strip values that look like API tokens or secrets from a string. */
function redactSecrets(message) {
	return String(message).replace(/[A-Za-z0-9_-]{32,}/g, (match) =>
		/^[0-9a-f]{8}-/.test(match) ? match : `${match.slice(0, 4)}…[REDACTED]`,
	)
}

function randomHex(bytes) {
	return crypto.randomBytes(bytes).toString('hex')
}

function isValidUrl(value) {
	try {
		new URL(value)
		return true
	} catch {
		return false
	}
}

async function promptLaunchStatus() {
	return select({
		message: 'Product launch phase (LAUNCH_STATUS on App and Admin)',
		choices: [
			{
				name: 'Closed beta — waitlist; admins grant early access; billing hidden',
				value: 'CLOSED_BETA',
				description: 'Typical for first launch',
			},
			{
				name: 'Public beta — full app without Stripe checkout',
				value: 'PUBLIC_BETA',
			},
			{
				name: 'Launched — full product including subscriptions and billing',
				value: 'LAUNCHED',
			},
		],
		default: 'CLOSED_BETA',
	})
}

async function promptCreditCardRequiredForTrial() {
	return select({
		message: 'Trial signup flow (CREDIT_CARD_REQUIRED_FOR_TRIAL on App)',
		choices: [
			{
				name: 'Manual — free trial without credit card upfront',
				value: 'manual',
				description: 'Default; only applies when LAUNCH_STATUS=LAUNCHED',
			},
			{
				name: 'Stripe — require credit card via Stripe before trial starts',
				value: 'stripe',
			},
		],
		default: 'manual',
	})
}

async function promptDiscordConfig(appUrl) {
	log('\nDiscord integration (closed beta waitlist)', 'blue')
	log('See apps/app/docs/DISCORD_INTEGRATION.md', 'gray')

	const defaultRedirectUri = `${appUrl.replace(/\/$/, '')}/auth/discord/verify`

	const discordInviteUrl = await input({
		message: 'DISCORD_INVITE_URL (server invite link)',
		validate: (value) => {
			const trimmed = value.trim()
			if (!trimmed) return 'Required for closed beta'
			return isValidUrl(trimmed) ? true : 'Must be a valid URL'
		},
	})

	const discordClientId = await input({
		message: 'DISCORD_CLIENT_ID (OAuth app client ID)',
	})

	const discordClientSecret = await password({
		message: 'DISCORD_CLIENT_SECRET (OAuth app client secret)',
		mask: '*',
	})

	const discordRedirectUri = await input({
		message: 'DISCORD_REDIRECT_URI (must match Discord Developer Portal)',
		default: defaultRedirectUri,
		validate: (value) => {
			const trimmed = value.trim()
			if (!trimmed) return 'Redirect URI is required for OAuth verification'
			return isValidUrl(trimmed) ? true : 'Must be a valid URL'
		},
	})

	const discordGuildId = await input({
		message: 'DISCORD_GUILD_ID (Discord server ID)',
	})

	return {
		DISCORD_INVITE_URL: discordInviteUrl.trim(),
		DISCORD_CLIENT_ID: discordClientId.trim(),
		DISCORD_CLIENT_SECRET: discordClientSecret.trim(),
		DISCORD_REDIRECT_URI: discordRedirectUri.trim(),
		DISCORD_GUILD_ID: discordGuildId.trim(),
	}
}

function openUrl(url) {
	let result
	if (process.platform === 'darwin') {
		result = spawnSync('open', [url], { stdio: 'ignore' })
	} else if (process.platform === 'win32') {
		result = spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
	} else {
		result = spawnSync('xdg-open', [url], { stdio: 'ignore' })
	}
	if (result.status !== 0) {
		log(`Could not open browser. Visit: ${url}`, 'yellow')
	}
}

function setGhSecret(repo, name, value) {
	const result = spawnSync(
		'gh',
		['secret', 'set', name, '--repo', repo.nameWithOwner],
		{
			cwd: rootDir,
			input: `${value}\n`,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	)
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `Could not set ${name}`)
	}
}

async function applyTurboR2GhSecrets(repo, accountId) {
	const shouldApply = await confirm({
		message:
			'Create or reuse Cloudflare R2 credentials and save them for the Turbo cache?',
		default: true,
	})
	if (!shouldApply) return false

	const credentialsFromEnv = Boolean(
		process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
	)
	if (!credentialsFromEnv) {
		const tokenUrl = accountId
			? `https://dash.cloudflare.com/${accountId}/r2/api-tokens/create?type=account`
			: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens'

		log('\n⚡ Turborepo R2 credentials', 'bright')
		log(`Create an account token named ${CF_R2.turboCache}.`, 'gray')
		log('Permission: Object Read & Write.', 'gray')
		log(`Bucket scope: ${CF_R2.turboCache} only.`, 'gray')
		log(
			'Copy both values from the confirmation page before leaving it.',
			'gray',
		)

		const openTokenPage = await confirm({
			message: 'Open the Cloudflare R2 account-token creation page now?',
			default: true,
		})
		if (openTokenPage) openUrl(tokenUrl)

		const tokenReady = await confirm({
			message:
				'Continue after creating the token and copying its Access Key ID and Secret Access Key?',
			default: true,
		})
		if (!tokenReady) {
			log(`Create the token later at: ${tokenUrl}`, 'yellow')
			return false
		}
	}

	const accessKeyId =
		process.env.AWS_ACCESS_KEY_ID ||
		(
			await input({
				message: 'Cloudflare R2 Access Key ID',
				validate: (value) =>
					value.trim() ? true : 'Access Key ID is required',
			})
		).trim()
	const secretAccessKey =
		process.env.AWS_SECRET_ACCESS_KEY ||
		(
			await password({
				message: 'Cloudflare R2 Secret Access Key (input is hidden)',
				mask: '*',
				validate: (value) =>
					value.trim() ? true : 'Secret Access Key is required',
			})
		).trim()

	setGhSecret(repo, 'AWS_ACCESS_KEY_ID', accessKeyId)
	setGhSecret(repo, 'AWS_SECRET_ACCESS_KEY', secretAccessKey)
	log('✓ AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY', 'green')
	return true
}

async function setupWorkersBuildsAfterDeploy(config, inferred, deployedEnvs) {
	const shouldConfigure = await confirm({
		message:
			'Set up Cloudflare Workers Builds for future main/dev deployments now?',
		default: true,
	})
	if (!shouldConfigure) return false
	if (!inferred.githubRepo?.nameWithOwner) {
		log(
			'Could not detect a GitHub repository from git origin; skipping Workers Builds setup.',
			'yellow',
		)
		log('Retry later with: npm run launch:workers-builds', 'gray')
		return false
	}

	const accountId =
		process.env.CLOUDFLARE_ACCOUNT_ID ||
		inferred.accountId ||
		(
			await input({
				message: 'Cloudflare account ID',
				validate: (value) => (value.trim() ? true : 'Account ID is required'),
			})
		).trim()
	const setupWorker =
		config.bindings.production.jobs_cron.worker_name ||
		config.bindings.production.app.worker_name
	const buildsSettingsUrl = workersBuildsSettingsUrl(accountId, setupWorker)

	log('\n☁️  Cloudflare Workers Builds (one-time setup)', 'bright')
	log(
		'Cloudflare requires one browser step to authorize its GitHub App and create/select a build token.',
		'gray',
	)
	const openBuildSettings = await confirm({
		message: `Open ${setupWorker} → Settings → Builds now?`,
		default: true,
	})
	if (openBuildSettings) openUrl(buildsSettingsUrl)

	const githubConnected = await confirm({
		message:
			'Continue after you connected GitHub and selected/created the Worker build API token?',
		default: true,
	})
	if (!githubConnected) {
		log(
			`Finish at ${buildsSettingsUrl}, then run: npm run launch:workers-builds`,
			'yellow',
		)
		return false
	}

	let apiToken = process.env.CLOUDFLARE_BUILDS_API_TOKEN
	if (!apiToken) {
		log(
			'Create a user API token with Workers Builds Configuration: Edit and Workers Scripts: Read.',
			'gray',
		)
		const openTokenPage = await confirm({
			message: 'Open the Cloudflare API Tokens page now?',
			default: true,
		})
		if (openTokenPage) openUrl('https://dash.cloudflare.com/profile/api-tokens')
		apiToken = await password({
			message: 'Paste the Cloudflare API token (input is hidden)',
			mask: '*',
			validate: (value) => (value.trim() ? true : 'API token is required'),
		})
		apiToken = apiToken.trim()
	}

	const canApplyGh = ghAvailable() && inferred.githubRepo?.nameWithOwner
	const applyBuildsGh = canApplyGh
		? await confirm({
				message:
					'Save Workers Builds trigger IDs and Cloudflare credentials to GitHub Actions now?',
				default: true,
			})
		: false
	if (!deployedEnvs.includes('staging')) {
		log(
			'Staging was not deployed in this run. Existing staging Workers will be configured; missing ones will be reported.',
			'gray',
		)
	}

	try {
		const result = await configureWorkersBuilds({
			config,
			accountId,
			token: apiToken,
			githubRepo: inferred.githubRepo,
			tiers: ['production', 'staging'],
			applyGh: applyBuildsGh,
		})

		if (applyBuildsGh) {
			setGhSecret(inferred.githubRepo, 'CLOUDFLARE_BUILDS_API_TOKEN', apiToken)
			setGhSecret(inferred.githubRepo, 'CLOUDFLARE_ACCOUNT_ID', accountId)
			log(
				'Saved the Builds API token + account ID as GitHub Actions secrets.',
				'green',
			)
		}

		if (result.failures.length > 0) {
			log('\nWorkers Builds was only partially configured:', 'yellow')
			for (const failure of result.failures) {
				log(`  ${failure.app}/${failure.tier}: ${failure.message}`, 'yellow')
			}
			log('Retry later with: npm run launch:workers-builds', 'gray')
			return false
		}

		log('\n✅ Cloudflare Workers Builds configured.', 'green')
		log(
			'Build commands, watch paths, caching, and launch.config.json values were applied automatically.',
			'gray',
		)

		const openConfiguredSettings = await confirm({
			message: 'Open the configured Worker Builds settings page for review?',
			default: false,
		})
		if (openConfiguredSettings) openUrl(buildsSettingsUrl)
		return true
	} catch (error) {
		log(
			`\nWorkers Builds setup could not finish: ${redactSecrets(error.message)}`,
			'yellow',
		)
		log(`Settings: ${buildsSettingsUrl}`, 'gray')
		log('Retry with: npm run launch:workers-builds', 'gray')
		return false
	}
}

function generateSharedSecrets() {
	const sessionSecret = randomHex(16)
	const internalCommandToken = randomHex(16)
	const tenantOperatorToken = randomHex(16)
	const customerJwtSecret = randomHex(16)

	return {
		generatedAt: new Date().toISOString(),
		shared: {
			SESSION_SECRET: sessionSecret,
			HONEYPOT_SECRET: randomHex(16),
			INTERNAL_COMMAND_TOKEN: internalCommandToken,
			TENANT_OPERATOR_TOKEN: tenantOperatorToken,
			SSO_ENCRYPTION_KEY: randomHex(32),
			AUDIT_LOG_SECRET_KEY: randomHex(32),
		},
		app: {
			JWT_SECRET: randomHex(16),
			TENANT_CUSTOMER_JWT_SECRET: customerJwtSecret,
		},
		tenant_api: {
			JWT_SECRET: customerJwtSecret,
			AUTH_HMAC_SECRET: randomHex(16),
		},
		notes: [
			'SESSION_SECRET, HONEYPOT_SECRET, INTERNAL_COMMAND_TOKEN, TENANT_OPERATOR_TOKEN, SSO_ENCRYPTION_KEY, and AUDIT_LOG_SECRET_KEY must match on App and Admin.',
			'INTERNAL_COMMAND_TOKEN must also match jobs-cron and tenant-api.',
			'TENANT_CUSTOMER_JWT_SECRET (App) must equal JWT_SECRET on US tenant-api.',
			'launch:setup can apply these via wrangler secret put after deploy — never commit values to git.',
		],
	}
}

function patchEnvFile(envPath, replacements) {
	if (!existsSync(envPath)) return false
	let content = readFileSync(envPath, 'utf8')
	let changed = false
	for (const [key, value] of Object.entries(replacements)) {
		const pattern = new RegExp(`^${key}=.*$`, 'm')
		if (pattern.test(content)) {
			content = content.replace(pattern, `${key}="${value}"`)
			changed = true
		}
	}
	if (changed) writeFileSync(envPath, content)
	return changed
}

function runWrangler(args, cwd, { env, input } = {}) {
	const result = spawnSync('npx', ['wrangler', ...args], {
		cwd,
		encoding: 'utf8',
		input,
		env: env ? { ...process.env, ...env } : process.env,
		stdio:
			input !== undefined
				? ['pipe', 'pipe', 'pipe']
				: ['inherit', 'pipe', 'pipe'],
	})
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `wrangler ${args.join(' ')} failed`,
		)
	}
	return result.stdout
}

function ensureR2Bucket(name) {
	try {
		runWrangler(['r2', 'bucket', 'info', name], rootDir)
		log(`  ✓ R2 bucket already exists: ${name}`, 'gray')
	} catch {
		runWrangler(['r2', 'bucket', 'create', name], rootDir)
		log(`  ✓ Created R2 bucket: ${name}`, 'gray')
	}
}

function wranglerEnvArgs(deployEnv, { useEmptyEnv = false } = {}) {
	if (useEmptyEnv) return ['--env', '']
	if (deployEnv === 'staging') return ['--env', 'staging']
	return []
}

function putWranglerSecret(
	cwd,
	configFile,
	deployEnv,
	name,
	value,
	{ useEmptyEnv = false } = {},
) {
	const args = [
		'wrangler',
		'secret',
		'put',
		name,
		'--config',
		configFile,
		...wranglerEnvArgs(deployEnv, { useEmptyEnv }),
	]
	const result = spawnSync('npx', args, {
		cwd,
		input: value,
		encoding: 'utf8',
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `wrangler secret put ${name} failed`,
		)
	}
}

function reactRouterWranglerConfig(appKey) {
	const appDir = join(rootDir, 'apps', appKey)
	const deployConfig = join(appDir, 'build/server/wrangler.deploy.json')
	if (existsSync(deployConfig)) {
		return { cwd: appDir, config: 'build/server/wrangler.deploy.json' }
	}
	return { cwd: appDir, config: 'wrangler.jsonc' }
}

function applyGeneratedWranglerSecrets(
	secrets,
	urls,
	deployEnv,
	launchStatus,
	trialCreditCardMode,
) {
	const label = deployEnv === 'staging' ? 'staging' : 'production'

	log(`\n🔑 Applying generated Wrangler secrets (${label})…`, 'yellow')

	const appWrangler = reactRouterWranglerConfig('app')
	const adminWrangler = reactRouterWranglerConfig('admin')
	const jobsCronDir = join(rootDir, 'apps/jobs-cron')
	const tenantApiDir = join(rootDir, 'apps/tenant-api')

	const workerBlocks = [
		{
			name: 'App',
			patchApp: 'app',
			cwd: appWrangler.cwd,
			config: appWrangler.config,
			secrets: [
				['SESSION_SECRET', secrets.shared.SESSION_SECRET],
				['HONEYPOT_SECRET', secrets.shared.HONEYPOT_SECRET],
				['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
				['TENANT_OPERATOR_TOKEN', secrets.shared.TENANT_OPERATOR_TOKEN],
				['JWT_SECRET', secrets.app.JWT_SECRET],
				['TENANT_CUSTOMER_JWT_SECRET', secrets.app.TENANT_CUSTOMER_JWT_SECRET],
				['SSO_ENCRYPTION_KEY', secrets.shared.SSO_ENCRYPTION_KEY],
				['AUDIT_LOG_SECRET_KEY', secrets.shared.AUDIT_LOG_SECRET_KEY],
				['LAUNCH_STATUS', launchStatus],
				['CREDIT_CARD_REQUIRED_FOR_TRIAL', trialCreditCardMode],
				...(secrets.discord
					? Object.entries(secrets.discord).filter(([, value]) => value)
					: []),
			],
		},
		{
			name: 'Admin',
			patchApp: 'admin',
			cwd: adminWrangler.cwd,
			config: adminWrangler.config,
			secrets: [
				['SESSION_SECRET', secrets.shared.SESSION_SECRET],
				['HONEYPOT_SECRET', secrets.shared.HONEYPOT_SECRET],
				['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
				['SSO_ENCRYPTION_KEY', secrets.shared.SSO_ENCRYPTION_KEY],
				['AUDIT_LOG_SECRET_KEY', secrets.shared.AUDIT_LOG_SECRET_KEY],
				['LAUNCH_STATUS', launchStatus],
			],
		},
		{
			name: 'Jobs Cron',
			patchApp: 'jobs-cron',
			cwd: jobsCronDir,
			config: 'wrangler.deploy.jsonc',
			secrets: [
				['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
			],
		},
		{
			name: 'Tenant API US',
			patchApp: 'tenant-api',
			cwd: tenantApiDir,
			config: 'wrangler.deploy.jsonc',
			optional: true,
			secrets: [
				['JWT_SECRET', secrets.tenant_api.JWT_SECRET],
				['AUTH_HMAC_SECRET', secrets.tenant_api.AUTH_HMAC_SECRET],
				['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
				['TENANT_OPERATOR_TOKEN', secrets.shared.TENANT_OPERATOR_TOKEN],
			],
		},
	]

	const failures = []
	for (const block of workerBlocks) {
		patchWranglerApp(block.patchApp, deployEnv)
		for (const [secretName, value] of block.secrets) {
			try {
				putWranglerSecret(block.cwd, block.config, deployEnv, secretName, value)
				log(`  ✓ ${block.name}: ${secretName}`, 'gray')
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (block.optional) {
					log(`  ⚠ ${block.name}: ${secretName} skipped (${message})`, 'yellow')
				} else {
					failures.push(`${block.name} ${secretName}: ${message}`)
					log(`  ✗ ${block.name}: ${secretName} failed`, 'yellow')
				}
			}
		}
	}

	if (failures.length > 0) {
		throw new Error(failures.join('; '))
	}

	log(`✅ Wrangler secrets applied (${label})`, 'green')
}

function parseD1CreateOutput(output) {
	const idMatch = output.match(/database_id\s*=\s*"([^"]+)"/i)
	return idMatch?.[1]
}

function parseKvCreateOutput(output) {
	const idMatch = output.match(/id\s*=\s*"([^"]+)"/i)
	return idMatch?.[1]
}

function ghAvailable() {
	try {
		execSync('gh auth status', { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

function applyRemoteD1Migrations(config) {
	const prodId = config.bindings.production.app.d1_database_id
	const stagingId = config.bindings.staging.app.d1_database_id
	if (!prodId && !stagingId) {
		log(
			'\nSkipping remote D1 migrations (no App/Admin database IDs in config).',
			'gray',
		)
		return
	}

	log('\nApplying control-plane D1 migrations to Cloudflare…', 'yellow')
	const appDir = join(rootDir, 'apps/app')
	const patchScript = join(rootDir, 'scripts/patch-wrangler.mjs')
	// Always migrate via wrangler.deploy.jsonc — the Vite-built deploy config omits migrations_dir.
	const wranglerConfig = 'wrangler.deploy.jsonc'

	try {
		if (prodId) {
			execSync(`node "${patchScript}" --app app --env production`, {
				cwd: rootDir,
				stdio: 'inherit',
			})
			runWrangler(
				[
					'd1',
					'migrations',
					'apply',
					CF_D1.app,
					'--remote',
					'--config',
					wranglerConfig,
				],
				appDir,
				{ env: { CI: 'true' }, input: 'y\n' },
			)
			log(`✅ Migrations applied to ${CF_D1.app} (production)`, 'green')
		}

		if (stagingId) {
			execSync(`node "${patchScript}" --app app --env staging`, {
				cwd: rootDir,
				stdio: 'inherit',
			})
			runWrangler(
				[
					'd1',
					'migrations',
					'apply',
					CF_D1.appStaging,
					'--remote',
					'--config',
					wranglerConfig,
					'--env',
					'staging',
				],
				appDir,
				{ env: { CI: 'true' }, input: 'y\n' },
			)
			log(`✅ Migrations applied to ${CF_D1.appStaging} (staging)`, 'green')
		}
	} catch (error) {
		log(`\n❌ Remote D1 migration failed: ${error.message}`, 'red')
		log(
			'Apply manually after patching: node scripts/patch-wrangler.mjs --app app --env production',
			'gray',
		)
		log(
			`  cd apps/app && npx wrangler d1 migrations apply ${CF_D1.app} --remote --config ${wranglerConfig}`,
			'gray',
		)
		throw error
	}
}

const CF_BUILD_ENV = {
	NODE_OPTIONS: '--max-old-space-size=6144',
}

function runLaunchCommand(command, cwd, extraEnv = {}) {
	execSync(command, {
		cwd,
		stdio: 'inherit',
		env: { ...process.env, ...extraEnv },
	})
}

function patchWranglerApp(app, deployEnv) {
	const patchScript = join(rootDir, 'scripts/patch-wrangler.mjs')
	runLaunchCommand(
		`node "${patchScript}" --app ${app} --env ${deployEnv}`,
		rootDir,
	)
}

function wranglerDeploy(
	cwd,
	configFile,
	deployEnv,
	{ useEmptyEnv = false } = {},
) {
	const envFlag = useEmptyEnv
		? ' --env=""'
		: deployEnv === 'staging'
			? ' --env staging'
			: ''
	runLaunchCommand(`npx wrangler deploy --config ${configFile}${envFlag}`, cwd)
}

function astroWranglerDeploy(appKey, deployEnv) {
	const appDir = join(rootDir, 'apps', appKey)
	const builtConfig = join(appDir, 'dist/server/wrangler.deploy.json')
	if (existsSync(builtConfig)) {
		wranglerDeploy(appDir, 'dist/server/wrangler.deploy.json', deployEnv, {
			useEmptyEnv: true,
		})
		return
	}
	wranglerDeploy(appDir, 'wrangler.deploy.toml', deployEnv, {
		useEmptyEnv: true,
	})
}

function deployReactRouterApp(appKey, deployEnv, { build = true } = {}) {
	const appDir = join(rootDir, 'apps', appKey)
	if (build) {
		runLaunchCommand('npm run build:cf', appDir, CF_BUILD_ENV)
	}
	patchWranglerApp(appKey, deployEnv)
	wranglerDeploy(appDir, 'build/server/wrangler.deploy.json', deployEnv)
}

function deployJobsCron(deployEnv) {
	const appDir = join(rootDir, 'apps/jobs-cron')
	patchWranglerApp('jobs-cron', deployEnv)
	wranglerDeploy(appDir, 'wrangler.deploy.jsonc', deployEnv)
}

function deployTenantApi(deployEnv) {
	const appDir = join(rootDir, 'apps/tenant-api')
	patchWranglerApp('tenant-api', deployEnv)
	runLaunchCommand('npm run generate:do-migrations', appDir)
	wranglerDeploy(appDir, 'wrangler.deploy.jsonc', deployEnv)
}

function deployWeb(deployEnv, { build = true } = {}) {
	if (build) {
		try {
			runLaunchCommand(
				'npm rebuild sharp libsql rolldown @astrojs/compiler-binding',
				rootDir,
			)
		} catch {
			log('  (skipped optional native rebuild for web)', 'gray')
		}
		runLaunchCommand('npx turbo run build --filter=web', rootDir, {
			CLOUDFLARE_BUILD: 'true',
		})
	}
	patchWranglerApp('web', deployEnv)
	astroWranglerDeploy('web', deployEnv)
}

function deploySites(urls, deployEnv, { build = true } = {}) {
	if (build) {
		runLaunchCommand('npx turbo run build --filter=sites', rootDir, {
			PUBLIC_APP_URL: urls.public_app_url,
			TENANT_API_URL: urls.tenant_api_url,
			TENANT_API_URL_KSA: urls.tenant_api_url_ksa,
		})
	}
	patchWranglerApp('sites', deployEnv)
	astroWranglerDeploy('sites', deployEnv)
}

async function deployCloudflareWorkers(
	urls,
	deployEnv,
	{ skipBuilds = false } = {},
) {
	const label = deployEnv === 'staging' ? 'staging' : 'production'
	log(`\n🚀 Building and deploying Cloudflare Workers (${label})…`, 'yellow')

	const steps = [
		{
			name: 'App',
			run: () => deployReactRouterApp('app', deployEnv, { build: !skipBuilds }),
		},
		{
			name: 'Admin',
			run: () =>
				deployReactRouterApp('admin', deployEnv, { build: !skipBuilds }),
		},
		{
			name: 'Jobs Cron',
			run: () => deployJobsCron(deployEnv),
		},
		{
			name: 'Tenant API US',
			optional: true,
			run: () => deployTenantApi(deployEnv),
		},
		{
			name: 'Web',
			run: () => deployWeb(deployEnv, { build: !skipBuilds }),
		},
		{
			name: 'Sites',
			run: () => deploySites(urls, deployEnv, { build: !skipBuilds }),
		},
	]

	const failures = []
	for (const step of steps) {
		log(`\n▶ ${step.name}`, 'blue')
		try {
			step.run()
			log(`✅ ${step.name} deployed`, 'green')
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (step.optional) {
				log(`⚠️  ${step.name} skipped: ${message}`, 'yellow')
			} else {
				failures.push(`${step.name}: ${message}`)
				log(`❌ ${step.name} failed: ${message}`, 'yellow')
			}
		}
	}

	if (failures.length > 0) {
		throw new Error(failures.join('; '))
	}

	log(`\n✅ ${label} deploy complete`, 'green')
}

function ghRepoFlag(repo) {
	return repo?.nameWithOwner ? ` --repo ${repo.nameWithOwner}` : ''
}

const GH_VARIABLE_MAX_ATTEMPTS = 4
const GH_VARIABLE_BASE_DELAY_MS = 400
const GH_VARIABLE_INTER_REQUEST_DELAY_MS = 150

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitteredDelay(attempt, baseMs) {
	const exponential = baseMs * 2 ** (attempt - 1)
	const jitter = Math.floor(Math.random() * (baseMs / 2))
	return exponential + jitter
}

function runGh(args) {
	return spawnSync('gh', args, {
		cwd: rootDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
}

function parseGhHttpStatus(text) {
	const combined = String(text)
	const match =
		combined.match(/\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/i) ??
		combined.match(/\bHTTP (\d{3})\b/)
	return match ? Number(match[1]) : undefined
}

function ghApiHttpStatus(result) {
	return parseGhHttpStatus(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function isRetriableGhStatus(status) {
	return status === undefined || [429, 500, 502, 503, 504].includes(status)
}

/** @returns {boolean | null} true = exists, false = not found, null = transient lookup error */
function checkGhRepoVariableExists(nameWithOwner, name) {
	const result = runGh([
		'api',
		`repos/${nameWithOwner}/actions/variables/${encodeURIComponent(name)}`,
	])
	if (result.status === 0) return true

	const status = ghApiHttpStatus(result)
	if (status === 404) return false
	return null
}

function createGhRepoVariable(nameWithOwner, name, value) {
	return runGh([
		'api',
		'--method',
		'POST',
		`repos/${nameWithOwner}/actions/variables`,
		'-f',
		`name=${name}`,
		'-f',
		`value=${value}`,
	])
}

function patchGhRepoVariable(nameWithOwner, name, value) {
	return runGh([
		'api',
		'--method',
		'PATCH',
		`repos/${nameWithOwner}/actions/variables/${encodeURIComponent(name)}`,
		'-f',
		`value=${value}`,
	])
}

async function setGhRepoVariable(nameWithOwner, name, value) {
	for (let attempt = 1; attempt <= GH_VARIABLE_MAX_ATTEMPTS; attempt++) {
		const exists = checkGhRepoVariableExists(nameWithOwner, name)
		if (exists === null) {
			if (attempt === GH_VARIABLE_MAX_ATTEMPTS) return false
			await sleep(jitteredDelay(attempt, GH_VARIABLE_BASE_DELAY_MS))
			continue
		}

		let result

		if (exists) {
			result = patchGhRepoVariable(nameWithOwner, name, value)
		} else {
			result = createGhRepoVariable(nameWithOwner, name, value)
			if (result.status !== 0) {
				const createStatus = ghApiHttpStatus(result)
				// GitHub sometimes returns 500 instead of 409 when the variable already exists.
				if (createStatus === 409 || createStatus === 500) {
					result = patchGhRepoVariable(nameWithOwner, name, value)
				}
			}
		}

		if (result.status === 0) return true

		const status = ghApiHttpStatus(result)
		if (!isRetriableGhStatus(status) || attempt === GH_VARIABLE_MAX_ATTEMPTS) {
			return false
		}

		await sleep(jitteredDelay(attempt, GH_VARIABLE_BASE_DELAY_MS))
	}

	return false
}

async function applyGhVariables(config, repo) {
	const nameWithOwner = repo.nameWithOwner
	const variables = getGhVariables(config).filter(([, value]) => value)
	const failed = []

	for (const [name, value] of variables) {
		const ok = await setGhRepoVariable(nameWithOwner, name, value)
		if (ok) {
			log(`✓ ${name}`, 'green')
		} else {
			log(
				`✗ Failed to set ${name} after ${GH_VARIABLE_MAX_ATTEMPTS} attempts`,
				'yellow',
			)
			failed.push(name)
		}
		await sleep(GH_VARIABLE_INTER_REQUEST_DELAY_MS)
	}

	if (failed.length > 0) {
		log(`\n${failed.length} variable(s) failed: ${failed.join(', ')}`, 'yellow')
		log(
			'Re-run launch:setup or set them manually — see gh commands above.',
			'gray',
		)
	} else {
		log(`\n✅ All ${variables.length} GitHub Variables applied`, 'green')
	}

	return failed
}

function printGhCommands(config, repo) {
	const variables = getGhVariables(config)
	const repoFlag = ghRepoFlag(repo)

	if (repo?.nameWithOwner) {
		log(`\nTarget GitHub repository: ${repo.nameWithOwner}`, 'gray')
	}

	log(
		'\n📦 GitHub repository Variables (Settings → Secrets and variables → Actions → Variables)',
		'bright',
	)
	for (const [name, value] of variables) {
		if (!value) continue
		console.log(`gh variable set ${name} --body "${value}"${repoFlag}`)
	}

	log(
		'\n🔐 GitHub repository Secrets (set manually — do not commit values)',
		'bright',
	)
	console.log(`gh secret set CLOUDFLARE_API_TOKEN${repoFlag}`)
	console.log(`gh secret set CLOUDFLARE_BUILDS_API_TOKEN${repoFlag}`)
	console.log(`gh secret set CLOUDFLARE_ACCOUNT_ID${repoFlag}`)
	console.log(`gh secret set AWS_ACCESS_KEY_ID${repoFlag}`)
	console.log(`gh secret set AWS_SECRET_ACCESS_KEY${repoFlag}`)
	console.log(
		`# Optional OCI deploy: gh secret set OCI_TENANT_SSH_KEY${repoFlag}`,
	)
	console.log(
		`# Optional private GHCR pulls: gh secret set GHCR_PULL_TOKEN${repoFlag}`,
	)
}

function printWranglerSecrets(secrets, { autoApplied = false } = {}) {
	if (autoApplied) {
		log(
			'\n🔑 Generated Wrangler secrets were applied via wrangler secret put.',
			'green',
		)
		log(
			'Set third-party credentials manually (values never go in git):\n',
			'bright',
		)
	} else {
		log(
			'\n🔑 Wrangler secrets (run once per Worker; values never go in git)',
			'bright',
		)
		log(
			'Generated values are in launch.secrets.json — paste when wrangler prompts.\n',
			'gray',
		)
	}

	const generatedBlocks = autoApplied
		? []
		: [
				{
					title: 'App (apps/app)',
					keys: [
						['SESSION_SECRET', secrets.shared.SESSION_SECRET],
						['HONEYPOT_SECRET', secrets.shared.HONEYPOT_SECRET],
						['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
						['TENANT_OPERATOR_TOKEN', secrets.shared.TENANT_OPERATOR_TOKEN],
						['JWT_SECRET', secrets.app.JWT_SECRET],
						[
							'TENANT_CUSTOMER_JWT_SECRET',
							secrets.app.TENANT_CUSTOMER_JWT_SECRET,
						],
						['SSO_ENCRYPTION_KEY', secrets.shared.SSO_ENCRYPTION_KEY],
						['AUDIT_LOG_SECRET_KEY', secrets.shared.AUDIT_LOG_SECRET_KEY],
						['LAUNCH_STATUS', 'CLOSED_BETA | PUBLIC_BETA | LAUNCHED'],
						...(secrets.discord
							? Object.entries(secrets.discord).map(([name, value]) => [
									name,
									value,
								])
							: []),
					],
				},
				{
					title: 'Admin (apps/admin)',
					keys: [
						['SESSION_SECRET', secrets.shared.SESSION_SECRET],
						['HONEYPOT_SECRET', secrets.shared.HONEYPOT_SECRET],
						['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
						['SSO_ENCRYPTION_KEY', secrets.shared.SSO_ENCRYPTION_KEY],
						['AUDIT_LOG_SECRET_KEY', secrets.shared.AUDIT_LOG_SECRET_KEY],
						['LAUNCH_STATUS', '(same as App)'],
					],
				},
				{
					title: 'Tenant API US (apps/tenant-api)',
					keys: [
						['JWT_SECRET', secrets.tenant_api.JWT_SECRET],
						['AUTH_HMAC_SECRET', secrets.tenant_api.AUTH_HMAC_SECRET],
						['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
						['TENANT_OPERATOR_TOKEN', secrets.shared.TENANT_OPERATOR_TOKEN],
					],
				},
				{
					title: 'Jobs Cron (apps/jobs-cron)',
					keys: [
						['INTERNAL_COMMAND_TOKEN', secrets.shared.INTERNAL_COMMAND_TOKEN],
					],
				},
			]

	const manualBlocks = [
		{
			title: 'App (apps/app)',
			keys: [
				['RESEND_API_KEY', '(from Resend dashboard)'],
				['AWS_SECRET_ACCESS_KEY', '(R2 API token)'],
			],
		},
	]

	if (secrets.launch_status === 'CLOSED_BETA' && !secrets.discord) {
		manualBlocks.unshift({
			title: 'App (apps/app) — Discord (closed beta)',
			keys: [
				['DISCORD_INVITE_URL', '(required)'],
				['DISCORD_CLIENT_ID', '(OAuth app)'],
				['DISCORD_CLIENT_SECRET', '(OAuth app)'],
				['DISCORD_REDIRECT_URI', '(must match Discord Developer Portal)'],
				['DISCORD_GUILD_ID', '(Discord server ID)'],
			],
		})
	}

	const blocks = [...generatedBlocks, ...manualBlocks]

	for (const block of blocks) {
		log(`\n${block.title}`, 'blue')
		for (const [name, hint] of block.keys) {
			console.log(`  npx wrangler secret put ${name}`)
			if (hint && !hint.startsWith('(')) {
				log(`    → ${hint}`, 'gray')
			}
		}
		if (!autoApplied) {
			log('  # Repeat with --env staging for the dev branch Worker', 'gray')
		}
	}
}

async function setupDeploymentPages(
	defaultRepoUrl = '',
	{ includeCloudflareTokenPage = true } = {},
) {
	const openPages = await confirm({
		message: includeCloudflareTokenPage
			? 'Open Cloudflare API tokens + GitHub Actions secrets pages in your browser?'
			: 'Open GitHub Actions secrets and variables pages in your browser?',
		default: true,
	})
	if (!openPages) return

	if (includeCloudflareTokenPage) {
		openUrl('https://dash.cloudflare.com/profile/api-tokens')
	}

	const repoUrl = await input({
		message: 'GitHub repo URL (for secrets page; leave blank to skip)',
		default: defaultRepoUrl,
	})
	if (repoUrl) {
		const normalized = repoUrl.replace(/\/$/, '')
		openUrl(`${normalized}/settings/secrets/actions`)
		openUrl(`${normalized}/settings/variables/actions`)
	} else {
		log(
			'Set secrets at: GitHub repo → Settings → Secrets and variables → Actions',
			'gray',
		)
	}
}

async function main() {
	log('\n🚀 Epic Startup — Launch Setup', 'bright')
	log(
		'Creates launch.config.json + launch.secrets.json and prints CI/CD steps.\n',
		'gray',
	)

	const runMonorepoSetup = await confirm({
		message: 'Run monorepo setup first (db, brand, SSL, hosts)?',
		default: !existsSync(join(rootDir, 'packages/database/data.db')),
	})
	if (runMonorepoSetup) {
		log('\nRunning npm run setup…', 'yellow')
		execSync('npm run setup', { cwd: rootDir, stdio: 'inherit' })
	}

	log('\nDetecting Cloudflare account + existing resources…', 'gray')
	const inferred = await inferLaunchConfig(rootDir)
	printInferredSummary(inferred, log)

	const apex = await input({
		message: 'Platform apex domain (e.g. epic-startup.com)',
		default:
			inferred.urls.apex && !inferred.urls.apex.endsWith('.test')
				? inferred.urls.apex
				: readConfiguredBrandDomain(),
		validate: (value) => (value.trim() ? true : 'Domain is required'),
	})

	const hasExistingD1 = Boolean(inferred.bindings.production.app.d1_database_id)
	const uniqueSuffix = await confirm({
		message:
			'Append a random suffix to Worker names? (useful when multiple installs share one Cloudflare account)',
		default: false,
	})
	const suffix = uniqueSuffix ? `-${randomHex(2)}` : ''
	const createResources = await confirm({
		message: hasExistingD1
			? 'Create missing Cloudflare D1/KV/R2 resources? (existing resources were detected)'
			: 'Create Cloudflare D1/KV/R2 resources now? (requires wrangler login)',
		default: !hasExistingD1 && inferred.wranglerLoggedIn,
	})
	const applyGh = ghAvailable()
		? await confirm({
				message:
					'Apply GitHub Variables and the detected Cloudflare account ID secret with gh CLI now?',
				default: false,
			})
		: false

	const appUrl = `https://app.${apex}`
	const adminUrl = `https://admin.${apex}`
	const webUrl = `https://${apex}`
	const tenantUs = `https://tenant-us.${apex}`
	const tenantKsa = `https://tenant-ksa.${apex}`
	const publicAppUrl = appUrl
	const jobsCronUrl = `https://jobs.${apex}`
	const localDomain = readConfiguredLocalDomain()
	const localAppUrl = `https://app.${localDomain}:2999`
	const localAdminUrl = `https://admin.${localDomain}:2999`
	const localTenantUs = `https://api.${localDomain}:2999`
	const localTenantKsa = `https://api-ksa.${localDomain}:2999`

	const secrets = generateSharedSecrets()
	secrets.launch_status = await promptLaunchStatus()
	if (secrets.launch_status === 'CLOSED_BETA') {
		secrets.discord = await promptDiscordConfig(appUrl)
	}
	secrets.credit_card_required_for_trial =
		await promptCreditCardRequiredForTrial()
	const secretsPath = join(rootDir, 'launch.secrets.json')
	writeFileSync(secretsPath, `${JSON.stringify(secrets, null, '\t')}\n`)
	log(`\n✅ Wrote ${secretsPath} (gitignored)`, 'green')
	log(`   LAUNCH_STATUS: ${secrets.launch_status}`, 'gray')
	if (secrets.discord) {
		log(`   DISCORD_INVITE_URL: ${secrets.discord.DISCORD_INVITE_URL}`, 'gray')
	}
	log(
		`   CREDIT_CARD_REQUIRED_FOR_TRIAL: ${secrets.credit_card_required_for_trial}`,
		'gray',
	)
	if (secrets.launch_status !== 'LAUNCHED') {
		log(
			'   (CREDIT_CARD_REQUIRED_FOR_TRIAL is ignored until LAUNCH_STATUS=LAUNCHED)',
			'gray',
		)
	}

	const envPatches = {
		SESSION_SECRET: secrets.shared.SESSION_SECRET,
		HONEYPOT_SECRET: secrets.shared.HONEYPOT_SECRET,
		INTERNAL_COMMAND_TOKEN: secrets.shared.INTERNAL_COMMAND_TOKEN,
		TENANT_OPERATOR_TOKEN: secrets.shared.TENANT_OPERATOR_TOKEN,
		JWT_SECRET: secrets.app.JWT_SECRET,
		TENANT_CUSTOMER_JWT_SECRET: secrets.app.TENANT_CUSTOMER_JWT_SECRET,
		LAUNCH_STATUS: secrets.launch_status,
		CREDIT_CARD_REQUIRED_FOR_TRIAL: secrets.credit_card_required_for_trial,
		JOBS_CRON_WORKER_URL: jobsCronUrl,
		ROOT_APP: localDomain,
		BASE_URL: localAppUrl,
		TENANT_API_URL: localTenantUs,
		TENANT_API_URL_KSA: localTenantKsa,
	}
	if (secrets.discord) {
		Object.assign(envPatches, secrets.discord)
	}
	const appEnvPatched = patchEnvFile(join(rootDir, 'apps/app/.env'), envPatches)
	const adminEnvPatched = patchEnvFile(join(rootDir, 'apps/admin/.env'), {
		SESSION_SECRET: secrets.shared.SESSION_SECRET,
		HONEYPOT_SECRET: secrets.shared.HONEYPOT_SECRET,
		INTERNAL_COMMAND_TOKEN: secrets.shared.INTERNAL_COMMAND_TOKEN,
		LAUNCH_STATUS: secrets.launch_status,
		ROOT_APP: localDomain,
		BASE_URL: localAdminUrl,
	})
	const sitesEnvPatched = patchEnvFile(join(rootDir, 'apps/sites/.env'), {
		ROOT_APP: localDomain,
		PUBLIC_APP_URL: localAppUrl,
		TENANT_API_URL: localTenantUs,
		TENANT_API_URL_KSA: localTenantKsa,
	})
	if (appEnvPatched || adminEnvPatched || sitesEnvPatched) {
		log(
			'Updated local .env files with generated secrets and derived .test URLs.',
			'green',
		)
	}

	/** @type {Record<string, unknown>} */
	const config = JSON.parse(
		readFileSync(join(rootDir, 'launch.config.example.json'), 'utf8'),
	)

	config.urls = {
		app_base_url: appUrl,
		admin_base_url: adminUrl,
		web_base_url: webUrl,
		public_app_url: publicAppUrl,
		root_app: apex,
		public_site_host_suffixes: `${apex},workers.dev`,
		tenant_api_url: tenantUs,
		tenant_api_url_ksa: tenantKsa,
		jobs_cron_worker_url: jobsCronUrl,
		docs_url: '',
		...stagingHostnames(apex),
		docs_url_staging: '',
	}
	log(`\nJobs cron URL: ${jobsCronUrl}`, 'gray')
	log(
		'  Attach jobs.<apex> as a custom domain on the jobs-cron Worker in Cloudflare.',
		'gray',
	)

	const defaultWorkerNames = {
		production: {
			app: `epic-startup-app${suffix}`,
			admin: `epic-startup-admin${suffix}`,
			web: `epic-startup${suffix}`,
			sites: `epic-startup-sites${suffix}`,
			jobs_cron: `epic-startup-jobs-cron${suffix}`,
			tenant_api: `epic-startup-tenant-api-us${suffix}`,
		},
		staging: {
			app: `epic-startup-app-staging${suffix}`,
			admin: `epic-startup-admin-staging${suffix}`,
			web: `epic-startup-staging${suffix}`,
			sites: `epic-startup-sites-staging${suffix}`,
			jobs_cron: `epic-startup-jobs-cron-staging${suffix}`,
			tenant_api: `epic-startup-tenant-api-us-staging${suffix}`,
		},
	}

	for (const env of ['production', 'staging']) {
		for (const [app, fallbackName] of Object.entries(defaultWorkerNames[env])) {
			config.bindings[env][app].worker_name =
				inferred.bindings[env]?.[app]?.worker_name ?? fallbackName
		}
	}

	mergeInferredBindings(config, inferred)

	if (createResources) {
		log('\nCreating Cloudflare resources…', 'yellow')
		try {
			ensureR2Bucket(CF_R2.turboCache)

			const appD1 = runWrangler(
				['d1', 'create', CF_D1.app],
				join(rootDir, 'apps/app'),
			)
			config.bindings.production.app.d1_database_id = parseD1CreateOutput(appD1)
			config.bindings.production.admin.d1_database_id =
				config.bindings.production.app.d1_database_id

			const appKv = runWrangler(
				['kv', 'namespace', 'create', CF_KV.app],
				join(rootDir, 'apps/app'),
			)
			config.bindings.production.app.kv_namespace_id =
				parseKvCreateOutput(appKv)
			config.bindings.production.admin.kv_namespace_id =
				config.bindings.production.app.kv_namespace_id

			const sitesDataKv = runWrangler(
				['kv', 'namespace', 'create', CF_KV.sitesData],
				join(rootDir, 'apps/app'),
			)
			config.bindings.production.app.sites_data_kv_id =
				parseKvCreateOutput(sitesDataKv)
			config.bindings.production.sites.sites_data_kv_id =
				config.bindings.production.app.sites_data_kv_id

			const stagingD1 = runWrangler(
				['d1', 'create', CF_D1.appStaging],
				join(rootDir, 'apps/app'),
			)
			config.bindings.staging.app.d1_database_id =
				parseD1CreateOutput(stagingD1)
			config.bindings.staging.admin.d1_database_id =
				config.bindings.staging.app.d1_database_id

			const stagingKv = runWrangler(
				['kv', 'namespace', 'create', CF_KV.appStaging],
				join(rootDir, 'apps/app'),
			)
			config.bindings.staging.app.kv_namespace_id =
				parseKvCreateOutput(stagingKv)
			config.bindings.staging.admin.kv_namespace_id =
				config.bindings.staging.app.kv_namespace_id

			const stagingSitesDataKv = runWrangler(
				['kv', 'namespace', 'create', CF_KV.sitesDataStaging],
				join(rootDir, 'apps/app'),
			)
			config.bindings.staging.app.sites_data_kv_id =
				parseKvCreateOutput(stagingSitesDataKv)
			config.bindings.staging.sites.sites_data_kv_id =
				config.bindings.staging.app.sites_data_kv_id

			const webD1 = runWrangler(
				['d1', 'create', CF_D1.web],
				join(rootDir, 'apps/web'),
			)
			config.bindings.production.web.d1_database_id = parseD1CreateOutput(webD1)

			runWrangler(
				[
					'r2',
					'bucket',
					'create',
					config.bindings.production.web.r2_bucket_name,
				],
				join(rootDir, 'apps/web'),
			)

			const webD1Staging = runWrangler(
				['d1', 'create', CF_D1.webStaging],
				join(rootDir, 'apps/web'),
			)
			config.bindings.staging.web.d1_database_id =
				parseD1CreateOutput(webD1Staging)
			runWrangler(
				['r2', 'bucket', 'create', config.bindings.staging.web.r2_bucket_name],
				join(rootDir, 'apps/web'),
			)

			log('Cloudflare resources created.', 'green')
		} catch (error) {
			log(`\nResource creation failed: ${error.message}`, 'yellow')
			log(
				'You can create resources manually and re-run, or edit launch.config.json.',
				'gray',
			)
		}
	} else {
		log(
			'\nSkipped resource creation. Edit launch.config.json with your D1/KV/R2 IDs.',
			'gray',
		)
	}

	// Re-infer after create (or skip) so D1/KV IDs land in launch.config even if
	// wrangler create output parsing failed or resources already existed.
	const refreshed = await inferLaunchConfig(rootDir)
	mergeInferredBindings(config, refreshed)

	const outputPath = join(rootDir, 'launch.config.json')
	writeFileSync(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	log(`\n✅ Wrote ${outputPath}`, 'green')

	const hasD1 = Boolean(
		config.bindings.production.app.d1_database_id ||
		config.bindings.staging.app.d1_database_id,
	)
	const applyMigrations =
		hasD1 && inferred.wranglerLoggedIn
			? await confirm({
					message:
						'Apply control-plane D1 migrations to Cloudflare (App + Admin; production + staging)?',
					default: true,
				})
			: false
	if (applyMigrations) {
		try {
			applyRemoteD1Migrations(config)
		} catch {
			const continueAnyway = await confirm({
				message:
					'D1 migrations failed. Continue with deployment anyway? (Workers may fail without database tables)',
				default: false,
			})
			if (!continueAnyway) {
				process.exit(1)
			}
		}
	}

	printGhCommands(config, inferred.githubRepo)

	if (applyGh) {
		if (!inferred.githubRepo?.nameWithOwner) {
			log(
				'\nSkipping GitHub Variables — could not detect repository from git origin.',
				'yellow',
			)
		} else {
			log(
				`\nApplying GitHub Variables to ${inferred.githubRepo.nameWithOwner}…`,
				'yellow',
			)
			await applyGhVariables(config, inferred.githubRepo)
			if (inferred.accountId) {
				try {
					setGhSecret(
						inferred.githubRepo,
						'CLOUDFLARE_ACCOUNT_ID',
						inferred.accountId,
					)
					log('✓ CLOUDFLARE_ACCOUNT_ID', 'green')
				} catch (error) {
					log(
						`✗ Failed to set CLOUDFLARE_ACCOUNT_ID: ${redactSecrets(error.message)}`,
						'yellow',
					)
				}
			}
			try {
				await applyTurboR2GhSecrets(inferred.githubRepo, inferred.accountId)
			} catch (error) {
				log(
					`✗ Failed to set Turbo R2 credentials: ${redactSecrets(error.message)}`,
					'yellow',
				)
			}
		}
	}

	const deployWorkers = inferred.wranglerLoggedIn
		? await confirm({
				message:
					'Build and deploy all Cloudflare Workers to production now? (app, admin, jobs-cron, tenant-api, web, sites)',
				default: true,
			})
		: false
	const deployedEnvs = []
	if (deployWorkers) {
		try {
			await deployCloudflareWorkers(config.urls, 'production')
			deployedEnvs.push('production')
		} catch (error) {
			log(`\nProduction deploy had errors: ${error.message}`, 'yellow')
			log(
				'You can retry individual apps — see docs/launch-checklist.md',
				'gray',
			)
		}
	}

	const deployStaging =
		inferred.wranglerLoggedIn && deployWorkers
			? await confirm({
					message:
						'Also deploy staging Workers? (reuses builds where possible)',
					default: true,
				})
			: false
	if (deployStaging) {
		try {
			await deployCloudflareWorkers(config.urls, 'staging', {
				skipBuilds: true,
			})
			deployedEnvs.push('staging')
		} catch (error) {
			log(`\nStaging deploy had errors: ${error.message}`, 'yellow')
		}
	}

	let secretsApplied = false
	if (inferred.wranglerLoggedIn) {
		const applySecrets =
			deployedEnvs.length > 0
				? await confirm({
						message:
							'Apply generated Wrangler secrets to deployed Workers now? (INTERNAL_COMMAND_TOKEN, SESSION_SECRET, etc.)',
						default: true,
					})
				: await confirm({
						message:
							'Workers were not deployed — still apply generated Wrangler secrets? (Workers must already exist)',
						default: false,
					})
		if (applySecrets) {
			const secretEnvs =
				deployedEnvs.length > 0
					? deployedEnvs
					: (
							await input({
								message:
									'Which Worker environment? (production, staging, or both comma-separated)',
								default: 'production',
							})
						)
							.split(',')
							.map((value) => value.trim().toLowerCase())
							.filter((value) => value === 'production' || value === 'staging')

			for (const deployEnv of secretEnvs) {
				try {
					applyGeneratedWranglerSecrets(
						secrets,
						config.urls,
						deployEnv,
						secrets.launch_status,
						secrets.credit_card_required_for_trial,
					)
					secretsApplied = true
				} catch (error) {
					log(
						`\nWrangler secret apply had errors (${deployEnv}): ${error.message}`,
						'yellow',
					)
					log('Retry manually — values are in launch.secrets.json', 'gray')
				}
			}
		}
	}

	printWranglerSecrets(secrets, { autoApplied: secretsApplied })
	const workersBuildsConfigured = await setupWorkersBuildsAfterDeploy(
		config,
		inferred,
		deployedEnvs,
	)
	await setupDeploymentPages(inferred.githubRepo?.url ?? '', {
		includeCloudflareTokenPage: !workersBuildsConfigured,
	})

	log('\nNext steps:', 'bright')
	if (inferred.accountId) {
		log(
			`• Cloudflare account ID (for GitHub secret): ${inferred.accountId}`,
			'gray',
		)
	}
	log(
		'1. Set GitHub Secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_BUILDS_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
		'gray',
	)
	if (!secretsApplied) {
		log(
			'2. Run wrangler secret put for each Worker (values in launch.secrets.json)',
			'gray',
		)
	} else {
		log(
			'2. Set third-party Wrangler secrets (RESEND_API_KEY, AWS_SECRET_ACCESS_KEY, etc.)',
			'gray',
		)
	}
	if (!deployWorkers) {
		log(
			'3. Build + deploy: npm run deploy:cf in apps/app and apps/admin; see docs/launch-checklist.md',
			'gray',
		)
	}
	if (!workersBuildsConfigured) {
		log('4. Configure Workers Builds: npm run launch:workers-builds', 'gray')
	}
	log(
		'5. Push to main/dev — GHA runs CI, then Cloudflare builds and deploys affected Workers',
		'gray',
	)
	log(
		'6. Follow docs/launch-checklist.md for LAUNCH_STATUS and product phases',
		'gray',
	)
	log(
		`7. Route jobs.${apex} to the jobs-cron Worker (custom domain in Cloudflare)`,
		'gray',
	)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
