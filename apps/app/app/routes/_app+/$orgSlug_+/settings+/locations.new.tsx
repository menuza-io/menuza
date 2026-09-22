import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { and, count, db, eq, OrganizationLocation } from '@repo/database'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { LocationForm } from '#app/components/locations/location-form.tsx'
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
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const [countResult] = await db
		.select({ total: count() })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))

	const isFirstLocation = (countResult?.total ?? 0) === 0

	return {
		organization,
		isFirstLocation,
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

	// Check unique slug within organization
	const [existing] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.slug, data.slug),
			),
		)
		.limit(1)

	if (existing) {
		return { error: 'A location with this URL slug already exists.' }
	}

	await db.transaction(async (tx) => {
		if (data.isDefault) {
			await tx
				.update(OrganizationLocation)
				.set({ isDefault: false })
				.where(eq(OrganizationLocation.organizationId, organization.id))
		}

		await tx.insert(OrganizationLocation).values({
			organizationId: organization.id,
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
	})

	return redirectWithToast(`/${organization.slug}/settings/locations`, {
		type: 'success',
		title: 'Location created',
		description: 'New restaurant location has been configured successfully.',
	})
}

export default function NewLocationRoute() {
	const { organization, isFirstLocation } = useLoaderData<typeof loader>()

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
						<Trans>Add Location</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Configure your new restaurant location details, operating hours,
							and delivery settings.
						</Trans>
					</p>
				</div>
			</div>

			<LocationForm
				orgSlug={organization.slug}
				siteLocalesRaw={organization.siteLocales}
				siteDefaultLocaleRaw={organization.siteDefaultLocale}
				isEditing={false}
				initialData={{
					name: '',
					slug: '',
					isDefault: isFirstLocation,
					isActive: true,
				}}
			/>
		</div>
	)
}
