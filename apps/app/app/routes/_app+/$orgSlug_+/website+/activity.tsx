/**
 * Website, Activity (#85): who published, unpublished, restored, discarded,
 * deleted, scheduled or redirected something on the website, and when. Read
 * with `read:website:any`. The entries are the organization's `AuditLog`
 * lines for website actions (`utils/website/activity.server.ts`).
 */
import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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

// String keys on purpose: `@repo/audit` is server-only and this runs in the browser.
const ACTION_LABELS: Record<string, MessageDescriptor> = {
	website_page_published: msg`Published a page`,
	website_page_unpublished: msg`Unpublished a page`,
	website_page_deleted: msg`Deleted a page`,
	website_page_restored: msg`Brought a page back`,
	website_version_restored: msg`Restored an earlier version`,
	website_draft_discarded: msg`Discarded unpublished changes`,
	website_site_design_published: msg`Published the site design`,
	website_publish_scheduled: msg`Scheduled a publish`,
	website_schedule_cancelled: msg`Cancelled a scheduled publish`,
	website_scheduled_publish_ran: msg`A scheduled publish went live`,
	website_scheduled_publish_failed: msg`A scheduled publish failed`,
	website_redirect_created: msg`Added a redirect`,
	website_redirect_updated: msg`Changed a redirect`,
	website_redirect_deleted: msg`Removed a redirect`,
	website_domain_changed: msg`Changed the website domain`,
	website_legal_pages_generated: msg`Generated legal pages`,
	website_legal_page_regenerated: msg`Updated a legal page`,
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
								const label = ACTION_LABELS[entry.action]
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
