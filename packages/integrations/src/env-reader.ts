/**
 * Runtime environment variable reader that avoids build-time AST inlining.
 */

export function readEnv(key: string): string | undefined {
	if (!key) return undefined
	const fromProcess =
		typeof process !== 'undefined' && process.env?.[key]
			? process.env[key]?.trim()
			: ''
	if (fromProcess) return fromProcess

	const varlockValue = (
		globalThis as {
			__varlockLoadedEnv?: {
				config?: Record<string, { value?: unknown }>
			}
		}
	).__varlockLoadedEnv?.config?.[key]?.value
	if (typeof varlockValue === 'string' && varlockValue.trim()) {
		return varlockValue.trim()
	}

	return undefined
}
