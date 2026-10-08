const DEV_VOICE_AGENT_TOKEN = 'dev-voice-agent-token-do-not-use-in-prod-32b'

type WorkerEnv = {
	NODE_ENV?: string
	VOICE_AGENT_TOKEN?: string
	APP_URL?: string
	TENANT_API_URL?: string
	DEEPGRAM_API_KEY?: string
	GOOGLE_API_KEY?: string
	CARTESIA_API_KEY?: string
}

function isPublicHttpsUrl(value: string | undefined) {
	if (!value) return false
	try {
		const url = new URL(value)
		const host = url.hostname
		return (
			url.protocol === 'https:' &&
			host !== 'localhost' &&
			!host.endsWith('.localhost') &&
			!host.endsWith('.test') &&
			host !== '127.0.0.1' &&
			host !== '[::1]'
		)
	} catch {
		return false
	}
}

export function productionConfigProblems(env: WorkerEnv) {
	if (env.NODE_ENV !== 'production') return []
	const problems: string[] = []
	if (
		!env.VOICE_AGENT_TOKEN ||
		env.VOICE_AGENT_TOKEN === DEV_VOICE_AGENT_TOKEN
	) {
		problems.push('VOICE_AGENT_TOKEN is the development default')
	}
	for (const name of ['APP_URL', 'TENANT_API_URL'] as const) {
		if (!isPublicHttpsUrl(env[name])) {
			problems.push(`${name} must be a public https:// URL`)
		}
	}
	for (const name of [
		'DEEPGRAM_API_KEY',
		'GOOGLE_API_KEY',
		'CARTESIA_API_KEY',
	] as const) {
		if (!env[name]) problems.push(`${name} is not set`)
	}
	return problems
}

/**
 * The schema's development defaults would let a production worker register
 * with LiveKit and then fail every call. Exiting at startup instead keeps the
 * LiveKit Cloud health check failing, so a rolling deploy leaves the previous
 * version answering calls.
 */
export function assertProductionConfig(env: WorkerEnv) {
	const problems = productionConfigProblems(env)
	if (problems.length > 0) {
		throw new Error(
			`The voice worker is not configured for production: ${problems.join('; ')}.`,
		)
	}
}
