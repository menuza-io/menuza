import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { locationHoursBundleSchema } from '@repo/common/location-hours'
import { redirectWithToast } from '@repo/common/toast'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { z } from 'zod'

import { getGoogleMapsClientMode } from '#app/utils/maps/google-maps-mode.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	getOrganizationBrandHours,
	getOrganizationLocation,
	locationAddressSchema,
	locationDetailsSchema,
	locationKitchenSchema,
	locationHoursFromRow,
	updateOrganizationLocation,
} from '#app/utils/organization/locations.server.ts'
import {
	LOCATION_READ_PERMISSION,
	LOCATION_WRITE_PERMISSION,
} from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		LOCATION_READ_PERMISSION,
	)
	const locationId = params.locationId
	if (!locationId) throw new Response('Not Found', { status: 404 })

	const location = await getOrganizationLocation(organization.id, locationId)
	if (!location) throw new Response('Not Found', { status: 404 })

	const brandHours = await getOrganizationBrandHours(organization.id)
	const resolvedHours = locationHoursFromRow(location, {
		store: brandHours?.brandStoreHoursJson,
		online: brandHours?.brandOnlineHoursJson,
	})

	return {
		organization,
		location,
		resolvedHours,
		googleMapsApiKey: ENV.PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null,
		googleMapsMode: getGoogleMapsClientMode(),
	}
}

const DetailsActionSchema = locationDetailsSchema
	.merge(locationAddressSchema)
	.extend({
		intent: z.literal('details'),
		active: z
			.string()
			.optional()
			.transform((value) => value === 'on'),
		isDefault: z
			.string()
			.optional()
			.transform((value) => value === 'on'),
	})

const HoursActionSchema = z.object({
	intent: z.literal('hours'),
	hoursPayload: z.string(),
	storeHoursOverride: z
		.string()
		.optional()
		.transform((value) => value === 'on'),
	onlineHoursOverride: z
		.string()
		.optional()
		.transform((value) => value === 'on'),
})

const KitchenActionSchema = locationKitchenSchema.extend({
	intent: z.literal('kitchen'),
	pickupEnabled: z
		.string()
		.optional()
		.transform((value) => value !== 'off'),
	scheduledOrdersEnabled: z
		.string()
		.optional()
		.transform((value) => value !== 'off'),
})

const ActionSchema = z.discriminatedUnion('intent', [
	DetailsActionSchema,
	HoursActionSchema,
	KitchenActionSchema,
])

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const locationId = params.locationId
	if (!locationId) throw new Response('Not Found', { status: 404 })

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		LOCATION_WRITE_PERMISSION,
	)

	const existing = await getOrganizationLocation(organization.id, locationId)
	if (!existing) {
		return redirectWithToast(`/${organization.slug}/locations`, {
			type: 'error',
			title: 'Location not found',
			description: '',
		})
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: ActionSchema })
	if (submission.status !== 'success') {
		return submission.reply()
	}

	const { value } = submission

	try {
		if (value.intent === 'details') {
			await updateOrganizationLocation(organization.id, locationId, {
				...value,
				prepTimeMinutes: existing.prepTimeMinutes,
				pickupEnabled: existing.pickupEnabled,
				scheduledOrdersEnabled: existing.scheduledOrdersEnabled,
				busyDelayMinutes: existing.busyDelayMinutes,
				acceptWindowSeconds: existing.acceptWindowSeconds,
			})
		} else if (value.intent === 'hours') {
			const bundle = locationHoursBundleSchema.parse(
				JSON.parse(value.hoursPayload),
			)
			await updateOrganizationLocation(organization.id, locationId, {
				name: existing.name,
				phone: existing.phone ?? '',
				email: existing.email,
				timezone: existing.timezone,
				active: existing.active,
				isDefault: existing.isDefault,
				addressLine1: existing.addressLine1 ?? '',
				addressLine2: existing.addressLine2,
				city: existing.city ?? '',
				state: existing.state ?? '',
				postalCode: existing.postalCode ?? '',
				country: existing.country ?? 'US',
				formattedAddress: existing.formattedAddress,
				googlePlaceId: existing.googlePlaceId,
				latitude: existing.latitude,
				longitude: existing.longitude,
				prepTimeMinutes: existing.prepTimeMinutes,
				pickupEnabled: existing.pickupEnabled,
				scheduledOrdersEnabled: existing.scheduledOrdersEnabled,
				busyDelayMinutes: existing.busyDelayMinutes,
				acceptWindowSeconds: existing.acceptWindowSeconds,
				store: bundle.store,
				online: bundle.online,
				special: bundle.special ?? [],
				storeHoursOverride: value.storeHoursOverride,
				onlineHoursOverride: value.onlineHoursOverride,
			})
		} else {
			const { intent: ignoredIntent, ...kitchen } = value
			await updateOrganizationLocation(organization.id, locationId, {
				name: existing.name,
				phone: existing.phone ?? '',
				email: existing.email,
				timezone: existing.timezone,
				active: existing.active,
				isDefault: existing.isDefault,
				addressLine1: existing.addressLine1 ?? '',
				addressLine2: existing.addressLine2,
				city: existing.city ?? '',
				state: existing.state ?? '',
				postalCode: existing.postalCode ?? '',
				country: existing.country ?? 'US',
				formattedAddress: existing.formattedAddress,
				googlePlaceId: existing.googlePlaceId,
				latitude: existing.latitude,
				longitude: existing.longitude,
				...kitchen,
			})
		}

		return redirectWithToast(
			`/${organization.slug}/locations/${locationId}?tab=${value.intent}`,
			{
				type: 'success',
				title: 'Location saved',
				description: '',
			},
		)
	} catch (error) {
		return redirectWithToast(`/${organization.slug}/locations/${locationId}`, {
			type: 'error',
			title: error instanceof Error ? error.message : 'Could not save location',
			description: '',
		})
	}
}

export { default } from './location-edit-ui.tsx'
