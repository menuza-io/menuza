import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'
import { DomainScreen } from '#app/components/website/domain/domain-screen.tsx'
import { handleDomainAction } from '#app/utils/domains/actions.server.ts'
import { loadDomainOverview } from '#app/utils/domains/overview.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/**
 * Website, Domain (#139, #313, #283, #183, #276): the one screen for connecting
 * a domain (apex and www, provider steps, nameservers), buying one, its DNS
 * records and email forwarding. Reading needs `read:website:any`; every change
 * needs `update:settings:any`, as the domain card always did.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		sitePublished: true,
		dataRegion: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const canUpdate = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	return {
		organization: {
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			sitePublished: organization.sitePublished,
		},
		canUpdate,
		justConnected: new URL(request.url).searchParams.get('connected') === '1',
		overview: await loadDomainOverview({ organizationId: organization.id }),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		dataRegion: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const [user] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	const url = new URL(request.url)
	return handleDomainAction(await request.formData(), {
		organization,
		userId,
		userName: user?.name || user?.username || 'Someone',
		request,
		origin: url.origin,
	})
}

export default function WebsiteDomain() {
	const data = useLoaderData<typeof loader>()
	return <DomainScreen {...data} />
}
