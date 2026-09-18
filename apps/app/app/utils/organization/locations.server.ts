import { GOOGLE_MAPS_MOCK_PLACE } from '@repo/common/google-maps-mock'
import {
	emptyLocationHoursBundle,
	emptyWeeklyHours,
	locationHoursBundleSchema,
	parseLocationHoursJson,
	serializeLocationHoursBundle,
	validateLocationHoursBundle,
	weeklyHoursSchema,
	type LocationHoursBundle,
} from '@repo/common/location-hours'
import {
	and,
	db,
	eq,
	Organization,
	OrganizationLocation,
	sql,
} from '@repo/database'
import { createId } from '@paralleldrive/cuid2'
import slugify from '@sindresorhus/slugify'
import { z } from 'zod'

import { geocodeAddress } from '#app/utils/maps/geocode.server.ts'

const usPostalCode = z
	.string()
	.trim()
	.regex(/^\d{5}(-\d{4})?$/, 'Enter a valid US ZIP code')

const coordinatesSchema = z.object({
	latitude: z.coerce.number().min(-90).max(90),
	longitude: z.coerce.number().min(-180).max(180),
})

export const locationAddressSchema = z.object({
	addressLine1: z.string().trim().min(1, 'Street address is required').max(200),
	addressLine2: z.string().trim().max(200).optional().nullable(),
	city: z.string().trim().min(1, 'City is required').max(100),
	state: z.string().trim().min(1, 'State is required').max(50),
	postalCode: usPostalCode,
	country: z.string().trim().length(2).default('US'),
	formattedAddress: z.string().trim().max(500).optional().nullable(),
	googlePlaceId: z.string().trim().max(255).optional().nullable(),
	latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
	longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
})

export const locationDetailsSchema = z.object({
	name: z.string().trim().min(1, 'Location name is required').max(120),
	slug: z
		.string()
		.trim()
		.max(80)
		.optional()
		.transform((value) => (value ? slugify(value, { lowercase: true }) : null)),
	phone: z.string().trim().min(7, 'Location phone is required').max(30),
	email: z
		.string()
		.trim()
		.email('Enter a valid email')
		.optional()
		.or(z.literal(''))
		.transform((value) => (value ? value : null)),
	timezone: z.string().trim().min(1).max(80),
	active: z.boolean().optional().default(true),
	isDefault: z.boolean().optional().default(false),
})

export const locationKitchenSchema = z.object({
	prepTimeMinutes: z.coerce.number().int().min(1).max(180),
	busyDelayMinutes: z.coerce
		.number()
		.int()
		.min(0)
		.max(120)
		.optional()
		.default(0),
	acceptWindowSeconds: z.coerce
		.number()
		.int()
		.min(0)
		.max(600)
		.optional()
		.default(0),
	pickupEnabled: z.boolean().optional().default(true),
	scheduledOrdersEnabled: z.boolean().optional().default(true),
})

export const locationHoursFormSchema = z.object({
	storeHoursOverride: z.boolean().optional().default(false),
	onlineHoursOverride: z.boolean().optional().default(false),
	store: weeklyHoursSchema,
	online: weeklyHoursSchema,
	special: z.array(z.any()).optional().default([]),
})

export type OrganizationLocationRow = typeof OrganizationLocation.$inferSelect

export function assertLocationHasCoordinates(
	location: Pick<
		OrganizationLocationRow,
		'latitude' | 'longitude' | 'active' | 'deliveryEnabled'
	>,
): void {
	if (!location.active) return
	if (location.latitude == null || location.longitude == null) {
		throw new Error(
			'Active locations require a verified map pin (latitude and longitude).',
		)
	}
	const coords = coordinatesSchema.safeParse({
		latitude: location.latitude,
		longitude: location.longitude,
	})
	if (!coords.success) {
		throw new Error(
			'Active locations require a verified map pin (latitude and longitude).',
		)
	}
}

export async function resolveLocationCoordinates<
	T extends z.infer<typeof locationAddressSchema>,
