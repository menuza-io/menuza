/**
 * Website, Activity (#85): who published, unpublished, restored, discarded,
 * deleted, scheduled or redirected something on the website, and when. Read
 * with `read:website:any`. The entries are the organization's `AuditLog`
 * lines for website actions (`utils/website/activity.server.ts`).
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AuditAction } from '@repo/audit'
import { requireUserId } from '@repo/auth'
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
import { formatDistanceToNow } from 'date-fns'
import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { listWebsiteActivity } from '#app/utils/website/activity.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	return { entries: await listWebsiteActivity(organization.id) }
}

const ACTION_LABELS = {
	[AuditAction.WEBSITE_PAGE_PUBLISHED]: msg`Published a page`,
	[AuditAction.WEBSITE_PAGE_UNPUBLISHED]: msg`Unpublished a page`,
	[AuditAction.WEBSITE_PAGE_DELETED]: msg`Deleted a page`,
	[AuditAction.WEBSITE_PAGE_RESTORED]: msg`Brought a page back`,
	[AuditAction.WEBSITE_VERSION_RESTORED]: msg`Restored an earlier version`,
	[AuditAction.WEBSITE_DRAFT_DISCARDED]: msg`Discarded unpublished changes`,
	[AuditAction.WEBSITE_SITE_DESIGN_PUBLISHED]: msg`Published the site design`,
	[AuditAction.WEBSITE_PUBLISH_SCHEDULED]: msg`Scheduled a publish`,
	[AuditAction.WEBSITE_SCHEDULE_CANCELLED]: msg`Cancelled a scheduled publish`,
	[AuditAction.WEBSITE_SCHEDULED_PUBLISH_RAN]: msg`A scheduled publish went live`,
	[AuditAction.WEBSITE_SCHEDULED_PUBLISH_FAILED]: msg`A scheduled publish failed`,
	[AuditAction.WEBSITE_REDIRECT_CREATED]: msg`Added a redirect`,
	[AuditAction.WEBSITE_REDIRECT_UPDATED]: msg`Changed a redirect`,
	[AuditAction.WEBSITE_REDIRECT_DELETED]: msg`Removed a redirect`,
	[AuditAction.WEBSITE_DOMAIN_CHANGED]: msg`Changed the website domain`,
	[AuditAction.WEBSITE_LEGAL_PAGES_GENERATED]: msg`Generated legal pages`,
	[AuditAction.WEBSITE_LEGAL_PAGE_REGENERATED]: msg`Updated a legal page`,
} as const

export default function WebsiteActivityRoute() {
	const { entries } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Activity</Trans>}
				description={
					<Trans>
						Who changed the website and when: publishing, restoring, deleting,
						schedules, redirects and domain changes.
					</Trans>
				}
				headingLevel="h2"
				size="section"
			/>
			{entries.length === 0 ? (
				<EmptyState
					title={_(msg`No website activity yet`)}
					description={_(
						msg`Publishing, restoring or deleting a page will show up here.`,
					)}
					icons={['clock']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>What</Trans>
								</TableHead>
								<TableHead>
									<Trans>Page</Trans>
								</TableHead>
								<TableHead>
									<Trans>Who</Trans>
								</TableHead>
								<TableHead>
									<Trans>When</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{entries.map((entry) => {
								const label =
									ACTION_LABELS[entry.action as keyof typeof ACTION_LABELS]
								return (
									<TableRow key={entry.id}>
										<TableCell className="font-medium">
											{label ? _(label) : entry.details}
										</TableCell>
										<TableCell className="text-muted-foreground wrap-anywhere">
											{entry.pageTitle ?? '—'}
										</TableCell>
										<TableCell>{entry.userName ?? _(msg`System`)}</TableCell>
										<TableCell
											className="text-muted-foreground"
											title={entry.at}
										>
											{formatDistanceToNow(new Date(entry.at), {
												addSuffix: true,
											})}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}
