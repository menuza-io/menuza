import { env as workerEnv } from 'web:worker-env'

type WebEnvKey =
	| 'PUBLIC_ROOT_APP'
	| 'PUBLIC_APP_URL'
	| 'PUBLIC_POSTHOG_PROJECT_TOKEN'
	| 'PUBLIC_POSTHOG_HOST'
	| 'PUBLIC_POSTHOG_RELEASE'

const workerKeys: Record<WebEnvKey, readonly string[]> = {
	PUBLIC_ROOT_APP: ['PUBLIC_ROOT_APP', 'ROOT_APP'],
	PUBLIC_APP_URL: ['PUBLIC_APP_URL'],
	PUBLIC_POSTHOG_PROJECT_TOKEN: [
		'PUBLIC_POSTHOG_PROJECT_TOKEN',
		'POSTHOG_PROJECT_TOKEN',
	],
	PUBLIC_POSTHOG_HOST: ['PUBLIC_POSTHOG_HOST', 'POSTHOG_HOST'],
	PUBLIC_POSTHOG_RELEASE: ['PUBLIC_POSTHOG_RELEASE', 'COMMIT_SHA'],
}

export function getWebEnv(key: WebEnvKey): string {
	const bindings = workerEnv as Record<string, unknown>
	for (const binding of workerKeys[key]) {
		const value = bindings[binding]
		if (typeof value === 'string') return value
	}

	return ''
}
