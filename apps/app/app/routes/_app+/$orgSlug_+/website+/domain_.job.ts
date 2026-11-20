import { requireUserId } from '@repo/auth'
import { type LoaderFunctionArgs } from 'react-router'
import { getDomainJobStatus } from '#app/utils/domains/registrar.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/**
 * The progress screen of a domain purchase polls this (#183): the job's step,
 * whether it failed and whether the charge was refunded. Ids and codes only.
 */
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
	const jobId = new URL(request.url).searchParams.get('job') ?? ''
	const status = jobId ? await getDomainJobStatus(organization.id, jobId) : null
	if (!status) throw new Response('Not Found', { status: 404 })
	return Response.json(status, { headers: { 'Cache-Control': 'no-store' } })
}
