import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import {
	type DeliveryProvider,
	type DeliveryZone,
	DEFAULT_DELIVERY_CONFIG,
	DEFAULT_DELIVERY_ZONE,
} from '@repo/common/location-types'
import { redirectWithToast } from '@repo/common/toast'
import { and, db, eq, ne, OrganizationLocation } from '@repo/database'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import {
	type InitialLocationData,
	LocationForm,
} from '#app/components/locations/location-form.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

const LocationInputSchema = z.object({
	name: z.string().min(1, 'Location name is required'),
	slug: z
		.string()
		.min(1, 'URL slug is required')
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			'Slug must contain only lowercase letters, numbers, and hyphens',
		),
	phone: z.string().optional(),
	timezone: z.string().default('America/New_York'),
	taxRate: z.coerce.number().min(0).default(0),
	isActive: z.preprocess((val) => val === 'true' || val === true, z.boolean()),
	isDefault: z.preprocess((val) => val === 'true' || val === true, z.boolean()),
	address: z.string().optional(),
	storeHours: z.string().optional(),
	onlineHours: z.string().optional(),
	specialHours: z.string().optional(),
	prepTime: z.coerce.number().min(0).default(15),
	largeOrderThreshold: z.coerce.number().min(0).default(100),
	largeOrderThresholdType: z.string().default('dollars'),
	largeOrderExtraPrepTime: z.coerce.number().min(0).default(15),
	fulfillmentOptions: z.string().optional(),
	inHouseTips: z.string().optional(),
	scheduling: z.string().optional(),
	deliveryConfig: z.string().optional(),
	deliveryZones: z.string().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)

	const locationId = params.locationId
	if (!locationId) {
		throw new Response('Location ID is required', { status: 400 })
	}

	const record = await db.query.OrganizationLocation.findFirst({
		where: and(
			eq(OrganizationLocation.organizationId, organization.id),
			eq(OrganizationLocation.id, locationId),
		),
	})

	if (!record) {
		throw new Response('Location not found', { status: 404 })
	}

	const parseJson = <T,>(str: string | null): T | null => {
		if (!str) return null
		try {
			return JSON.parse(str) as T
		} catch {
			return null
		}
	}

	const location: InitialLocationData = {
		id: record.id,
		name: record.name,
		slug: record.slug,
		phone: record.phone,
		timezone: record.timezone,
		taxRate: record.taxRate,
		isActive: record.isActive,
		isDefault: record.isDefault,
		prepTime: record.prepTime,
		largeOrderThreshold: record.largeOrderThreshold ?? 100,
		largeOrderThresholdType: record.largeOrderThresholdType,
		largeOrderExtraPrepTime: record.largeOrderExtraPrepTime,
		address: parseJson(record.address),
		storeHours: parseJson(record.storeHours),
		onlineHours: parseJson(record.onlineHours),
		specialHours: parseJson(record.specialHours),
		fulfillmentOptions: parseJson(record.fulfillmentOptions),
		inHouseTips: parseJson(record.inHouseTips),
		scheduling: parseJson(record.scheduling),
		deliveryConfig: (() => {
			const parsed = parseJson<Record<string, any>>(record.deliveryConfig)
			if (!parsed) return DEFAULT_DELIVERY_CONFIG
			return {
				providers:
					Array.isArray(parsed.providers) && parsed.providers.length > 0
						? (parsed.providers as DeliveryProvider[])
						: DEFAULT_DELIVERY_CONFIG.providers,
				estimatedDeliveryTimeMin:
					parsed.estimatedDeliveryTimeMin ??
					parsed.estimatedTimeMin ??
					DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMin,
				estimatedDeliveryTimeMax:
					parsed.estimatedDeliveryTimeMax ??
					parsed.estimatedTimeMax ??
					DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMax,
			}
		})(),
		deliveryZones: (() => {
			const parsed = parseJson<DeliveryZone[]>(record.deliveryZones)
			return Array.isArray(parsed) && parsed.length > 0
				? parsed
				: [DEFAULT_DELIVERY_ZONE]
		})(),
	}

	return {
		organization,
		location,
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

	const locationId = params.locationId
	if (!locationId) {
		return { error: 'Location ID is required' }
	}

	const formData = await request.formData()
	const rawData: Record<string, unknown> = {}
	for (const [key, value] of formData.entries()) {
		rawData[key] = value
	}

	const parsed = LocationInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return {
			error: parsed.error.issues[0]?.message ?? 'Invalid location details.',
		}
	}

	const data = parsed.data

	// Check if another location has this slug
	const [existingWithSlug] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.slug, data.slug),
				ne(OrganizationLocation.id, locationId),
			),
		)
		.limit(1)

	if (existingWithSlug) {
		return { error: 'Another location already uses this URL slug.' }
	}

	await db.transaction(async (tx) => {
		if (data.isDefault) {
			await tx
				.update(OrganizationLocation)
				.set({ isDefault: false })
				.where(eq(OrganizationLocation.organizationId, organization.id))
		}

		await tx
			.update(OrganizationLocation)
			.set({
				name: data.name,
				slug: data.slug,
				phone: data.phone || null,
				timezone: data.timezone,
				taxRate: data.taxRate,
				isActive: data.isActive,
				isDefault: data.isDefault,
				address: data.address || null,
				storeHours: data.storeHours || null,
				onlineHours: data.onlineHours || null,
				specialHours: data.specialHours || null,
				prepTime: data.prepTime,
				largeOrderThreshold: data.largeOrderThreshold,
				largeOrderThresholdType: data.largeOrderThresholdType,
				largeOrderExtraPrepTime: data.largeOrderExtraPrepTime,
				fulfillmentOptions: data.fulfillmentOptions || null,
				inHouseTips: data.inHouseTips || null,
				scheduling: data.scheduling || null,
				deliveryConfig: data.deliveryConfig || null,
				deliveryZones: data.deliveryZones || null,
			})
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
	})

	return redirectWithToast(`/${organization.slug}/settings/locations`, {
		type: 'success',
		title: 'Location updated',
		description: 'Restaurant location details have been saved.',
	})
}

export default function EditLocationRoute() {
	const { organization, location } = useLoaderData<typeof loader>()

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center gap-3">
				<Button
					variant="outline"
					size="icon"
					render={<Link to={`/${organization.slug}/settings/locations`} />}
				>
					<Icon name="arrow-left" className="size-4" />
					<span className="sr-only">
						<Trans>Back</Trans>
					</span>
				</Button>
				<div>
					<h2 className="text-xl tracking-tight">
						<Trans>Edit Location</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Update location details, hours, and fulfillment preferences.
						</Trans>
					</p>
				</div>
			</div>

			<LocationForm
				orgSlug={organization.slug}
				siteLocalesRaw={organization.siteLocales}
				siteDefaultLocaleRaw={organization.siteDefaultLocale}
				isEditing={true}
				initialData={location}
			/>
		</div>
	)
}
