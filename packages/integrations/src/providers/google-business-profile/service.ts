import {
	DAYS_OF_WEEK,
	type LocationAddress,
	type WeeklySchedule,
} from '@repo/common/location-types'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	Integration as IntegrationTable,
} from '@repo/database'
import { z } from 'zod'
import {
	findScopedIntegration,
	resolveOrganizationLocationIdForConnect,
} from '../../location-integrations.ts'
import { tokenManager } from '../../token-manager'
import { GoogleBusinessProfileProvider } from './provider'

const addressSchema = z
	.object({
		addressLines: z.array(z.string()).optional(),
		locality: z.string().optional(),
		administrativeArea: z.string().optional(),
		postalCode: z.string().optional(),
		regionCode: z.string().optional(),
	})
	.passthrough()
const periodSchema = z.object({
	openDay: z.string(),
	closeDay: z.string(),
	openTime: z.object({
		hours: z.number().optional(),
		minutes: z.number().optional(),
	}),
	closeTime: z.object({
		hours: z.number().optional(),
		minutes: z.number().optional(),
	}),
})
const locationSchema = z
	.object({
		name: z.string().regex(/^locations\/[A-Za-z0-9_-]+$/),
		title: z.string().min(1),
		phoneNumbers: z.object({ primaryPhone: z.string().optional() }).optional(),
		storefrontAddress: addressSchema.optional(),
		websiteUri: z.string().optional(),
		regularHours: z
			.object({ periods: z.array(periodSchema).optional() })
			.optional(),
		categories: z.unknown().optional(),
		profile: z.object({ description: z.string().optional() }).optional(),
		metadata: z.unknown().optional(),
		latlng: z
			.object({
				latitude: z.number().optional(),
				longitude: z.number().optional(),
			})
			.optional(),
		openInfo: z.unknown().optional(),
	})
	.passthrough()
export type GoogleBusinessLocation = z.infer<typeof locationSchema>

const READ_MASK =
	'name,title,phoneNumbers,storefrontAddress,websiteUri,regularHours,categories,profile,metadata,latlng,openInfo'

async function getConnection(
	organizationId: string,
	organizationLocationId: string,
) {
	const integration = await findScopedIntegration(
		organizationId,
		'google-business-profile',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('Connect Google Business Profile first')
	}
	const token = await tokenManager.getValidAccessToken(
		integration,
		new GoogleBusinessProfileProvider(),
	)
	if (!token) throw new Error('Reconnect Google Business Profile to continue')
	return { integration, token }
}

async function googleGet<T>(
	url: URL,
	token: string,
	schema: z.ZodType<T>,
): Promise<T> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15000),
	})
	if (!response.ok)
		throw new Error(
			`Google Business Profile request failed (${response.status})`,
		)
	return schema.parse(await response.json())
}

export async function listGoogleBusinessLocations(
	organizationId: string,
	organizationLocationId?: string | null,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'google-business-profile',
		organizationLocationId,
	)
	if (!locationId) {
		throw new Error('A restaurant location is required.')
	}
	const { token } = await getConnection(organizationId, locationId)
	const results: GoogleBusinessLocation[] = []
	let pageToken: string | undefined
	do {
		const url = new URL(
			'https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations',
		)
		url.searchParams.set('readMask', READ_MASK)
		url.searchParams.set('pageSize', '100')
		if (pageToken) url.searchParams.set('pageToken', pageToken)
		const page = await googleGet(
			url,
			token,
			z.object({
				locations: z.array(locationSchema).optional(),
				nextPageToken: z.string().optional(),
			}),
		)
		results.push(...(page.locations ?? []))
		pageToken = page.nextPageToken
	} while (pageToken)
	return results
}

export function googleBusinessSchedule(
	location: GoogleBusinessLocation,
): WeeklySchedule | null {
	const periods = location.regularHours?.periods
	if (!periods) return null
	const slotsByDay = new Map<string, Array<{ start: string; end: string }>>()
	const time = (value: { hours?: number; minutes?: number }) =>
		`${String(value.hours ?? 0).padStart(2, '0')}:${String(value.minutes ?? 0).padStart(2, '0')}`
	const addSlot = (day: string, start: string, end: string) => {
		if (!DAYS_OF_WEEK.includes(day as (typeof DAYS_OF_WEEK)[number])) return
		const slots = slotsByDay.get(day) ?? []
		slots.push({ start, end })
		slotsByDay.set(day, slots)
	}
	for (const period of periods) {
		const openDay = period.openDay.toLowerCase()
		const closeDay = period.closeDay.toLowerCase()
		if (openDay === closeDay) {
			addSlot(openDay, time(period.openTime), time(period.closeTime))
		} else {
			addSlot(openDay, time(period.openTime), '23:59')
			addSlot(closeDay, '00:00', time(period.closeTime))
		}
	}
	return DAYS_OF_WEEK.map((day) => {
		const slots = slotsByDay.get(day) ?? []
		return { day, isOpen: slots.length > 0, slots }
	})
}

function address(location: GoogleBusinessLocation): LocationAddress | null {
	const source = location.storefrontAddress
	if (!source) return null
	return {
		formattedAddress: [
			...(source.addressLines ?? []),
			source.locality,
			source.administrativeArea,
			source.postalCode,
			source.regionCode,
		]
			.filter(Boolean)
			.join(', '),
		city: source.locality ?? '',
		state: source.administrativeArea ?? '',
		postalCode: source.postalCode ?? '',
		country: source.regionCode ?? '',
		lat: location.latlng?.latitude ?? 0,
		lng: location.latlng?.longitude ?? 0,
	}
}

/** Imports only the listing the operator selected. Reimports update its linked Menuza location. */
export async function importGoogleBusinessLocation(
	organizationId: string,
	googleLocationName: string,
	organizationLocationId?: string | null,
) {
	const selected = z
		.string()
		.regex(/^locations\/[A-Za-z0-9_-]+$/)
		.parse(googleLocationName)
	const scopedLocationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'google-business-profile',
		organizationLocationId,
	)
	if (!scopedLocationId) {
		throw new Error('A restaurant location is required.')
	}
	const { integration, token } = await getConnection(
		organizationId,
		scopedLocationId,
	)
	const url = new URL(
		`https://mybusinessbusinessinformation.googleapis.com/v1/${selected}`,
	)
	url.searchParams.set('readMask', READ_MASK)
	const location = await googleGet(url, token, locationSchema)
	let rawConfig: unknown = {}
	try {
		rawConfig = JSON.parse(integration.config ?? '{}')
	} catch {}
	const config = z.record(z.unknown()).catch({}).parse(rawConfig)

	const importedAddress = address(location)
	const importedSchedule = googleBusinessSchedule(location)
	const values = {
		name: location.title,
		phone: location.phoneNumbers?.primaryPhone ?? null,
		address: importedAddress ? JSON.stringify(importedAddress) : null,
		storeHours: importedSchedule ? JSON.stringify(importedSchedule) : null,
	}
	const menuzaLocationId = await db.transaction(async (tx) => {
		const locationId = scopedLocationId
		await tx
			.update(OrganizationLocation)
			.set(values)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
		await tx
			.update(IntegrationTable)
			.set({
				organizationLocationId: locationId,
				config: JSON.stringify({
					...config,
					googleLocationName: selected,
					menuzaLocationId: locationId,
					business: location,
				}),
				lastSyncAt: new Date(),
			})
			.where(eq(IntegrationTable.id, integration.id))
		return locationId
	})
	return { location, menuzaLocationId }
}
