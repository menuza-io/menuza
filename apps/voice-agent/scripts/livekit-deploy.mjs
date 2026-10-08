#!/usr/bin/env node
/**
 * Deploy the voice worker to LiveKit Cloud agent hosting.
 *
 * LiveKit Cloud builds the image from an uploaded directory, so this stages a
 * pruned monorepo (`turbo prune voice-agent --docker`) next to the Dockerfile
 * and runs the LiveKit CLI (`lk`) on that directory.
 *
 * Usage (from the repo root):
 *   npm run deploy:livekit -w voice-agent                       # new version
 *   npm run deploy:livekit -w voice-agent -- --create --secrets-file launch.voice-agent.env
 *   npm run deploy:livekit -w voice-agent -- --update-secrets --secrets-file launch.voice-agent.env
 *   npm run deploy:livekit -w voice-agent -- --stage-only --out /tmp/voice-agent-context
 *
 * Env:
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET  LiveKit Cloud project
 *   LIVEKIT_AGENT_ID                                   required except for --create
 */
import { spawnSync } from 'node:child_process'
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = resolve(agentDir, '../..')
// `npm run -w voice-agent` runs in apps/voice-agent; resolve paths from where
// the command was typed.
const invocationDir = process.env.INIT_CWD ?? process.cwd()

const REQUIRED_SECRETS = [
	'DATA_REGION',
	'VOICE_AGENT_TOKEN',
	'APP_URL',
	'TENANT_API_URL',
	'DEEPGRAM_API_KEY',
	'GOOGLE_API_KEY',
	'CARTESIA_API_KEY',
]
// LiveKit Cloud injects these itself and rejects them as secrets.
const LIVEKIT_MANAGED = new Set([
	'LIVEKIT_URL',
	'LIVEKIT_API_KEY',
	'LIVEKIT_API_SECRET',
])

const { values: args } = parseArgs({
	options: {
		create: { type: 'boolean', default: false },
		'update-secrets': { type: 'boolean', default: false },
		'stage-only': { type: 'boolean', default: false },
		'secrets-file': { type: 'string' },
		region: { type: 'string', default: 'us-east' },
		out: { type: 'string' },
	},
})

class DeployError extends Error {}

// Throws instead of exiting so the temporary secrets file is always removed.
function fail(message) {
	throw new DeployError(message)
}

function run(command, commandArgs, cwd) {
	const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit' })
	if (result.error?.code === 'ENOENT') {
		fail(
			`${command} is not installed. Install the LiveKit CLI: https://docs.livekit.io/reference/developer-tools/livekit-cli/`,
		)
	}
	if (result.status !== 0) {
		fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
	}
}

function projectSubdomain() {
	const url = process.env.LIVEKIT_URL
	if (!url) fail('LIVEKIT_URL is not set.')
	const host = new URL(url).hostname
	const match = host.match(/^([a-z0-9-]+)\.livekit\.cloud$/i)
	if (!match) {
		fail(
			`LIVEKIT_URL must be a LiveKit Cloud project URL (wss://<project>.livekit.cloud), got ${host}.`,
		)
	}
	return match[1]
}

function agentId() {
	const id = process.env.LIVEKIT_AGENT_ID
	if (!id) {
		fail(
			'LIVEKIT_AGENT_ID is not set. Create the agent once with --create, then save the printed ID.',
		)
	}
	return id
}

function parseSecretsFile(path) {
	if (!existsSync(path)) fail(`Secrets file not found: ${path}`)
	/** @type {Map<string, string>} */
	const secrets = new Map()
	for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const separator = line.indexOf('=')
		if (separator <= 0) continue
		const key = line.slice(0, separator).trim()
		let value = line.slice(separator + 1).trim()
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
		if (value && !LIVEKIT_MANAGED.has(key)) secrets.set(key, value)
	}
	const missing = REQUIRED_SECRETS.filter((key) => !secrets.has(key))
	if (missing.length > 0) {
		fail(`${path} is missing values for: ${missing.join(', ')}`)
	}
	if (secrets.get('DATA_REGION') !== 'us') {
		fail('DATA_REGION must be "us": the worker only handles US calls.')
	}
	return secrets
}

