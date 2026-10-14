import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { PageTitle } from '@repo/ui/page-title'
import { useCallback } from 'react'
import { Link } from 'react-router'
import { SHARED_ACCESS_LABELS } from '#app/components/dashboard/access-labels.ts'
import { DashboardBlockContent } from '#app/components/dashboard/dashboard-block-content.tsx'
import { DashboardEditor } from '#app/components/dashboard/dashboard-editor.tsx'
import { DashboardOptionsMenu } from '#app/components/dashboard/dashboard-options-menu.tsx'
import { DashboardSwitcher } from '#app/components/dashboard/dashboard-switcher.tsx'
import { ShareDashboardDialog } from '#app/components/dashboard/share-dashboard-dialog.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireCustomDashboardAccess } from '#app/utils/dashboards/access.server.ts'
import { handleCustomDashboardAction } from '#app/utils/dashboards/actions.server.ts'
import {
	loadBlockPicker,
	loadBuiltInBlockData,
	loadReportBlockData,
} from '#app/utils/dashboards/block-data.server.ts'
import {
	canEdit,
	isOwner,
	type DashboardBlock,
	type DashboardShareAccess,
} from '#app/utils/dashboards/config.ts'
import {
	listDashboardsForSwitcher,
	loadDashboardSharing,
} from '#app/utils/dashboards/queries.server.ts'
import { resolveReportBlock } from '#app/utils/dashboards/reports.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/$dashboardId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const { createdAt, dataRegion, ...organization } =
		await requireUserOrganization(request, params.orgSlug, {
			id: true,
			name: true,
			slug: true,
			createdAt: true,
			dataRegion: true,
		})
	const { access, dashboard } = await requireCustomDashboardAccess({
		userId,
		organizationId: organization.id,
		dashboardId: params.dashboardId,
	})
	const blocks = dashboard.config.blocks
	const [blockData, reports, switcher, sharing] = await Promise.all([
		loadBuiltInBlockData({
			userId,
			organization: { id: organization.id, createdAt },
			blocks,
		}),
		loadReportBlockData({
			organization: { ...organization, dataRegion },
			blocks,
		}),
		listDashboardsForSwitcher(userId, organization.id),
		isOwner(access)
			? loadDashboardSharing({
					dashboardId: dashboard.id,
					organizationId: organization.id,
					ownerId: dashboard.ownerId,
				})
			: null,
	])
	const picker = await loadBlockPicker({
		userId,
		organizationId: organization.id,
		blockData,
	})

	return {
		organization,
		dashboard: {
			id: dashboard.id,
			kind: 'custom' as const,
			name: dashboard.name,
			access,
			ownerName: dashboard.ownerName,
			config: dashboard.config,
		},
		blockData,
		reports,
		picker,
		switcher,
		sharing,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	return handleCustomDashboardAction({
		request,
		userId,
		organization,
		dashboardId: params.dashboardId,
	})
}

/** Tells a recipient whose dashboard this is and what they may do with it. */
function SharedBy({
	ownerName,
	access,
}: {
	ownerName: string
	access: DashboardShareAccess
}) {
	const { _ } = useLingui()
	const accessLabel = _(SHARED_ACCESS_LABELS[access])
	return (
		<Trans>
			Shared by {ownerName} · {accessLabel}
		</Trans>
	)
}

export default function CustomDashboard({ loaderData }: Route.ComponentProps) {
	const {
		organization,
		dashboard,
		blockData,
		reports,
		picker,
		switcher,
		sharing,
	} = loaderData
	const dashboardUrl = `/${organization.slug}/dashboards/${dashboard.id}`
	const editable = canEdit(dashboard.access)

	const renderBlock = useCallback(
		(block: DashboardBlock) => (
			<DashboardBlockContent
				block={block}
				data={blockData}
				reports={reports}
				savedReportOptions={picker.savedReports}
				organization={organization}
				editable={editable}
			/>
		),
		[blockData, editable, organization, picker.savedReports, reports],
	)
	const blockTitle = useCallback(
		(block: DashboardBlock) =>
			block.type === 'report'
				? resolveReportBlock(block.config, {
						orgSlug: organization.slug,
						reports,
						savedReportOptions: picker.savedReports,
					}).title
				: null,
		[organization.slug, picker.savedReports, reports],
	)

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<PageTitle
				title={<span className="wrap-anywhere">{dashboard.name}</span>}
				description={
					dashboard.access === 'owner' ? null : (
						<SharedBy
							ownerName={dashboard.ownerName}
							access={dashboard.access}
						/>
					)
				}
			/>
			<DashboardEditor
				// Unsaved edits, open menus and dialogs belong to one dashboard.
				key={dashboard.id}
				title={
					<DashboardSwitcher
						orgSlug={organization.slug}
						current={{ id: dashboard.id, name: dashboard.name }}
						dashboards={switcher}
					/>
				}
				actions={
					isOwner(dashboard.access) && sharing ? (
						<>
							<ShareDashboardDialog
								action={dashboardUrl}
								name={dashboard.name}
								sharing={sharing}
							/>
							<DashboardOptionsMenu
								action={dashboardUrl}
								name={dashboard.name}
							/>
						</>
					) : null
				}
				readOnly={!editable}
				config={dashboard.config}
				blockData={blockData}
				picker={picker}
				renderBlock={renderBlock}
				blockTitle={blockTitle}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				404: ({ params }) => (
					<div className="flex flex-col items-center gap-4 text-center">
						<p>
							<Trans>
								This dashboard does not exist or you do not have access to it.
							</Trans>
						</p>
						<Button
							variant="outline"
							render={<Link to={`/${params.orgSlug}`} />}
						>
							<Trans>Go to Home</Trans>
						</Button>
					</div>
				),
			}}
		/>
	)
}