>(input: T): Promise<T & { latitude: number; longitude: number }> {
	if (input.latitude != null && input.longitude != null) {
		return {
			...input,
			latitude: input.latitude,
			longitude: input.longitude,
		}
	}
	const geocoded = await geocodeAddress(input)
	if (!geocoded) {
		throw new Error(
			'Could not verify this address. Add a map pin or check your address fields.',
		)
	}
	return {
		...input,
		latitude: geocoded.latitude,
		longitude: geocoded.longitude,
		formattedAddress:
			input.formattedAddress ?? geocoded.formattedAddress ?? null,
		googlePlaceId: input.googlePlaceId ?? geocoded.googlePlaceId ?? null,
	}
}

export async function listOrganizationLocations(organizationId: string) {
	return db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(
			sql`CASE WHEN ${OrganizationLocation.isDefault} THEN 0 ELSE 1 END`,
			OrganizationLocation.name,
		)
}

export async function getDefaultOrganizationLocationId(
	organizationId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isDefault, true),
				eq(OrganizationLocation.active, true),
			),
		)
		.limit(1)
	return row?.id ?? null
}

export async function ensureDefaultOrganizationLocation(options: {
	organizationId: string
	name?: string
}) {
	const [existingDefault] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, options.organizationId),
				eq(OrganizationLocation.isDefault, true),
			),
		)
		.limit(1)
	if (existingDefault) return existingDefault.id

	const [anyLocation] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, options.organizationId))
		.limit(1)
	if (anyLocation) return anyLocation.id

	const [created] = await db
		.insert(OrganizationLocation)
		.values({
			id: createId(),
			organizationId: options.organizationId,
			name: options.name?.trim() || 'Main location',
			isDefault: true,
			active: false,
			phone: '+17135550100',
			deliveryEnabled: true,
			pickupEnabled: true,
			prepTimeMinutes: 15,
		})
		.returning({ id: OrganizationLocation.id })

	if (!created) {
		throw new Error('Failed to create default restaurant location')
	}

	return created.id
}

/**
 * Ensures a default branch exists and meets publish gates (active, phone, map pin).
 * Upgrades legacy auto-created inactive stubs from root loader / org create.
 */
export async function ensurePublishReadyDefaultLocation(options: {
	organizationId: string
	name?: string
}): Promise<string> {
	const locationId = await ensureDefaultOrganizationLocation(options)
	const location = await getOrganizationLocation(
		options.organizationId,
		locationId,
	)
	if (!location) {
		throw new Error('Default location not found.')
	}

	const needsBootstrap =
		!location.active ||
		location.latitude == null ||
		location.longitude == null ||
		!location.phone?.trim()

	if (!needsBootstrap) {
		return locationId
	}

	await db
		.update(OrganizationLocation)
		.set({
			active: true,
			phone: location.phone?.trim() || '+17135550100',
			addressLine1:
				location.addressLine1 ?? GOOGLE_MAPS_MOCK_PLACE.addressLine1,
			city: location.city ?? GOOGLE_MAPS_MOCK_PLACE.city,
			state: location.state ?? GOOGLE_MAPS_MOCK_PLACE.state,
			postalCode: location.postalCode ?? GOOGLE_MAPS_MOCK_PLACE.postalCode,
			country: location.country ?? GOOGLE_MAPS_MOCK_PLACE.country,
			formattedAddress:
				location.formattedAddress ?? GOOGLE_MAPS_MOCK_PLACE.formattedAddress,
			googlePlaceId:
				location.googlePlaceId ?? GOOGLE_MAPS_MOCK_PLACE.googlePlaceId,
			latitude: location.latitude ?? GOOGLE_MAPS_MOCK_PLACE.latitude,
			longitude: location.longitude ?? GOOGLE_MAPS_MOCK_PLACE.longitude,
		})
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, options.organizationId),
			),
		)

	return locationId
}

