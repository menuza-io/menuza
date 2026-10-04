import { getOrgSiteUrl } from '@repo/common/url'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { DROP_STATUS_LABELS, type DropStatus } from '@repo/common/menu-types'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	deleteDrop,
	listDropsForOrganization,
} from '#app/utils/menu/drops.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const DeleteDropSchema = z.object({
	intent: z.literal('delete-drop'),
	dropId: z.string().min(1),
})

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const formData = await request.formData()
	const result = DeleteDropSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await deleteDrop(organization.id, result.data.dropId)
	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return Response.json({ success: true })
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const drops = await listDropsForOrganization(organization.id)

	return {
		organization,
		drops: drops.map((d) => ({
			id: d.id,
			title: d.title,
			slug: d.slug,
			status: d.status as DropStatus,
			ordersOpenAt: d.ordersOpenAt ? d.ordersOpenAt.toISOString() : null,
			ordersCloseAt: d.ordersCloseAt ? d.ordersCloseAt.toISOString() : null,
			pickupWindowsCount: d.pickupWindows.length,
			firstPickupDate: d.pickupWindows[0]?.date || null,
			firstPickupLocation: d.pickupWindows[0]?.location?.name || null,
			createdAt: d.createdAt.toISOString(),
		})),
	}
}

export default function DropsIndexRoute() {
	const { organization, drops } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const [deleteDropId, setDeleteDropId] = useState<string | null>(null)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Drops</Trans>}
				description={
					<Trans>
						Schedule limited-time menu drops with inventory limits and pickup
						slots.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button render={<Link to={`/${organization.slug}/menu/drops/new`} />}>
						<Icon name="plus" className="size-4" />
						<Trans>Create drop</Trans>
					</Button>
				}
			/>

			{drops.length === 0 ? (
				<EmptyState
					title={_(t`No drops scheduled yet`)}
					description={_(
						t`Create your first limited-time drop to sell out fast, build anticipation, and manage pickup windows.`,
					)}
					icons={['calendar', 'clock', 'sparkles']}
				/>
			) : (
				<div className="bg-card rounded-lg border shadow-sm">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Drop</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead>
									<Trans>Pickup Window</Trans>
								</TableHead>
								<TableHead>
									<Trans>Orders Schedule</Trans>
								</TableHead>
								<TableHead className="w-16 text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{drops.map((drop) => (
								<TableRow key={drop.id}>
									<TableCell>
										<div className="space-y-0.5">
											<Link
												to={`/${organization.slug}/menu/drops/${drop.id}`}
												className="text-foreground font-medium hover:underline"
											>
												{drop.title}
											</Link>
											<p className="text-muted-foreground text-xs">
												/drop/{drop.slug}
											</p>
										</div>
									</TableCell>
									<TableCell>
										<Badge
											variant={
												drop.status === 'live'
													? 'default'
													: drop.status === 'scheduled'
														? 'secondary'
														: 'outline'
											}
											className="capitalize"
										>
											{DROP_STATUS_LABELS[drop.status]}
										</Badge>
									</TableCell>
									<TableCell>
										{drop.firstPickupDate ? (
											<div className="text-sm">
												<p className="font-medium">{drop.firstPickupDate}</p>
												{drop.firstPickupLocation && (
													<p className="text-muted-foreground text-xs">
														{drop.firstPickupLocation}
													</p>
												)}
											</div>
										) : (
											<span className="text-muted-foreground text-xs italic">
												<Trans>No windows</Trans>
											</span>
										)}
									</TableCell>
									<TableCell>
										<div className="text-muted-foreground space-y-0.5 text-xs">
											{drop.ordersOpenAt && (
												<p>
													<Trans>Opens:</Trans>{' '}
													{new Date(drop.ordersOpenAt).toLocaleDateString()}
												</p>
											)}
											{drop.ordersCloseAt && (
												<p>
													<Trans>Closes:</Trans>{' '}
													{new Date(drop.ordersCloseAt).toLocaleDateString()}
												</p>
											)}
										</div>
									</TableCell>
									<TableCell className="text-right">
										<DropdownMenu>
											<DropdownMenuTrigger
												render={<Button variant="ghost" size="icon-sm" />}
											>
												<Icon name="more-horizontal" className="size-4" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													render={
														<Link
															to={`/${organization.slug}/menu/drops/${drop.id}`}
														/>
													}
												>
													<Icon name="pencil" className="size-3.5" />
													<Trans>Edit</Trans>
												</DropdownMenuItem>
												<DropdownMenuItem
													render={
														<a
															href={`${getOrgSiteUrl(organization.slug)}/drop/${drop.slug}`}
															target="_blank"
															rel="noreferrer"
														/>
													}
												>
													<Icon name="external-link" className="size-3.5" />
													<Trans>View storefront</Trans>
												</DropdownMenuItem>
												<DropdownMenuItem
													className="text-destructive focus:text-destructive"
													onClick={() => setDeleteDropId(drop.id)}
												>
													<Icon name="trash-2" className="size-3.5" />
													<Trans>Delete</Trans>
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			{/* Delete Confirmation Alert */}
			<AlertDialog
				open={!!deleteDropId}
				onOpenChange={(open) => !open && setDeleteDropId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete drop?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete this drop and remove its pickup
								schedule and inventory limits. This action cannot be undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (deleteDropId) {
									deleteFetcher.submit(
										{ intent: 'delete-drop', dropId: deleteDropId },
										{ method: 'post' },
									)
									setDeleteDropId(null)
								}
							}}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
