import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { PageTitle } from '@repo/ui/page-title'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'

import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	createOrganizationLocation,
	ensureDefaultOrganizationLocation,
	listOrganizationLocations,
	locationInputSchema,
	updateOrganizationLocation,
} from '#app/utils/organization/locations.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

const LocationFormSchema = locationInputSchema.extend({
	intent: z.enum(['create', 'update']),
	locationId: z.string().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	await ensureDefaultOrganizationLocation({
		organizationId: organization.id,
		name: `${organization.name} — Main`,
	})

	const locations = await listOrganizationLocations(organization.id)

	return { organization, locations }
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
	const submission = parseWithZod(formData, { schema: LocationFormSchema })

	if (submission.status !== 'success') {
		return submission.reply()
	}

	const { intent, locationId, ...input } = submission.value

	if (intent === 'update' && locationId) {
		const updated = await updateOrganizationLocation(
			organization.id,
			locationId,
			input,
		)
		if (!updated) {
			return redirectWithToast(`/${organization.slug}/locations`, {
				type: 'error',
				title: 'Location not found',
			})
		}
		return redirectWithToast(`/${organization.slug}/locations`, {
			type: 'success',
			title: 'Location updated',
		})
	}

	await createOrganizationLocation(organization.id, input)
	return redirectWithToast(`/${organization.slug}/locations`, {
		type: 'success',
		title: 'Location added',
	})
}

export default function RestaurantLocationsPage() {
	const { locations } = useLoaderData<typeof loader>()

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 py-8 md:px-6 lg:px-8">
			<PageTitle
				title="Locations"
				description="Manage restaurant branches. Per-location billing is not enabled in this release."
			/>
			<div className="flex flex-col gap-8">
				<ul className="divide-y rounded-lg border">
					{locations.map((location) => (
						<li key={location.id} className="p-4">
							<div className="mb-3 flex items-center justify-between gap-2">
								<div>
									<p className="font-medium">
										{location.name}
										{location.isDefault ? (
											<span className="text-muted-foreground ms-2 text-xs">
												(Default)
											</span>
										) : null}
									</p>
									<p className="text-muted-foreground text-sm">
										{[
											location.addressLine1,
											location.city,
											location.state,
											location.postalCode,
										]
											.filter(Boolean)
											.join(', ') || 'No address yet'}
									</p>
								</div>
							</div>
							<Form method="post" className="grid gap-3 md:grid-cols-2">
								<input type="hidden" name="intent" value="update" />
								<input type="hidden" name="locationId" value={location.id} />
								<div className="space-y-1">
									<Label htmlFor={`name-${location.id}`}>Name</Label>
									<Input
										id={`name-${location.id}`}
										name="name"
										defaultValue={location.name}
										required
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor={`timezone-${location.id}`}>Timezone</Label>
									<Input
										id={`timezone-${location.id}`}
										name="timezone"
										defaultValue={location.timezone}
									/>
								</div>
								<div className="space-y-1 md:col-span-2">
									<Label htmlFor={`address-${location.id}`}>Address</Label>
									<Input
										id={`address-${location.id}`}
										name="addressLine1"
										defaultValue={location.addressLine1 ?? ''}
									/>
								</div>
								<div className="md:col-span-2">
									<Button type="submit" size="sm">
										Save location
									</Button>
								</div>
							</Form>
						</li>
					))}
				</ul>

				<Form
					method="post"
					className="grid max-w-xl gap-3 rounded-lg border p-4"
				>
					<input type="hidden" name="intent" value="create" />
					<p className="font-medium">Add location</p>
					<div className="space-y-1">
						<Label htmlFor="new-name">Name</Label>
						<Input id="new-name" name="name" required />
					</div>
					<div className="space-y-1">
						<Label htmlFor="new-address">Address</Label>
						<Input id="new-address" name="addressLine1" />
					</div>
					<Button type="submit">Add location</Button>
				</Form>
			</div>
		</div>
	)
}
