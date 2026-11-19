import { requireUserId } from '@repo/auth'
import { parseSiteThemeConfig } from '@repo/common/site-theme'
import { and, db, eq, WebsitePage } from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	composePageSectionsWithChrome,
	getDefaultConfig,
} from '#app/utils/website/block-types.ts'
import { readSiteDesign } from '#app/utils/website/site-design.server.ts'
import { findMissingMedia } from '#app/utils/website/version-actions.server.ts'
import {
	listPageVersions,
	loadDraftSections,
} from '#app/utils/website/versions.server.ts'
import {
	hashChrome,
	hashSections,
	hashTheme,
	parseChromeSnapshot,
	parseSnapshotSections,
	parseVersionSummary,
	type WebsiteVersionKind,
} from '#app/utils/website/versions.ts'

function isKind(value: string | null): value is WebsiteVersionKind {
	return value === 'page' || value === 'chrome' || value === 'theme'
}

/**
 * History of a page, or of the site header and footer (`kind=chrome`) or
 * theme (`kind=theme`) (#85): every published version with who published it
 * and when, the newest being the live one. `?version=<id>` also returns what
 * the editor preview needs to show that version, and flags media that no
 * longer exists. Read only: restoring is an action of the page editor.
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
	const [page] = await db
		.select({ id: WebsitePage.id })
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.id, params.pageId!),
				eq(WebsitePage.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!page) throw new Response('Page not found', { status: 404 })

	const url = new URL(request.url)
	const kindParam = url.searchParams.get('kind')
	const kind: WebsiteVersionKind = isKind(kindParam) ? kindParam : 'page'
	const pageId = kind === 'page' ? page.id : null

	const [rows, design, draftSections] = await Promise.all([
		listPageVersions(organization.id, { kind, pageId }),
		readSiteDesign(organization.id),
		loadDraftSections(page.id),
	])
	const draftHash =
		kind === 'page'
			? await hashSections(draftSections)
			: kind === 'chrome'
				? await hashChrome({ header: design.header, footer: design.footer })
				: await hashTheme(design.theme)

	const versions = rows.map((row, index) => ({
		id: row.id,
		kind,
		title: row.title,
		publishedAt: row.publishedAt.toISOString(),
		publishedBy: row.publishedBy?.name || row.publishedBy?.username || null,
		summary: parseVersionSummary(row.summary),
		restoredFromId: row.restoredFromId,
		// The newest version is what the public site serves.
		isLive: index === 0,
	}))

	let preview: {
		id: string
		sections: Array<{
			id: string
			type: string
			config: string
			position: number
		}>
		theme: ReturnType<typeof parseSiteThemeConfig> | null
		missingMedia: string[]
	} | null = null
	const previewId = url.searchParams.get('version')
	if (previewId) {
		const row = rows.find((candidate) => candidate.id === previewId)
		if (!row) throw new Response('Version not found', { status: 404 })
		const header = design.header ?? JSON.stringify(getDefaultConfig('header'))
		const footer = design.footer ?? JSON.stringify(getDefaultConfig('footer'))
		if (kind === 'page') {
			const sections = parseSnapshotSections(row.snapshot)
			preview = {
				id: row.id,
				sections: composePageSectionsWithChrome(
					sections.map((section, index) => ({
						id: section.id ?? `version-${index}`,
						type: section.type,
						config: section.config,
						position: index,
					})),
					header,
					footer,
				),
				theme: null,
				missingMedia: await findMissingMedia(organization.id, sections),
			}
		} else if (kind === 'chrome') {
			const chrome = parseChromeSnapshot(row.snapshot)
			preview = {
				id: row.id,
				sections: composePageSectionsWithChrome(
					draftSections,
					chrome.header ?? header,
					chrome.footer ?? footer,
				),
				theme: null,
				missingMedia: [],
			}
		} else {
			preview = {
				id: row.id,
				sections: composePageSectionsWithChrome(draftSections, header, footer),
				theme: parseSiteThemeConfig(row.snapshot || null),
				missingMedia: [],
			}
		}
	}

	return { kind, versions, draftHash, preview }
}
