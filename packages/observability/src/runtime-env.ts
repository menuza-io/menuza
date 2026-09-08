/**
 * Runtime-injected environment values (Cloudflare Workers, CI runners).
 * These are not declared in every app's varlock schema, so read process.env
 * directly instead of the package ENV proxy.
 */
function readRuntimeEnv(name: string): string | undefined {
	const value = process.env[name]
	if (value === undefined || value === '') return undefined
	return value
}

export function isCiRuntime(): boolean {
	const ci = readRuntimeEnv('CI')
	return ci === 'true' || ci === '1'
}

export function getRuntimeRegion(): string | undefined {
	return readRuntimeEnv('CF_DATACENTER') ?? readRuntimeEnv('REGION')
}

export function getRuntimeDeploymentId(): string | undefined {
	return readRuntimeEnv('DEPLOYMENT_ID')
}
