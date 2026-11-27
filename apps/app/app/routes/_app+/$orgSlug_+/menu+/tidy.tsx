import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import {
	db,
	and,
	eq,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
} from '@repo/database'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	Link,
	useLoaderData,
} from 'react-router'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { deleteMenuEntityReferences } from '#app/utils/menu/cleanup.server.ts'
import { createMenuSnapshot } from '#app/utils/menu/snapshot.server.ts'
import {
	deleteExclusiveModifiers,
	loadTidyRecords,
} from '#app/utils/menu/unused-records.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuRead(request, organization.id)
	const { records, csv } = await loadTidyRecords(organization.id)
	return { organization, records, csv }
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const userId = await requireMenuWrite(request, organization.id)
	const form = await request.formData()
	const ids = form
		.getAll('id')
		.filter((value): value is string => typeof value === 'string')
	const { records } = await loadTidyRecords(organization.id)
	const allowed = new Map(records.map((row) => [row.id, row]))
	const chosen = ids
		.map((id) => allowed.get(id))
		.filter((row): row is NonNullable<typeof row> =>
			Boolean(row && row.deletable),
		)
	if (chosen.length === 0) return { ok: true, deleted: 0 }
	await createMenuSnapshot({
		organizationId: organization.id,
		reason: 'before_bulk_edit',
		userId,
		label: 'Before tidy up',
	})
	const itemIds = chosen
		.filter((row) => row.entityType === 'item')
		.map((row) => row.id)
	await deleteExclusiveModifiers({
		organizationId: organization.id,
		userId,
		removedItemIds: itemIds,
	})
	await db.transaction(async (tx) => {
		for (const row of chosen) {
			if (row.entityType === 'item') {
				await tx
					.delete(OrganizationMenuItem)
					.where(
						and(
							eq(OrganizationMenuItem.id, row.id),
							eq(OrganizationMenuItem.organizationId, organization.id),
						),
					)
			} else if (row.entityType === 'modifier_group') {
				await tx
					.delete(OrganizationMenuModifierGroup)
					.where(
						and(
							eq(OrganizationMenuModifierGroup.id, row.id),
							eq(OrganizationMenuModifierGroup.organizationId, organization.id),
						),
					)
			} else {
				await tx
					.delete(OrganizationMenuOption)
					.where(
						and(
							eq(OrganizationMenuOption.id, row.id),
							eq(OrganizationMenuOption.organizationId, organization.id),
						),
					)
			}
			await deleteMenuEntityReferences(
				organization.id,
				row.entityType,
				row.id,
				tx,
			)
		}
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	return { ok: true, deleted: chosen.length }
}

export default function TidyUpRoute() {
	const { organization, records, csv } = useLoaderData<typeof loader>()
	const [selected, setSelected] = useState<string[]>([])
	const deletable = records.filter((row) => row.deletable).map((row) => row.id)
	const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-lg font-semibold">
					<Trans>Tidy up</Trans>
				</h2>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						render={
							<a href={csvHref} download={`${organization.slug}-unused.csv`} />
						}
					>
						<Trans>Download CSV</Trans>
					</Button>
					<Button
						variant="outline"
						render={
							<Link to={`/${organization.slug}/menu/export`} reloadDocument />
						}
					>
						<Trans>Export</Trans>
					</Button>
				</div>
			</div>
			<p className="text-muted-foreground text-sm">
				<Trans>This isn't used anywhere.</Trans>
			</p>
			<Form method="post" encType="multipart/form-data" className="space-y-2">
				<label className="flex items-center gap-2 text-sm">
					<Checkbox
						checked={
							selected.length > 0 && selected.length === deletable.length
						}
						onCheckedChange={(checked) => setSelected(checked ? deletable : [])}
					/>
					<Trans>Select all</Trans>
				</label>
				<ul className="divide-y">
					{records.map((row) => (
						<li key={row.id} className="flex items-center gap-3 py-2 text-sm">
							{row.deletable ? (
								<input
									type="hidden"
									name="id"
									value={row.id}
									disabled={!selected.includes(row.id)}
								/>
							) : null}
							<Checkbox
								checked={selected.includes(row.id)}
								disabled={!row.deletable}
								onCheckedChange={(checked) =>
									setSelected((current) =>
										checked
											? [...current, row.id]
											: current.filter((id) => id !== row.id),
									)
								}
							/>
							<span className="min-w-0 flex-1">{row.name}</span>
							<span className="text-muted-foreground">
								{row.updatedAt.slice(0, 10)}
							</span>
							{row.posLinked ? (
								<span>
									<Trans>Linked to a POS</Trans>
								</span>
							) : null}
						</li>
					))}
				</ul>
				<Button
					type="submit"
					variant="destructive"
					disabled={selected.length === 0}
				>
					<Trans>Delete selected</Trans>
				</Button>
			</Form>
			<Form
				method="post"
				encType="multipart/form-data"
				action={`/${organization.slug}/menu/import-file`}
				className="space-y-2"
			>
				<h3 className="text-sm font-medium">
					<Trans>From Menuza file</Trans>
				</h3>
				<input type="file" name="file" accept="application/json" required />
				<Button type="submit">
					<Trans>Import</Trans>
				</Button>
			</Form>
		</div>
	)
}
