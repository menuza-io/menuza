import { ENV } from 'varlock/env'

/**
 * Vendor settings, read live: the Worker mirrors bindings into `process.env`
 * (see workers/worker-env.ts), so a rotated key applies without a redeploy.
 */
export function vendorEnv(
	name:
		| 'GELATO_API_KEY'
		| 'PRODIGI_API_KEY'
		| 'PRODIGI_SANDBOX'
		| 'PRINT_MOCK'
		| 'BASE_URL',
): string {
	const live = typeof process !== 'undefined' ? process.env?.[name] : undefined
	return String(live ?? (ENV as Record<string, unknown>)[name] ?? '').trim()
}
