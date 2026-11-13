import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Frame } from '@repo/ui/frame'
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
	Form,
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
	useParams,
} from 'react-router'
import { requireMenuHistoryAccess } from '#app/utils/menu/menu-feature-access.server.ts'
import { diffMenuSnapshots } from '#app/utils/menu/snapshot-diff.ts'
import {
	captureMenuSnapshotContent,
	loadMenuSnapshotContent,
} from '#app/utils/menu/snapshot.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuHistoryAccess(request, organization.id)
	const snapshotId = params.snapshotId
	if (!snapshotId) throw new Response('Not Found', { status: 404 })

	const compareTo = new URL(request.url).searchParams.get('compare') ?? 'now'
	const left = await loadMenuSnapshotContent(snapshotId, organization.id)
	const rightContent =
		compareTo === 'now'
			? await captureMenuSnapshotContent(organization.id)
			: (await loadMenuSnapshotContent(compareTo, organization.id)).content

	const diff = diffMenuSnapshots(left.content, rightContent)

	return {
		meta: left.meta,
		diff,
		compareTo,
	}
}

export default function MenuSnapshotComparePage() {
	const { _ } = useLingui()
	const { diff, meta, compareTo } = useLoaderData<typeof loader>()
	const params = useParams()
	const orgSlug = params.orgSlug!
	const [removeAdded, setRemoveAdded] = useState(false)

	return (
		<Frame>
			<PageHeader
				title={_(t`Compare`)}
				description={_(
					t`Snapshot {id} compared to {target}`,
					{ id: meta.id, target: compareTo === 'now' ? _(t`now`) : compareTo },
				)}
				actions={
					<Button variant="outline" render={<Link to={`/${orgSlug}/menu/history`} />}>
						<Trans>Back to History</Trans>
					</Button>
				}
			/>

			<Form method="post" action={`/${orgSlug}/menu/history`} className="mb-6 space-y-3">
				<input type="hidden" name="intent" value="restore" />
				<input type="hidden" name="snapshotId" value={meta.id} />
				<input
					type="hidden"
					name="removeAdded"
					value={removeAdded ? 'true' : 'false'}
				/>
				<label className="flex items-center gap-2 text-sm">
					<Checkbox
						checked={removeAdded}
						onCheckedChange={(value) => setRemoveAdded(value === true)}
					/>
					<Trans>Remove things added since this snapshot</Trans>
				</label>
				<Button type="submit" variant="destructive">
					<Trans>Restore this snapshot</Trans>
				</Button>
			</Form>

			{(['added', 'removed', 'changed'] as const).map((section) => {
				const rows = diff[section]
				if (rows.length === 0) return null
				const title =
					section === 'added'
						? _(t`Added`)
						: section === 'removed'
							? _(t`Removed`)
							: _(t`Changed`)
				return (
					<div key={section} className="mb-8">
						<h3 className="font-heading mb-2 text-lg">{title}</h3>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Kind</Trans>
									</TableHead>
									<TableHead>
										<Trans>Name</Trans>
									</TableHead>
									<TableHead>
										<Trans>Details</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={`${section}-${row.kind}-${row.id}`}>
										<TableCell>{row.kind}</TableCell>
										<TableCell>{row.name}</TableCell>
										<TableCell>
											{row.changes.length === 0 ? (
												'—'
											) : (
												<ul className="list-inside list-disc text-sm">
													{row.changes.map((change) => (
														<li key={change.field}>
															{change.field}: {String(change.before)} →{' '}
															{String(change.after)}
														</li>
													))}
												</ul>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)
			})}
		</Frame>
	)
}
