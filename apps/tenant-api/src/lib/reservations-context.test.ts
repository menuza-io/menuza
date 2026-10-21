import { type ReservationsContext } from '@repo/reservations'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getReservationsContext,
	invalidateReservationsContext,
	RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS,
	RESERVATIONS_CONTEXT_FRESH_TTL_MS,
	RESERVATIONS_CONTEXT_STALE_TTL_MS,
	resetReservationsContextCache,
} from './reservations-context.ts'
import { applyVarlockEnv } from './secrets.ts'

const ORG_ID = 'clw9x0a12000008l00rsvorg1'
const INTERNAL_TOKEN = 'test-internal-command-token-32chars'

function makeContext(
	overrides: Partial<ReservationsContext> = {},
): ReservationsContext {
	return {
		orgId: ORG_ID,
		dataRegion: 'us',
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			payments: true,
			experiences: true,
			voice: false,
		},
		organization: {
			name: 'Acme Bistro',
			slug: 'acme',
			defaultLocale: 'en',
			locales: ['en', 'ar'],
			siteOrigin: 'https://acme.menuza.test',
			sitePublished: true,
			logoUrl: null,
			emailTheme: {
				organizationName: 'Acme Bistro',
				logoUrl: null,
				appUrl: 'http://localhost:3001',
				background: '#ffffff',
				card: '#f9fafb',
				foreground: '#111827',
				muted: '#f3f4f6',
				mutedForeground: '#6b7280',
				border: '#e5e7eb',
				primary: '#111827',
				primaryForeground: '#ffffff',
				accent: '#2563eb',
				accentForeground: '#ffffff',
				radius: 8,
				headingFont: 'Inter, sans-serif',
				bodyFont: 'Inter, sans-serif',
			},
		},
		locations: [
			{
				id: 'loc_soho',
				slug: 'soho',
				name: 'Acme SoHo',
				timeZone: 'America/New_York',
				currency: 'USD',
				phone: '+12125550100',
				address: {
					formattedAddress: '123 Mercer St',
					city: 'New York',
					lat: 40.72,
					lng: -74.0,
				},
				storeHours: null,
				specialHours: null,
				isActive: true,
			},
		],
		payments: {
			processor: 'connect',
			deposit: true,
			guarantee: true,
			platformFeeBp: 150,
		},
		staffing: {
			enabled: true,
		},
		voice: {
			enabled: false,
		},
		...overrides,
	}
}

describe('reservations-context cache (VAL-FND-018)', () => {
	const fetchSpy = vi.fn()

	beforeEach(() => {
		resetReservationsContextCache()
		fetchSpy.mockReset()
		vi.stubGlobal('fetch', fetchSpy)
		vi.stubEnv('APP_URL', 'http://localhost:3001')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL_TOKEN)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('fetches context from App and caches within the 5-minute (300_000ms) fresh TTL with redirect: error', async () => {
		expect(RESERVATIONS_CONTEXT_FRESH_TTL_MS).toBe(300_000)
		expect(RESERVATIONS_CONTEXT_STALE_TTL_MS).toBe(86_400_000)
		expect(RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS).toBe(30_000)

		const ctx = makeContext()
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify(ctx), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const t0 = 1_000_000
		const first = await getReservationsContext(ORG_ID, { now: t0 })
		expect(first).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(fetchSpy).toHaveBeenCalledWith(
			`http://localhost:3001/resources/reservations/context?orgId=${ORG_ID}`,
			expect.objectContaining({
				redirect: 'error',
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${INTERNAL_TOKEN}`,
				},
			}),
		)

		// Within 5-minute fresh window -> serves from memory without calling fetch
		const second = await getReservationsContext(ORG_ID, {
			now: t0 + RESERVATIONS_CONTEXT_FRESH_TTL_MS - 1_000,
		})
		expect(second).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('serves up to 24-hour stale entry on fetch failure, enforces 30s failure cooldown, and drops after 24 hours', async () => {
		const ctx = makeContext()
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify(ctx), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const t0 = 1_000_000
		await getReservationsContext(ORG_ID, { now: t0 })
		expect(fetchSpy).toHaveBeenCalledTimes(1)

		// After 5m fresh TTL, App returns 503 -> stale fallback within 24h succeeds
		const tFail = t0 + RESERVATIONS_CONTEXT_FRESH_TTL_MS + 10_000
		fetchSpy.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
		const stale = await getReservationsContext(ORG_ID, {
			now: tFail,
		})
		expect(stale).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(2)

		// Within 30s failure cooldown -> serves stale cached entry without calling fetch again
		const cooldownStale = await getReservationsContext(ORG_ID, {
			now: tFail + RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS - 1_000,
		})
		expect(cooldownStale).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(2)

		// After 30s failure cooldown -> retries fetch; still within 24h stale window so returns stale
		fetchSpy.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
		const retriedStale = await getReservationsContext(ORG_ID, {
			now: tFail + RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS + 1_000,
		})
		expect(retriedStale).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(3)

		// Beyond 24-hour stale TTL, failed fetch returns null
		fetchSpy.mockRejectedValueOnce(new Error('network error'))
		const expired = await getReservationsContext(ORG_ID, {
			now: t0 + RESERVATIONS_CONTEXT_STALE_TTL_MS + 1_000,
		})
		expect(expired).toBeNull()
	})

	it('invalidates immediately when invalidateReservationsContext is called', async () => {
		const baseCtx = makeContext()
		const firstCtx = makeContext({
			organization: { ...baseCtx.organization, name: 'Acme V1' },
		})
		const secondCtx = makeContext({
			organization: { ...baseCtx.organization, name: 'Acme V2' },
		})
		fetchSpy
			.mockResolvedValueOnce(
				new Response(JSON.stringify(firstCtx), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(secondCtx), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)

		const t0 = 1_000_000
		const v1 = await getReservationsContext(ORG_ID, { now: t0 })
		expect(v1?.organization.name).toBe('Acme V1')

		invalidateReservationsContext(ORG_ID)

		const v2 = await getReservationsContext(ORG_ID, { now: t0 + 1_000 })
		expect(v2?.organization.name).toBe('Acme V2')
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})
})