async function clearOtherDefaultLocations(
	organizationId: string,
	exceptId: string,
) {
	await db
		.update(OrganizationLocation)
		.set({ isDefault: false })
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				sql`${OrganizationLocation.id} != ${exceptId}`,
			),
		)
}

function mergeLocationHoursForStorage(
	input: z.infer<typeof locationHoursFormSchema>,
): {
	storeHoursJson: string
	onlineHoursJson: string
	specialHoursJson: string
} {
	const bundle: LocationHoursBundle = {
		store: input.store,
		online: input.online,
		special: input.special as LocationHoursBundle['special'],
	}
	const hoursError = validateLocationHoursBundle(bundle)
	if (hoursError) throw new Error(hoursError)

	return {
		storeHoursJson: JSON.stringify(input.store),
		onlineHoursJson: JSON.stringify(input.online),
		specialHoursJson: JSON.stringify(input.special ?? []),
	}
}

export async function createOrganizationLocation(
	organizationId: string,
	input: z.infer<typeof locationDetailsSchema> &
		z.infer<typeof locationAddressSchema> &
		z.infer<typeof locationKitchenSchema> &
		z.infer<typeof locationHoursFormSchema>,
) {
	const details = locationDetailsSchema.parse(input)
	const kitchen = locationKitchenSchema.parse(input)
	const hours = locationHoursFormSchema.parse(input)
	const withCoords = await resolveLocationCoordinates(
		locationAddressSchema.parse(input),
	)

	const slug =
		details.slug ??
		(slugify(details.name, { lowercase: true }).slice(0, 80) || 'location')

	const hoursColumns = mergeLocationHoursForStorage(hours)

	const row = {
		...details,
		...withCoords,
		...kitchen,
		...hoursColumns,
		slug,
		deliveryEnabled: true,
		storeHoursOverride: hours.storeHoursOverride,
		onlineHoursOverride: hours.onlineHoursOverride,
	}

	assertLocationHasCoordinates({
		...row,
		latitude: row.latitude,
		longitude: row.longitude,
	})

	const [created] = await db
		.insert(OrganizationLocation)
		.values({
			id: createId(),
			organizationId,
			...row,
			isDefault: details.isDefault ?? false,
		})
		.returning()

	if (created?.isDefault) {
		await clearOtherDefaultLocations(organizationId, created.id)
	}

	return created
}

export async function updateOrganizationLocation(
	organizationId: string,
	locationId: string,
	input: Partial<z.infer<typeof locationDetailsSchema>> &
		Partial<z.infer<typeof locationAddressSchema>> &
		Partial<z.infer<typeof locationKitchenSchema>> &
		Partial<z.infer<typeof locationHoursFormSchema>>,
) {
	const existingRow = await getOrganizationLocation(organizationId, locationId)
	if (!existingRow) return null

	const details = locationDetailsSchema.parse({
		name: input.name ?? existingRow.name,
		slug: input.slug ?? existingRow.slug,
		phone: input.phone ?? existingRow.phone ?? '',
		email: input.email ?? existingRow.email,
		timezone: input.timezone ?? existingRow.timezone,
		active: input.active ?? existingRow.active,
		isDefault: input.isDefault ?? existingRow.isDefault,
	})
	const kitchen = locationKitchenSchema.parse({
		prepTimeMinutes: input.prepTimeMinutes ?? existingRow.prepTimeMinutes,
		busyDelayMinutes: input.busyDelayMinutes ?? existingRow.busyDelayMinutes,
		acceptWindowSeconds:
			input.acceptWindowSeconds ?? existingRow.acceptWindowSeconds,
		pickupEnabled: input.pickupEnabled ?? existingRow.pickupEnabled,
		scheduledOrdersEnabled:
			input.scheduledOrdersEnabled ?? existingRow.scheduledOrdersEnabled,
	})
	const withCoords = await resolveLocationCoordinates(
		locationAddressSchema.parse({
			addressLine1: input.addressLine1 ?? existingRow.addressLine1 ?? '',
			addressLine2: input.addressLine2 ?? existingRow.addressLine2,
			city: input.city ?? existingRow.city ?? '',
			state: input.state ?? existingRow.state ?? '',
			postalCode: input.postalCode ?? existingRow.postalCode ?? '',
			country: input.country ?? existingRow.country ?? 'US',
			formattedAddress: input.formattedAddress ?? existingRow.formattedAddress,
			googlePlaceId: input.googlePlaceId ?? existingRow.googlePlaceId,
			latitude: input.latitude ?? existingRow.latitude,
			longitude: input.longitude ?? existingRow.longitude,
		}),
	)
	const updatePayload: Record<string, unknown> = {
		...details,
		...withCoords,
		...kitchen,
		deliveryEnabled: true,
	}

	if (input.store && input.online) {
		const hours = locationHoursFormSchema.parse(input)
		Object.assign(updatePayload, mergeLocationHoursForStorage(hours), {
			storeHoursOverride: hours.storeHoursOverride,
			onlineHoursOverride: hours.onlineHoursOverride,
		})
	}

	assertLocationHasCoordinates({
		active: details.active ?? true,
		deliveryEnabled: true,
		latitude: withCoords.latitude,
		longitude: withCoords.longitude,
	})

	const [updated] = await db
		.update(OrganizationLocation)
		.set(updatePayload)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.returning()

	if (updated?.isDefault) {
		await clearOtherDefaultLocations(organizationId, updated.id)
	} else if (details.isDefault) {
		await db
			.update(OrganizationLocation)
			.set({ isDefault: true })
			.where(eq(OrganizationLocation.id, locationId))
		await clearOtherDefaultLocations(organizationId, locationId)
	}

	return updated ?? null
}

