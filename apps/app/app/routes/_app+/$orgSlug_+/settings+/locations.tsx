import { type LoaderFunctionArgs, redirect } from 'react-router'

import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		slug: true,
	})
	return redirect(`/${organization.slug}/locations`)
}
