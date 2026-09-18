import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { emptyWeeklyHours } from '@repo/common/location-hours'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { ENV } from 'varlock/env'

import { getGoogleMapsClientMode } from '#app/utils/maps/google-maps-mode.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	createOrganizationLocation,
	locationAddressSchema,
	locationDetailsSchema,
	locationKitchenSchema,
} from '#app/utils/organization/locations.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

const CreateLocationSchema = locationDetailsSchema
	.merge(locationAddressSchema)
	.merge(locationKitchenSchema)
	.extend({
		active: z
			.string()
			.optional()
			.transform((value) => value === 'on'),
		isDefault: z
			.string()
			.optional()
			.transform((value) => value === 'on'),
	})

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserOrganization(request, params.orgSlug, { slug: true })
	return {
		googleMapsApiKey: ENV.PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null,
		googleMapsMode: getGoogleMapsClientMode(),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: CreateLocationSchema })

	if (submission.status !== 'success') {
		return submission.reply()
	}

	const { value } = submission
	try {
		const created = await createOrganizationLocation(organization.id, {
			...value,
			store: emptyWeeklyHours(),
			online: emptyWeeklyHours(),
			special: [],
			storeHoursOverride: false,
			onlineHoursOverride: false,
		})
		if (!created) throw new Error('Create failed')
		return redirectWithToast(`/${organization.slug}/locations/${created.id}`, {
			type: 'success',
			title: 'Location created',
			description: '',
		})
	} catch (error) {
		return redirectWithToast(`/${organization.slug}/locations/new`, {
			type: 'error',
			title:
				error instanceof Error ? error.message : 'Could not create location',
			description: '',
		})
	}
}

export { default } from './new-location-ui.tsx'
