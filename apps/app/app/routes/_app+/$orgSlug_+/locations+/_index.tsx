import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageTitle } from '@repo/ui/page-title'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { type LoaderFunctionArgs, Link, useLoaderData } from 'react-router'

import { LOCATION_READ_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import {
	ensureDefaultOrganizationLocation,
	listOrganizationLocations,
} from '#app/utils/organization/locations.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		LOCATION_READ_PERMISSION,
	)

	await ensureDefaultOrganizationLocation({
		organizationId: organization.id,
		name: `${organization.name} — Main`,
	})

	const locations = await listOrganizationLocations(organization.id)

	return { organization, locations }
}

export default function RestaurantLocationsListPage() {
	const { organization, locations } = useLoaderData<typeof loader>()

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<PageTitle
					title="Locations"
					description="Manage restaurant branches, hours, and kitchen settings."
				/>
				<Button render={<Link to={`/${organization.slug}/locations/new`} />}>
					<Icon name="plus" className="size-4" />
					<Trans>Add location</Trans>
				</Button>
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>
							<Trans>Name</Trans>
						</TableHead>
						<TableHead>
							<Trans>City / State</Trans>
						</TableHead>
						<TableHead>
							<Trans>Phone</Trans>
						</TableHead>
						<TableHead>
							<Trans>Prep</Trans>
						</TableHead>
						<TableHead>
							<Trans>Status</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Actions</Trans>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{locations.map((location) => (
						<TableRow key={location.id}>
							<TableCell className="font-medium">
								{location.name}
								{location.isDefault ? (
									<Badge variant="secondary" className="ms-2">
										<Trans>Default</Trans>
									</Badge>
								) : null}
							</TableCell>
							<TableCell>
								{[location.city, location.state].filter(Boolean).join(', ') ||
									'—'}
							</TableCell>
							<TableCell>{location.phone ?? '—'}</TableCell>
							<TableCell>
								{location.prepTimeMinutes}
								<span className="text-muted-foreground"> min</span>
							</TableCell>
							<TableCell>
								{location.active ? (
									<Badge>
										<Trans>Active</Trans>
									</Badge>
								) : (
									<Badge variant="outline">
										<Trans>Inactive</Trans>
									</Badge>
								)}
							</TableCell>
							<TableCell className="text-end">
								<Button
									variant="outline"
									size="sm"
									render={
										<Link
											to={`/${organization.slug}/locations/${location.id}`}
										/>
									}
								>
									<Trans>Edit</Trans>
								</Button>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
