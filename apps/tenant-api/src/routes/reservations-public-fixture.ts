import {
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvLocationSettings,
	rsvServices,
	rsvTables,
	rsvTags,
} from '@repo/tenant-db'
import { type ReservationsContext } from '@repo/reservations'
import { seedReservationsContextForTest } from '../lib/reservations-context.ts'

/** Shared seed for the public online-booking tests (routes, security and concurrency). */
export const US_ORIGIN = 'http://acme.menuza.test:3008'
export const KSA_ORIGIN = 'http://riyadh.menuza.test:3008'
export const UNKNOWN_ORIGIN = 'http://no-such-org.menuza.test:3008'

export const PUBLIC_LOC = 'loc_pub_main'

/** A UTC calendar date `days` from today; the fixture location runs in UTC. */
export function dateAhead(days: number): string {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + days)
	return d.toISOString().slice(0, 10)
}

export function publicContext(
	orgId: string,
	options: {
		dataRegion?: 'us' | 'ksa'
		online?: boolean
		waitlist?: boolean
		experiences?: boolean
		enabled?: boolean
		/** The organization's Website settings languages (default: English only). */
		locales?: string[]
		defaultLocale?: string
		/** Turns the payments feature on and sets the processor capability. */
		payments?: {
			processor: 'connect' | 'checkout' | null
			deposit: boolean
			guarantee: boolean
		}
	} = {},
): ReservationsContext {
	return {
		orgId,
		dataRegion: options.dataRegion ?? 'us',
		features: {
			enabled: options.enabled ?? true,
			online: options.online ?? true,
			waitlist: options.waitlist ?? true,
			experiences: options.experiences ?? false,
			payments: Boolean(options.payments),
			voice: false,
		},
		organization: {
			name: 'Acme Bistro',
			slug: 'acme',
			defaultLocale: options.defaultLocale ?? 'en',
			locales: options.locales ?? ['en'],
			siteOrigin: 'https://acme.menuza.test',
			sitePublished: true,
			logoUrl: null,
			emailTheme: {
				organizationName: 'Acme Bistro',
				logoUrl: null,
				appUrl: 'https://app.menuza.test',
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
				id: PUBLIC_LOC,
				name: 'Acme Downtown',
				slug: 'downtown',
				timeZone: 'UTC',
				currency: 'USD',
				phone: '+12125550100',
				address: {
					formattedAddress: '100 Main St, New York',
					city: 'New York',
					lat: null,
					lng: null,
				},
				storeHours: null,
				specialHours: null,
				isActive: true,
			},
		],
		payments: options.payments ?? {
			processor: null,
			deposit: false,
			guarantee: false,
		},
		staffing: { enabled: false },
		voice: { enabled: false },
	}
}

/**
 * One bookable location in UTC with a 2-top, a 4-top and a large table, one
 * dinner service (17:00 to 21:30 last seating) and two guest-selectable tags.
 */
export async function seedPublicOrg(
	orgId: string,
	options: {
		dataRegion?: 'us' | 'ksa'
		settings?: Partial<typeof rsvLocationSettings.$inferInsert>
		seedContext?: boolean
		locales?: string[]
		defaultLocale?: string
	} = {},
) {
	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	await db.insert(rsvLocationSettings).values({
		locationId: PUBLIC_LOC,
		enabled: true,
		onlineEnabled: true,
		timeZone: 'UTC',
		intervalMin: 15,
		horizonDays: 60,
		minNoticeMin: 60,
		onlinePartyMin: 1,
		onlinePartyMax: 4,
		partyMax: 30,
		largePartyMode: 'request',
		contactPhone: '+12125550100',
		...options.settings,
	})
	await db.insert(rsvAreas).values({
		id: 'area_pub_main',
		locationId: PUBLIC_LOC,
		name: 'Main Room',
		sort: 0,
		onlineBookable: true,
		guestSelectable: true,
	})
	await db.insert(rsvTables).values([
		{
			id: 'tbl_pub_2',
			locationId: PUBLIC_LOC,
			areaId: 'area_pub_main',
			label: 'T2',
			minCovers: 1,
			maxCovers: 2,
			onlineBookable: true,
			resetBufferMin: 0,
		},
		{
			id: 'tbl_pub_4',
			locationId: PUBLIC_LOC,
			areaId: 'area_pub_main',
			label: 'T4',
			minCovers: 3,
			maxCovers: 4,
			onlineBookable: true,
			resetBufferMin: 0,
		},
		{
			id: 'tbl_pub_12',
			locationId: PUBLIC_LOC,
			areaId: 'area_pub_main',
			label: 'T12',
			minCovers: 5,
			maxCovers: 12,
			onlineBookable: true,
			resetBufferMin: 0,
		},
	])
	await db.insert(rsvServices).values({
		id: 'svc_pub_dinner',
		locationId: PUBLIC_LOC,
		name: 'Dinner',
		daysMask: 127,
		firstSeatingMin: 17 * 60,
		lastSeatingMin: 21 * 60 + 30,
		endMin: 22 * 60,
		onlineEnabled: true,
		sort: 0,
	})
	await db.insert(rsvTags).values([
		{
			id: 'tag_pub_birthday',
			scope: 'reservation',
			name: 'Birthday',
			category: 'occasion',
			systemKey: 'birthday',
			guestSelectable: true,
		},
		{
			id: 'tag_pub_nuts',
			scope: 'guest',
			name: 'Nut allergy',
			category: 'dietary',
			guestSelectable: true,
		},
	])
	if (options.seedContext !== false) {
		seedReservationsContextForTest(
			orgId,
			publicContext(orgId, {
				dataRegion: options.dataRegion,
				locales: options.locales,
				defaultLocale: options.defaultLocale,
			}),
		)
	}
	return db
}
