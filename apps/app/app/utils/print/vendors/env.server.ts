import { readLiveEnv } from '#app/utils/env.server.ts'

/** Vendor settings, read live, so a rotated key applies without a redeploy. */
export function vendorEnv(
	name:
		| 'GELATO_API_KEY'
		| 'PRODIGI_API_KEY'
		| 'PRODIGI_SANDBOX'
		| 'PRINT_MOCK'
		| 'BASE_URL',
): string {
	return readLiveEnv(name)
}
