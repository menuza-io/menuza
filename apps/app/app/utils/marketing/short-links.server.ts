import { requireUserId } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { shortLinkUrl, siteTargetPathSchema } from '@repo/common/short-links'
import { printUtmParams } from '@repo/common/print-shop'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { MARKETING_FLAG_KEYS } from './marketing-flags.server.ts'

/**
 * Short links in the App (#159): the Links screen and a print's tracked QR.
 * The links, their codes and their click counts live in the organization's
 * region (no guest data, but regional like everything about a send); the App
 * asks for them with an operator token and never stores a count.
 */

export type ShortLinkRow = {
	id: string
	code: string
	kind: 'link' | 'print' | 'message'
	ref: string | null
	label: string | null
	targetPath: string
	utmSource: string | null
	utmMedium: string | null
	utmCampaign: string | null
	utmContent: string | null
	disabled: boolean
	createdAt: number
	clicksThisMonth: number
	clicksTotal: number
	daily: Array<{ day: string; clicks: number }>
	/** Orders placed after a click on this link, and what they kept after refunds (#115). */
	orders: number
	revenueMinor: number
}

export async function isShortLinksOn(organizationId: string) {
	const flag = await getFeatureFlag(MARKETING_FLAG_KEYS.shortLinks, {
		organizationId,
	})
	return flag === true || flag === 'true'
}

type Fetch = (path: string, init?: RequestInit) => Promise<Response>

export async function listShortLinks(
	fetchTenant: Fetch,
	kind: 'link' | 'print',
): Promise<ShortLinkRow[] | null> {
	try {
		const res = await fetchTenant(
			`/operator/marketing/short-links?kind=${kind}`,
		)
		if (!res.ok) return null
		const body = (await res.json()) as { links?: ShortLinkRow[] }
		return Array.isArray(body.links) ? body.links : null
	} catch {
		return null
	}
}

/** The path on the own site a short link may point to, or null. */
export function readTargetPath(value: unknown): string | null {
	const parsed = siteTargetPathSchema.safeParse(
		typeof value === 'string' ? value.trim() : '',
	)
	return parsed.success ? parsed.data : null
}

/**
 * The short URL of a design's tracked QR, created on first use. A viewer who
 * cannot write only finds the link a writer already made (saving the design
 * makes it), and gets null when there is none. A region that cannot be reached
 * is an error, never a silently untracked code.
 */
export async function trackedQrUrl(input: {
	request: Request
	organization: {
		id: string
		slug: string
		customDomain: string | null
	}
	designId: string
	path: string
	canWrite: boolean
}): Promise<string | null> {
	if (!(await isShortLinksOn(input.organization.id))) return null
	await requireUserId(input.request)
	const client = await getOperatorTenantClient(
		input.request,
		input.organization.slug,
		{ canUpdate: input.canWrite },
	)
	const siteOrigin = orgSiteUrl(input.organization)
	const found = (await listShortLinks(client.fetchTenant, 'print'))?.find(
		(link) => link.ref === input.designId && link.targetPath === input.path,
	)
	if (found) return shortLinkUrl(siteOrigin, found.code)
	if (!input.canWrite) return null
	const utm = printUtmParams(input.designId)
	const res = await client
		.fetchTenant('/operator/marketing/short-links', {
			method: 'POST',
			body: JSON.stringify({
				kind: 'print',
				ref: input.designId,
				targetPath: input.path,
				utmSource: utm.utm_source,
				utmMedium: utm.utm_medium,
				utmCampaign: utm.utm_campaign,
			}),
		})
		.catch(() => null)
	if (!res?.ok) {
		throw new Response('Scan counting is unavailable right now', {
			status: 503,
		})
	}
	const body = (await res.json()) as { link?: ShortLinkRow }
	return body.link ? shortLinkUrl(siteOrigin, body.link.code) : null
}

/** Scans this month of a design's tracked QR, or null when it has none (yet). */
export async function trackedQrScans(input: {
	request: Request
	organization: { id: string; slug: string }
	designId: string
	path: string
}): Promise<number | null> {
	if (!(await isShortLinksOn(input.organization.id))) return null
	const client = await getOperatorTenantClient(
		input.request,
		input.organization.slug,
	)
	const links = await listShortLinks(client.fetchTenant, 'print')
	const found = links?.find(
		(link) => link.ref === input.designId && link.targetPath === input.path,
	)
	return found ? found.clicksThisMonth : null
}