/** Writes only non-empty, non-LiveKit values so `lk` never sets blank secrets. */
function writeFilteredSecrets(workDir) {
	const source = args['secrets-file']
	if (!source) return null
	const secrets = parseSecretsFile(resolve(invocationDir, source))
	const filtered = join(workDir, 'secrets.env')
	writeFileSync(
		filtered,
		[...secrets].map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
		{ mode: 0o600 },
	)
	return filtered
}

function stageBuildContext(contextDir) {
	run(
		'npx',
		['turbo', 'prune', 'voice-agent', '--docker', '--out-dir', contextDir],
		rootDir,
	)

	renameSync(
		join(contextDir, 'full/apps/voice-agent/.env.schema'),
		join(contextDir, 'full/apps/voice-agent/env.schema'),
	)
	copyFileSync(join(agentDir, 'Dockerfile'), join(contextDir, 'Dockerfile'))
	copyFileSync(
		join(agentDir, 'Dockerfile.dockerignore'),
		join(contextDir, '.dockerignore'),
	)

	// `lk` detects a Node agent and checks the SDK version from a package.json
	// at the root of the upload. The image is built from json/ and full/.
	const agentPackage = JSON.parse(
		readFileSync(join(agentDir, 'package.json'), 'utf8'),
	)
	writeFileSync(
		join(contextDir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'voice-agent-livekit-context',
				private: true,
				dependencies: {
					'@livekit/agents': agentPackage.dependencies['@livekit/agents'],
				},
			},
			null,
			'\t',
		)}\n`,
	)
}

function writeLivekitToml(contextDir) {
	writeFileSync(
		join(contextDir, 'livekit.toml'),
		`[project]\n  subdomain = "${projectSubdomain()}"\n\n[agent]\n  id = "${agentId()}"\n`,
	)
}

function main() {
	const modes = [args.create, args['update-secrets'], args['stage-only']]
	if (modes.filter(Boolean).length > 1) {
		fail('Use only one of --create, --update-secrets, and --stage-only.')
	}
	if (args.create && !args['secrets-file']) {
		fail('--create needs --secrets-file so the first version can start.')
	}
	if (args['update-secrets'] && !args['secrets-file']) {
		fail('--update-secrets needs --secrets-file.')
	}

	const workDir = mkdtempSync(join(tmpdir(), 'voice-agent-livekit-'))
	try {
		const secretsFile = writeFilteredSecrets(workDir)
		const secretArgs = secretsFile ? ['--secrets-file', secretsFile] : []

		if (args['update-secrets']) {
			projectSubdomain()
			run('lk', ['agent', 'update-secrets', '--id', agentId(), ...secretArgs])
			return
		}

		const contextDir = args.out
			? resolve(invocationDir, args.out)
			: join(workDir, 'context')
		if (args.out && existsSync(contextDir)) {
			fail(`${contextDir} already exists; pass a new directory to --out.`)
		}
		stageBuildContext(contextDir)

		if (args['stage-only']) {
			if (process.env.LIVEKIT_URL && process.env.LIVEKIT_AGENT_ID) {
				writeLivekitToml(contextDir)
			}
			console.log(`\nStaged LiveKit build context: ${contextDir}`)
			return
		}

		if (args.create) {
			projectSubdomain()
			run('lk', [
				'agent',
				'create',
				'--region',
				args.region,
				'--silent',
				...secretArgs,
				contextDir,
			])
			const toml = readFileSync(join(contextDir, 'livekit.toml'), 'utf8')
			const id = toml.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1]
			console.log(
				`\n✓ Created the LiveKit Cloud agent${id ? ` ${id}` : ''} in ${args.region}.`,
			)
			console.log(
				'  Save the ID as the LIVEKIT_AGENT_ID GitHub variable so CI can deploy new versions.',
			)
			return
		}

		writeLivekitToml(contextDir)
		run('lk', ['agent', 'deploy', ...secretArgs, contextDir])
	} finally {
		rmSync(workDir, { recursive: true, force: true })
	}
}

try {
	main()
} catch (error) {
	if (!(error instanceof DeployError)) throw error
	console.error(`\n✗ ${error.message}`)
	process.exitCode = 1
}
