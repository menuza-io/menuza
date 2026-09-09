#!/usr/bin/env node
/**
 * Writes gitignored per-app .env files from process.env for CI builds.
 * Varlock validates required secrets at Vite config load time; workflow env
 * vars alone are not enough, but committed .env.production must stay empty.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const buildDefaults = {
	SESSION_SECRET: 'build-time-session-secret-placeholder-min-32-chars',
	HONEYPOT_SECRET: 'build-time-honeypot-secret-for-cloudflare-builds',
	INTEGRATION_ENCRYPTION_KEY:
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
	INTEGRATIONS_OAUTH_STATE_SECRET: 'build-oauth-state-secret-32-chars',
	TRUST_PROXY: 'true',
}

const forCloudflareBuild = process.argv.includes('--for-cloudflare-build')

const appEnvKeys = {
	'apps/admin': ['SESSION_SECRET', 'HONEYPOT_SECRET', 'TRUST_PROXY'],
	'apps/app': [
		'SESSION_SECRET',
		'HONEYPOT_SECRET',
		'INTEGRATION_ENCRYPTION_KEY',
		'INTEGRATIONS_OAUTH_STATE_SECRET',
		'TRUST_PROXY',
	],
}

for (const [appDir, keys] of Object.entries(appEnvKeys)) {
	const lines = keys
		.map((key) => {
			const value =
				process.env[key] ??
				(forCloudflareBuild ? buildDefaults[key] : undefined)
			return [key, value]
		})
		.filter(([, value]) => value != null && value !== '')
		.map(([key, value]) => `${key}=${value}`)

	if (lines.length === 0) {
		console.error(`Missing CI env vars for ${appDir}: ${keys.join(', ')}`)
		process.exit(1)
	}

	const envPath = path.join(root, appDir, '.env')
	writeFileSync(envPath, `${lines.join('\n')}\n`)
	console.log(`Wrote ${envPath}`)
}
