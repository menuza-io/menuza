/**
 * Node `index.ts` loads MSW when `MOCKS=true`. Workers dev skips that entry, so
 * mock GitHub/Google login would hit real OAuth endpoints and fail.
 */
let mocksStarted = false

export async function startDevMocksIfEnabled() {
	if (mocksStarted || process.env.MOCKS !== 'true') return
	if (import.meta.env.PROD) return
	mocksStarted = true
	const { server } = await import('../tests/mocks/index.ts')
	server.listen({ onUnhandledRequest: 'bypass' })
}
