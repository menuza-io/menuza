import { useLoaderData } from 'react-router'
import { JobEditor } from '#app/components/hiring/job-editor.tsx'
import { useSiteOrigin } from '#app/hooks/use-site-origin.ts'
import { loadHiringContext } from '#app/utils/hiring/hiring-context.server.ts'
import { runPostingAction } from '#app/utils/hiring/posting-actions.server.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { HIRING_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring.new.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		HIRING_WRITE_REQUIREMENT,
	)
	const context = await loadHiringContext(access.organizationId)
	return { orgSlug: params.orgSlug, ...context }
}

export async function action({ request, params }: Route.ActionArgs) {
	return runPostingAction({
		request,
		orgSlug: params.orgSlug,
		postingId: null,
	})
}

export default function NewJobRoute() {
	const {
		orgSlug,
		defaultCurrency,
		sitePublished,
		customDomain,
		defaultLocale,
		supportedLocales,
	} = useLoaderData<typeof loader>()
	const siteOrigin = useSiteOrigin(orgSlug, customDomain)
	return (
		<JobEditor
			orgSlug={orgSlug}
			posting={null}
			defaultCurrency={defaultCurrency}
			siteOrigin={siteOrigin}
			sitePublished={sitePublished}
			initialStep="role"
			defaultLocale={defaultLocale}
			supportedLocales={supportedLocales}
		/>
	)
}
