import { ENV } from 'varlock/env'

import { selectRouter, type Router } from '@repo/geo'

import { syncEnvFromProcess } from './secrets.ts'

let override: Router | null | undefined

function isProduction(): boolean {
	const nodeEnv =
		(typeof process !== 'undefined' ? process.env.NODE_ENV : undefined) ??
		(ENV as { NODE_ENV?: string }).NODE_ENV
	return nodeEnv === 'production'
}

/**
 * Driving-distance router for delivery fees by distance (#421). Google Routes
 * when `GOOGLE_MAPS_API_KEY` is set (enable the Routes API on the key); a
 * deterministic dev router in development and test; `null` in production without
 * a key, where a zone priced by road distance falls back to the straight-line
 * distance. Plain `fetch`, so it runs on the US Worker and the KSA Node runtime.
 */
export function getRouter(): Router | null {
	if (override !== undefined) return override
	syncEnvFromProcess()
	let apiKey = ''
	try {
		apiKey = (ENV as { GOOGLE_MAPS_API_KEY?: string }).GOOGLE_MAPS_API_KEY ?? ''
	} catch {
		// Env resolved before the key joined the schema: treat as unset.
	}
	return selectRouter({ apiKey, isProduction: isProduction() })
}

/** Test hook: force a router (or `null`); pass `undefined` to reset. */
export function setRouterForTesting(router: Router | null | undefined) {
	override = router
}
