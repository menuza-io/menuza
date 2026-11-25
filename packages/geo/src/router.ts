import { z } from 'zod'

import { haversineMeters } from './coverage.ts'
import {
	RouterError,
	type DrivingRoute,
	type FetchLike,
	type Router,
} from './types.ts'

/**
 * Driving-distance providers (#421): Google Routes over plain `fetch`
 * (Workers + Node), and a deterministic dev router for local development and
 * tests. Neither logs coordinates or results.
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const REQUEST_TIMEOUT_MS = 4_000

/** Roads are longer than the crow flies; the dev router says by how much. */
export const DEV_ROUTE_DETOUR_FACTOR = 1.35
/** Average speed the dev router drives at, in meters per second (30 km/h). */
const DEV_ROUTE_SPEED_MPS = 30_000 / 3600

const routesResponseSchema = z.object({
	routes: z
		.array(
			z.object({
				distanceMeters: z.number().int().min(0).optional(),
				duration: z.string().optional(),
			}),
		)
		.default([]),
})

function parseSeconds(duration: string | undefined): number | null {
	const match = /^(\d+(?:\.\d+)?)s$/.exec(duration ?? '')
	return match ? Math.round(Number(match[1])) : null
}

export function createGoogleRouter(options: {
	apiKey: string
	fetch?: FetchLike
	timeoutMs?: number
}): Router {
	const apiKey = options.apiKey.trim()
	if (!apiKey) throw new Error('createGoogleRouter requires an apiKey')
	const doFetch: FetchLike =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
	return {
		name: 'google',
		async drivingDistance(from, to): Promise<DrivingRoute | null> {
			let response: Response
			try {
				response = await doFetch(ROUTES_URL, {
					method: 'POST',
					redirect: 'error',
					signal: AbortSignal.timeout(timeoutMs),
					headers: {
						'Content-Type': 'application/json',
						'X-Goog-Api-Key': apiKey,
						'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
					},
					body: JSON.stringify({
						origin: {
							location: {
								latLng: { latitude: from.lat, longitude: from.lng },
							},
						},
						destination: {
							location: { latLng: { latitude: to.lat, longitude: to.lng } },
						},
						travelMode: 'DRIVE',
						routingPreference: 'TRAFFIC_UNAWARE',
					}),
				})
			} catch (error) {
				throw new RouterError(
					`routes: request failed (${error instanceof Error ? error.message : 'network error'})`,
				)
			}
			if (!response.ok) {
				throw new RouterError(`routes failed with HTTP ${response.status}`, {
					status: response.status,
				})
			}
			let json: unknown
			try {
				json = await response.json()
			} catch {
				throw new RouterError('routes: invalid JSON response')
			}
			const parsed = routesResponseSchema.safeParse(json)
			if (!parsed.success) throw new RouterError('routes: unexpected response')
			const route = parsed.data.routes[0]
			if (!route || route.distanceMeters === undefined) return null
			return {
				meters: route.distanceMeters,
				seconds: parseSeconds(route.duration),
			}
		},
	}
}

/**
 * Deterministic router for local development and tests: the straight-line
 * distance times a fixed detour factor, so a "6 km by road" address is simply
 * one a little under 4.5 km away as the crow flies.
 */
export function createDevRouter(
	options: { detourFactor?: number } = {},
): Router {
	const factor = options.detourFactor ?? DEV_ROUTE_DETOUR_FACTOR
	return {
		name: 'dev',
		async drivingDistance(from, to) {
			const meters = Math.round(haversineMeters(from, to) * factor)
			return {
				meters,
				seconds: Math.round(meters / DEV_ROUTE_SPEED_MPS),
			}
		},
	}
}

/**
 * Picks the router for a server runtime: Google when a key is configured, the
 * dev router outside production, otherwise none (callers then use the
 * straight-line distance).
 */
export function selectRouter(options: {
	apiKey?: string | null
	isProduction: boolean
	fetch?: FetchLike
}): Router | null {
	const apiKey = options.apiKey?.trim()
	if (apiKey) return createGoogleRouter({ apiKey, fetch: options.fetch })
	if (!options.isProduction) return createDevRouter()
	return null
}
