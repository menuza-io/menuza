import { isValidJobPostingSlug } from '@repo/common/job-posting'
import { and, db, eq, Organization } from '@repo/database'
import { type InternalJobPosting } from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { getIntakePosting } from '#app/utils/hiring/job-postings.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { isStaffingFeatureEnabled } from '#app/utils/staffing/access.server.ts'

/**
 * Internal posting facts for the regional application intake.
 *
 * An application is accepted by tenant-api, which cannot read the control
 * plane and must not take the browser's word for what a posting asks. It pulls
 * the posting here, authenticated with `INTERNAL_COMMAND_TOKEN`, and caches the
 * answer for a minute. What crosses is public content (title, role, scope ids,
 * questions) plus which answers are dealbreakers; that last part is the reason
 * this is not the public route. No person data is read or returned: the request
 * names an organization and a posting slug.
 *
 * Every refusal is a plain 404, so tenant-api cannot tell a posting that is not
 * live from one that does not exist from an organization with hiring turned off.
 */

const querySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	slug: z.string().min(1).max(80),
})

export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: a plain 403 instead of the browser redirect.
		if (error instanceof Response && error.status === 302) {
			return new Response('Forbidden', { status: 403 })
		}
		throw error
	}

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success || !isValidJobPostingSlug(parsed.data.slug)) {
		return Response.json({ error: 'Invalid parameters' }, { status: 400 })
	}
	const { orgId, slug } = parsed.data

	const org = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
			eq(Organization.sitePublished, true),
		),
		columns: { id: true },
	})
	if (!org || !(await isStaffingFeatureEnabled(org.id, 'hiring'))) {
		return new Response('Not Found', { status: 404 })
	}
	const posting = await getIntakePosting(org.id, slug)
	if (!posting) return new Response('Not Found', { status: 404 })

	const body: InternalJobPosting = { orgId: org.id, posting }
	return Response.json(body, {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
