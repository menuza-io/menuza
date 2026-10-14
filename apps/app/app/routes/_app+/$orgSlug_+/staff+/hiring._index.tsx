import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useFetcher, useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useJobLabels } from '#app/components/hiring/job-labels.ts'
import { JobStatus } from '#app/components/hiring/job-status.tsx'
import { loadHiringContext } from '#app/utils/hiring/hiring-context.server.ts'
import { listJobPostings } from '#app/utils/hiring/job-postings.server.ts'
import { runPostingAction } from '#app/utils/hiring/posting-actions.server.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring._index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.hiring,
	)
	const [postings, context] = await Promise.all([
		listJobPostings(access),
		loadHiringContext(access.organizationId),
	])
	return {
		orgSlug: params.orgSlug,
		postings,
		canWrite: holdsStaffingGrant(access.grants, P.UPDATE_HIRING),
		sitePublished: context.sitePublished,
		defaultCurrency: context.defaultCurrency,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	return runPostingAction({
		request,
		orgSlug: params.orgSlug,
		postingId: null,
	})
}

export default function StaffHiringIndexRoute() {
	const { orgSlug, postings, canWrite, sitePublished, defaultCurrency } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const labels = useJobLabels()
	const fetcher = useFetcher()
	const hasGeneral = postings.some((posting) => posting.isGeneral)
	const offerGeneral = canWrite && !hasGeneral
	const live = postings.filter((posting) => posting.status === 'published')

	const addGeneral = (
		<fetcher.Form method="post">
			<input type="hidden" name="intent" value="add_general" />
			<input type="hidden" name="currency" value={defaultCurrency} />
			<Button
				type="submit"
				variant="outline"
				disabled={fetcher.state !== 'idle'}
			>
				<Icon name="plus" />
				<Trans>Add a general application</Trans>
			</Button>
		</fetcher.Form>
	)

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(t`Jobs`)}
				headingLevel="h2"
				size="section"
				description={_(t`Jobs people can see and apply to on your website.`)}
				actions={
					canWrite ? (
						<Button render={<Link to={`/${orgSlug}/staff/hiring/new`} />}>
							<Icon name="plus" />
							<Trans>Post a job</Trans>
						</Button>
					) : null
				}
			/>

			{live.length > 0 && !sitePublished ? (
				<p className="text-sm text-pretty">
					<Trans>
						Your website is not published yet, so people cannot see these jobs.{' '}
						<Link
							to={`/${orgSlug}/settings`}
							className="underline underline-offset-4"
						>
							Publish your website
						</Link>
						.
					</Trans>
				</p>
			) : null}

			{postings.length === 0 ? (
				<EmptyState
					title={
						<>
							<Trans>No jobs yet</Trans>
						</>
					}
					description={
						<>
							<Trans>
								Post a job to get a careers page you can share, or keep a
								general application open for anyone who wants to work with you.
							</Trans>
						</>
					}
					icons={['file-text', 'user-plus', 'users']}
				>
					{canWrite ? (
						<>
							<div className="flex flex-wrap justify-center gap-2">
								<Button render={<Link to={`/${orgSlug}/staff/hiring/new`} />}>
									<Icon name="plus" />
									<Trans>Post a job</Trans>
								</Button>
								{offerGeneral ? addGeneral : null}
							</div>
						</>
					) : null}
				</EmptyState>
			) : (
				<>
					<ItemGroup>
						{postings.map((posting) => {
							const pay = labels.payLine(posting)
							return (
								<Item
									key={posting.id}
									variant="outline"
									render={
										<Link to={`/${orgSlug}/staff/hiring/${posting.id}`} />
									}
								>
									<ItemContent>
										<ItemTitle>{posting.title}</ItemTitle>
										<ItemDescription>
											{[
												posting.isGeneral
													? _(t`Standing application`)
													: posting.positionName,
												labels.employment[posting.employmentType],
												pay,
											]
												.filter(Boolean)
												.join(' · ')}
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<JobStatus status={posting.status} />
									</ItemActions>
								</Item>
							)
						})}
					</ItemGroup>
					{offerGeneral ? (
						<div className="flex flex-wrap items-center justify-between gap-3">
							<p className="text-muted-foreground max-w-prose text-sm text-pretty">
								<Trans>
									A general application stays open all the time, so people can
									apply even when no job is posted.
								</Trans>
							</p>
							{addGeneral}
						</div>
					) : null}
				</>
			)}
		</div>
	)
}
