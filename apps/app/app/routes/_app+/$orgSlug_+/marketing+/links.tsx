import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { db, eq, Organization } from '@repo/database'
import { PageHeader } from '@repo/ui/page-header'
import {
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { ShortLinksScreen } from '#app/components/marketing/short-links-screen.tsx'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import {
	isShortLinksOn,
	listShortLinks,
	readTargetPath,
} from '#app/utils/marketing/short-links.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/**
 * Marketing, Links (#159): short links to pages of the organization's own site,
 * with a click count per day, a copy button and a QR code to download. Behind
 * `marketing.short_links` (404 while it is off). The links and their counts live
 * in the region; a click is counted per day and nothing else.
 */

const TEXT = z.string().trim().max(100)
const createSchema = z.object({
	intent: z.literal('create'),
	label: z.string().trim().max(120).optional(),
	targetPath: z.string().max(400),
	utmSource: TEXT.optional(),
	utmMedium: TEXT.optional(),
	utmCampaign: TEXT.optional(),
})
const toggleSchema = z.object({
	intent: z.enum(['enable', 'disable']),
	id: z.string().min(1).max(100),
})

async function organizationSite(orgId: string) {
	const [org] = await db
		.select({
			slug: Organization.slug,
			customDomain: Organization.customDomain,
		})
		.from(Organization)
		.where(eq(Organization.id, orgId))
		.limit(1)
	return org ? orgSiteUrl(org) : ''
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)
	// Off until the organization turns it on: the page does not exist before.
	if (!(await isShortLinksOn(orgId))) {
		throw new Response('Not found', { status: 404 })
	}
	const links = await listShortLinks(fetchTenant, 'link')
	return {
		orgSlug,
		siteOrigin: await organizationSite(orgId),
		links: links ?? [],
		error: links ? null : i18n._(t`Failed to load your short links`),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(
		request,
		orgSlug,
		{
			canUpdate: true,
		},
	)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)
	if (!(await isShortLinksOn(orgId))) {
		throw new Response('Not found', { status: 404 })
	}
	const form = Object.fromEntries(await request.formData())

	const toggle = toggleSchema.safeParse(form)
	if (toggle.success) {
		const res = await fetchTenant(
			`/operator/marketing/short-links/${encodeURIComponent(toggle.data.id)}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ disabled: toggle.data.intent === 'disable' }),
			},
		).catch(() => null)
		return res?.ok
			? { ok: true as const }
			: { error: i18n._(t`The link could not be changed. Try again.`) }
	}

	const parsed = createSchema.safeParse(form)
	if (!parsed.success) {
		return { error: i18n._(t`Check the details and try again.`) }
	}
	// Only a page of this website: an address on another domain is refused here
	// and again by the region.
	const targetPath = readTargetPath(parsed.data.targetPath)
	if (!targetPath) {
		return {
			error: i18n._(t`Use a page on your own website, like /menu.`),
		}
	}
	const res = await fetchTenant('/operator/marketing/short-links', {
		method: 'POST',
		body: JSON.stringify({
			kind: 'link',
			label: parsed.data.label || undefined,
			targetPath,
			utmSource: parsed.data.utmSource || undefined,
			utmMedium: parsed.data.utmMedium || undefined,
			utmCampaign: parsed.data.utmCampaign || undefined,
		}),
	}).catch(() => null)
	if (!res?.ok) {
		const body = (await res?.json().catch(() => ({}))) as { error?: string }
		return {
			error:
				body?.error === 'too_many_links'
					? i18n._(t`You have reached the limit of short links.`)
					: i18n._(t`The link could not be made. Try again.`),
		}
	}
	return { ok: true as const }
}

export default function MarketingLinks() {
	const { _ } = useLingui()
	const { siteOrigin, links, error } = useLoaderData<typeof loader>()
	const hasPermission = useHasPermission()
	return (
		<>
			<PageHeader
				title={_(msg`Links`)}
				description={_(
					msg`Short links to your website, with a count of clicks and a QR code.`,
				)}
			/>
			<ShortLinksScreen
				links={links}
				siteOrigin={siteOrigin}
				canWrite={hasPermission('update:campaign:any')}
				error={error}
			/>
		</>
	)
}
