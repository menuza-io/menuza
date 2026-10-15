import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useLoaderData } from 'react-router'
import { JobEditor } from '#app/components/hiring/job-editor.tsx'
import { JobReadOnly } from '#app/components/hiring/job-read-only.tsx'
import { useSiteOrigin } from '#app/hooks/use-site-origin.ts'
import { type BreadcrumbHandle } from '#app/utils/breadcrumb.ts'
import { loadHiringContext } from '#app/utils/hiring/hiring-context.server.ts'
import {
	POSTING_STEPS,
	type PostingStep,
} from '#app/utils/hiring/job-posting-form.ts'
import { getJobPosting } from '#app/utils/hiring/job-postings.server.ts'
import { runPostingAction } from '#app/utils/hiring/posting-actions.server.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring.$postingId.ts'

export const handle: BreadcrumbHandle<Awaited<ReturnType<typeof loader>>> = {
	breadcrumb: (data) => data.posting.title,
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.hiring,
	)
	const posting = await getJobPosting(access, params.postingId)
	// Another organization's id, or a location outside the member's scope, looks
	// like a job that does not exist.
	if (!posting) throw new Response('Not Found', { status: 404 })
	const context = await loadHiringContext(
		access.organizationId,
		access.scopeIds,
	)
	const step = new URL(request.url).searchParams.get('step')
	return {
		orgSlug: params.orgSlug,
		posting,
		canWrite: holdsStaffingGrant(access.grants, P.UPDATE_HIRING),
		initialStep: (POSTING_STEPS as readonly string[]).includes(step ?? '')
			? (step as PostingStep)
			: 'role',
		...context,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	return runPostingAction({
		request,
		orgSlug: params.orgSlug,
		postingId: params.postingId,
	})
}

export default function EditJobRoute() {
	const {
		orgSlug,
		posting,
		canWrite,
		initialStep,
		locations,
		defaultCurrency,
		sitePublished,
		customDomain,
		defaultLocale,
		supportedLocales,
		canPostEverywhere,
	} = useLoaderData<typeof loader>()
	const siteOrigin = useSiteOrigin(orgSlug, customDomain)
	if (!canWrite) {
		return (
			<JobReadOnly
				orgSlug={orgSlug}
				posting={posting}
				hasLocations={locations.length > 0}
			/>
		)
	}
	return (
		<JobEditor
			key={posting.id}
			orgSlug={orgSlug}
			posting={posting}
			locations={locations}
			defaultCurrency={defaultCurrency}
			siteOrigin={siteOrigin}
			sitePublished={sitePublished}
			initialStep={initialStep}
			defaultLocale={defaultLocale}
			supportedLocales={supportedLocales}
			canPostEverywhere={canPostEverywhere}
		/>
	)
}
