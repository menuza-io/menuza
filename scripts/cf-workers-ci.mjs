#!/usr/bin/env node
/**
 * Build and deploy helpers for Cloudflare Workers Builds.
 *
 * Workers Builds runs `build` then `deploy` in the same job container.
 * GitHub Actions triggers the Workers Builds API after CI passes (see deploy.yml).
 *
 * Usage:
 *   node scripts/cf-workers-ci.mjs build --app app
 *   node scripts/cf-workers-ci.mjs deploy --app app
 *
 * Branch → environment:
 *   WORKERS_CI_BRANCH=dev  → staging (wrangler --env staging)
 *   WORKERS_CI_BRANCH=main → production
 *
 * Set the same binding/URL env vars as GitHub Actions Variables on each Worker
 * under Settings → Builds → Build variables (see docs/workers-builds.md).
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

/** @type {Record<string, {
 *   patchApp: string,
 *   turboFilter?: string,
 *   buildEnv?: Record<string, string>,
 *   sitesBuildEnv?: boolean,
 *   skipTurboBuild?: boolean,
 *   deploy: {
 *     cwd: string,
 *     config?: string,
 *     npmScript?: string,
 *     wranglerStagingEnv?: boolean,
 *     wranglerEmptyEnv?: boolean,
 *   },
 * }>} */
const APPS = {
	app: {
		patchApp: 'app',
		turboFilter: 'app',
		buildEnv: {
			NODE_OPTIONS: '--max-old-space-size=6144',
			DEPLOY_TARGET: 'cloudflare',
		},
		deploy: {
			cwd: 'apps/app',
			config: 'build/server/wrangler.deploy.json',
			wranglerStagingEnv: true,
		},
	},
	admin: {
		patchApp: 'admin',
		turboFilter: 'admin',
		buildEnv: {
			NODE_OPTIONS: '--max-old-space-size=6144',
			DEPLOY_TARGET: 'cloudflare',
		},
		deploy: {
			cwd: 'apps/admin',
			config: 'build/server/wrangler.deploy.json',
			wranglerStagingEnv: true,
		},
	},
	web: {
		patchApp: 'web',
		turboFilter: 'web',
		deploy: {
			cwd: 'apps/web',
			config: 'dist/server/wrangler.deploy.json',
			wranglerEmptyEnv: true,
		},
	},
	sites: {
		patchApp: 'sites',
		turboFilter: 'sites',
		sitesBuildEnv: true,
		deploy: {
			cwd: 'apps/sites',
			config: 'dist/server/wrangler.deploy.json',
			wranglerEmptyEnv: true,
		},
	},
	'jobs-cron': {
		patchApp: 'jobs-cron',
		skipTurboBuild: true,
		deploy: {
			cwd: 'apps/jobs-cron',
			config: 'wrangler.deploy.jsonc',
			wranglerStagingEnv: true,
		},
	},
	'tenant-api': {
		patchApp: 'tenant-api',
		turboFilter: 'tenant-api',
		deploy: {
			cwd: 'apps/tenant-api',
			npmScript: 'deploy:cf',
			wranglerStagingEnv: true,
		},
	},
}

function parseArgs(argv) {
	const args = { phase: null, app: null }
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === 'build' || arg === 'deploy') args.phase = arg
		else if (arg === '--app') args.app = argv[++i]
		else if (arg === '--help' || arg === '-h') {
			console.log(
				`Usage: node scripts/cf-workers-ci.mjs <build|deploy> --app <${Object.keys(APPS).join('|')}>`,
			)
			process.exit(0)
		}
	}
	if (!args.phase || !args.app || !APPS[args.app]) {
		console.error(
			`Usage: node scripts/cf-workers-ci.mjs <build|deploy> --app <${Object.keys(APPS).join('|')}>`,
		)
		process.exit(1)
	}
	return args
}

export function resolveDeployEnv() {
	if (process.env.DEPLOY_ENV) return process.env.DEPLOY_ENV
	const branch =
		process.env.WORKERS_CI_BRANCH ||
		process.env.GITHUB_REF_NAME ||
		process.env.GITHUB_HEAD_REF ||
		'main'
	return branch === 'dev' ? 'staging' : 'production'
}

function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, {
		stdio: 'inherit',
		cwd: options.cwd ?? rootDir,
		env: { ...process.env, ...options.env },
	})
	if (result.status !== 0) {
		process.exit(result.status ?? 1)
	}
}

function sitesBuildEnv(deployEnv) {
	const suffix = deployEnv === 'staging' ? '_STAGING' : ''
	/** @type {Record<string, string>} */
	const env = {}
	for (const key of ['PUBLIC_APP_URL', 'TENANT_API_URL']) {
		const value = process.env[`${key}${suffix}`] || process.env[key]
		if (value) env[key] = value
	}
	if (process.env.TENANT_API_URL_KSA) {
		env.TENANT_API_URL_KSA = process.env.TENANT_API_URL_KSA
	}
	return env
}

function installDeps() {
	run('npm', ['ci', '--ignore-scripts'])
	run('npm', [
		'rebuild',
		'sharp',
		'libsql',
		'rolldown',
		'@astrojs/compiler-binding',
	])
	run('node', ['packages/ui/generate-icons.js'])
	run('npm', ['run', 'env:codegen'])
}

function patchWrangler(appKey, deployEnv) {
	run('node', [
		'scripts/patch-wrangler.mjs',
		'--app',
		APPS[appKey].patchApp,
		'--env',
		deployEnv,
	])
}

function buildApp(appKey) {
	const config = APPS[appKey]
	const deployEnv = resolveDeployEnv()

	console.log(`[cf-workers-ci] build ${appKey} (${deployEnv})`)

	installDeps()

	if (appKey === 'app' || appKey === 'admin') {
		run('node', ['scripts/write-ci-app-env.mjs', '--for-cloudflare-build'])
	}

	if (config.turboFilter) {
		run('npx', ['turbo', 'run', 'build', `--filter=${config.turboFilter}`], {
			env: {
				...config.buildEnv,
				...(config.sitesBuildEnv ? sitesBuildEnv(deployEnv) : {}),
			},
		})
	}

	patchWrangler(appKey, deployEnv)
}

function deployApp(appKey) {
	const config = APPS[appKey]
	const deployEnv = resolveDeployEnv()
	const deploy = config.deploy
	const cwd = join(rootDir, deploy.cwd)

	console.log(`[cf-workers-ci] deploy ${appKey} (${deployEnv})`)

	if (deploy.npmScript) {
		const args = [
			'run',
			deploy.npmScript,
			'--',
			'--config',
			'wrangler.deploy.jsonc',
		]
		if (deploy.wranglerStagingEnv && deployEnv === 'staging') {
			args.push('--env', 'staging')
		}
		run('npm', args, { cwd })
		return
	}

	const args = ['wrangler', 'deploy', '--config', deploy.config]
	if (deploy.wranglerStagingEnv && deployEnv === 'staging') {
		args.push('--env', 'staging')
	} else if (deploy.wranglerEmptyEnv) {
		args.push('--env', '')
	}
	run('npx', args, { cwd })
}

function main() {
	const { phase, app } = parseArgs(process.argv)
	if (phase === 'build') buildApp(app)
	else deployApp(app)
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) main()
