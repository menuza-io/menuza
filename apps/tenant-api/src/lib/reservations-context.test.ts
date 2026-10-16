import { type ReservationsContext } from '@repo/reservations'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getReservationsContext,
	invalidateReservationsContext,
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

	it('fetches context from App and caches within the 60s fresh TTL', async () => {
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

		// Within 60s fresh window -> serves from memory without calling fetch
		const second = await getReservationsContext(ORG_ID, {
			now: t0 + RESERVATIONS_CONTEXT_FRESH_TTL_MS - 1_000,
		})
		expect(second).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('serves up to 5-minute stale entry on fetch failure and drops after 5 minutes', async () => {
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

		// After 60s, App returns 503 -> stale fallback within 5 minutes succeeds
		fetchSpy.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
		const stale = await getReservationsContext(ORG_ID, {
			now: t0 + RESERVATIONS_CONTEXT_FRESH_TTL_MS + 10_000,
		})
		expect(stale).toEqual(ctx)
		expect(fetchSpy).toHaveBeenCalledTimes(2)

		// Beyond 5-minute stale TTL, failed fetch returns null
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