export async function getOrganizationLocation(
	organizationId: string,
	locationId: string,
) {
	const [row] = await db
		.select()
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	return row ?? null
}

export function locationHoursFromRow(
	row: OrganizationLocationRow,
	brandDefaults?: { store?: string | null; online?: string | null },
): LocationHoursBundle {
	const storeFromRow = row.storeHoursJson
		? weeklyHoursSchema.parse(JSON.parse(row.storeHoursJson))
		: emptyWeeklyHours()
	const onlineFromRow = row.onlineHoursJson
		? weeklyHoursSchema.parse(JSON.parse(row.onlineHoursJson))
		: emptyWeeklyHours()

	const brandStore = brandDefaults?.store
		? weeklyHoursSchema.parse(JSON.parse(brandDefaults.store))
		: emptyWeeklyHours()
	const brandOnline = brandDefaults?.online
		? weeklyHoursSchema.parse(JSON.parse(brandDefaults.online))
		: emptyWeeklyHours()

	const special = row.specialHoursJson
		? (JSON.parse(row.specialHoursJson) as LocationHoursBundle['special'])
		: []

	return {
		store: row.storeHoursOverride ? storeFromRow : brandStore,
		online: row.onlineHoursOverride ? onlineFromRow : brandOnline,
		special: special ?? [],
	}
}

export async function getOrganizationBrandHours(organizationId: string) {
	const [org] = await db
		.select({
			brandStoreHoursJson: Organization.brandStoreHoursJson,
			brandOnlineHoursJson: Organization.brandOnlineHoursJson,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org ?? null
}

export async function validateOrganizationCanPublish(
	organizationId: string,
): Promise<string | null> {
	const defaultId = await getDefaultOrganizationLocationId(organizationId)
	if (!defaultId) {
		return 'Add an active default restaurant location before publishing.'
	}
	const location = await getOrganizationLocation(organizationId, defaultId)
	if (!location) return 'Default location not found.'
	try {
		assertLocationHasCoordinates(location)
	} catch (error) {
		return error instanceof Error ? error.message : 'Location needs a map pin.'
	}
	if (!location.phone?.trim()) {
		return 'Default location needs a phone number before publishing.'
	}
	return null
}

export {
	emptyLocationHoursBundle,
	parseLocationHoursJson,
	serializeLocationHoursBundle,
}
