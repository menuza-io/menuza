/**
 * IndexNow (#138): when pages are published, tell Bing, Yandex and the other
 * IndexNow engines which URLs changed. One request per publish, listing every
 * language version of each indexable page (published, not noindex), and each
 * URL at most once an hour. The key is generated per organization and served
 * by Sites at `/<key>.txt`.
 *
 * Runs after the response (`runAfterResponse`), so publishing is never slowed
 * or failed by a search engine. Tests replace the sender with
 * `setIndexNowSender`; outside production nothing is sent unless a test asks.
 */
import {
	getLocaleHref,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import {
	generateIndexNowKey,
	indexNowBody,
	isIndexNowKey,
	selectIndexNowUrls,
} from '@repo/common/site-seo'
import {
	and,
	db,
	eq,
	inArray,
	IndexNowPing,
	Organization,
	WebsitePage,
} from '@repo/database'
import { ENV } from 'varlock/env'
import { websitePagePath } from '#app/utils/website/redirect-plan.ts'
import { primarySiteUrl } from './search-console.server.ts'

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

export type IndexNowRequest = ReturnType<typeof indexNowBody>
type Sender = (body: IndexNowRequest) => Promise<boolean>

async function liveSender(body: IndexNowRequest): Promise<boolean> {
	const response = await fetch(INDEXNOW_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	})
	// 200 and 202 are both accepted (202: key validation pending).
	return response.ok
}

let senderOverride: Sender | null = null

/** Tests capture what would be sent; `null` restores the default. */
export function setIndexNowSender(sender: Sender | null) {
	senderOverride = sender
}

function sender(): Sender | null {
	if (senderOverride) return senderOverride
	return ENV.NODE_ENV === 'production' ? liveSender : null
}

/** The organization's IndexNow key, created on first use. */
export async function ensureIndexNowKey(
	organizationId: string,
): Promise<string> {
	const [row] = await db
		.select({ key: Organization.indexNowKey })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (row?.key && isIndexNowKey(row.key)) return row.key
	const key = generateIndexNowKey()
	await db
		.update(Organization)
		.set({ indexNowKey: key })
		.where(eq(Organization.id, organizationId))
	return key
}

/**
 * Every language version of the given pages that search engines may index:
 * published and not marked "hide from search engines".
 */
export async function indexablePageUrls(
	organization: {
		id: string
		slug: string
		customDomain: string | null
		customDomainStatus: string | null
		siteLocales: string | null
		siteDefaultLocale: string | null
	},
	pageIds: readonly string[],
): Promise<string[]> {
	if (!pageIds.length) return []
	const pages = await db
		.select({
			slug: WebsitePage.slug,
			isHomePage: WebsitePage.isHomePage,
			status: WebsitePage.status,
			seoNoIndex: WebsitePage.seoNoIndex,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.organizationId, organization.id),
				inArray(WebsitePage.id, [...pageIds].slice(0, 90)),
			),
		)
	const origin = primarySiteUrl(organization).replace(/\/$/, '')
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const urls: string[] = []
	for (const page of pages) {
		if (page.status !== 'published' || page.seoNoIndex) continue
		const path = websitePagePath(page)
		for (const locale of locales) {
			urls.push(`${origin}${getLocaleHref(path, locale, null, defaultLocale)}`)
		}
	}
	return urls
}

/**
 * Sends one IndexNow request with the URLs not sent in the last hour and
 * records them. Returns the URLs sent (empty when there was nothing to send,
 * the site is not live, or sending is off).
 */
export async function notifyIndexNow(
	organizationId: string,
	urls: readonly string[],
	now = new Date(),
): Promise<string[]> {
	const send = sender()
	if (!send || !urls.length) return []
	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
			sitePublished: Organization.sitePublished,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!organization?.sitePublished) return []
	const origin = primarySiteUrl(organization).replace(/\/$/, '')
	const host = new URL(origin).host
	const pinged = await db
		.select({ url: IndexNowPing.url, at: IndexNowPing.lastPingedAt })
		.from(IndexNowPing)
		.where(eq(IndexNowPing.organizationId, organizationId))
	const due = selectIndexNowUrls(
		urls,
		host,
		new Map(pinged.map((row) => [row.url, row.at.getTime()])),
		now.getTime(),
	)
	if (!due.length) return []
	const key = await ensureIndexNowKey(organizationId)
	const accepted = await send(indexNowBody({ host, key, origin, urls: due }))
	if (!accepted) return []
	const statements = due.map((url) =>
		db
			.insert(IndexNowPing)
			.values({ organizationId, url, lastPingedAt: now })
			.onConflictDoUpdate({
				target: [IndexNowPing.organizationId, IndexNowPing.url],
				set: { lastPingedAt: now },
			}),
	)
	const [first, ...rest] = statements
	if (first) await db.batch([first, ...rest])
	return due
}

/** After a publish: ping IndexNow for the pages that went live. */
export async function notifyIndexNowForPages(
	organizationId: string,
	pageIds: readonly string[],
	now = new Date(),
): Promise<string[]> {
	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!organization) return []
	const urls = await indexablePageUrls(organization, pageIds)
	return notifyIndexNow(organizationId, urls, now)
}
