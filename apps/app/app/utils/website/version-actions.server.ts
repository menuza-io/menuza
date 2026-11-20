import {
	and,
	db,
	eq,
	inArray,
	isNull,
	Organization,
	OrganizationMediaAsset,
	WebsitePage,
	WebsiteVersion,
} from '@repo/database'
import {
	loadDraftSections,
	markPageVersionsDeletedStatement,
	replaceDraftSectionsStatements,
} from './versions.server.ts'
import {
	canonicalJson,
	hashChrome,
	hashSections,
	hashTheme,
	parseChromeSnapshot,
	parseSnapshotSections,
	type SectionLike,
} from './versions.ts'

export type DiscardResult =
	{ ok: true } | { ok: false; error: 'never_published' }

/**
 * Discard changes (#85): the page's draft goes back to what is live, and so
 * does the pending site design. Refused for a page that was never published,
 * which has no live content to go back to (nothing is deleted).
 */
export async function discardPageDraft(input: {
	organizationId: string
	pageId: string
}): Promise<DiscardResult> {
	const [page] = await db
		.select({ publishedData: WebsitePage.publishedData })
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.id, input.pageId),
				eq(WebsitePage.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!page || page.publishedData === null) {
		return { ok: false, error: 'never_published' }
	}
	await db.batch([
		...replaceDraftSectionsStatements(
			input.pageId,
			parseSnapshotSections(page.publishedData),
		),
		db
			.update(Organization)
			.set({
				draftHeaderConfig: null,
				draftFooterConfig: null,
				draftSiteTheme: null,
			})
			.where(eq(Organization.id, input.organizationId)),
	] as unknown as Parameters<typeof db.batch>[0])
	return { ok: true }
}

export type RestoreResult =
	| { ok: true; kind: 'page' | 'chrome' | 'theme'; missingMedia: string[] }
	| { ok: false; error: 'version_not_found' | 'stale_version' }

/**
 * Restore a version (#85): its content becomes the draft and nothing else.
 * The live site changes only when the operator publishes. `expectedDraftHash`
 * is the draft's hash the operator saw; if the draft was edited since (by
 * anyone), the restore is refused with `stale_version` rather than
 * overwriting those edits.
 */
export async function restoreVersion(input: {
	organizationId: string
	/** The page being edited; a page version can only restore onto its own page. */
	pageId: string
	versionId: string
	expectedDraftHash: string
}): Promise<RestoreResult> {
	const [version] = await db
		.select()
		.from(WebsiteVersion)
		.where(
			and(
				eq(WebsiteVersion.id, input.versionId),
				eq(WebsiteVersion.organizationId, input.organizationId),
				isNull(WebsiteVersion.deletedAt),
			),
		)
		.limit(1)
	if (!version) return { ok: false, error: 'version_not_found' }

	if (version.kind === 'page') {
		if (version.pageId !== input.pageId) {
			return { ok: false, error: 'version_not_found' }
		}
		const current = await hashSections(await loadDraftSections(input.pageId))
		if (current !== input.expectedDraftHash) {
			return { ok: false, error: 'stale_version' }
		}
		const sections = parseSnapshotSections(version.snapshot)
		await db.batch(
			replaceDraftSectionsStatements(
				input.pageId,
				sections,
			) as unknown as Parameters<typeof db.batch>[0],
		)
		return {
			ok: true,
			kind: 'page',
			missingMedia: await findMissingMedia(input.organizationId, sections),
		}
	}

	const [org] = await db
		.select({
			siteHeaderConfig: Organization.siteHeaderConfig,
			siteFooterConfig: Organization.siteFooterConfig,
			siteTheme: Organization.siteTheme,
			draftHeaderConfig: Organization.draftHeaderConfig,
			draftFooterConfig: Organization.draftFooterConfig,
			draftSiteTheme: Organization.draftSiteTheme,
		})
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!org) return { ok: false, error: 'version_not_found' }

	if (version.kind === 'chrome') {
		const current = await hashChrome({
			header: org.draftHeaderConfig ?? org.siteHeaderConfig,
			footer: org.draftFooterConfig ?? org.siteFooterConfig,
		})
		if (current !== input.expectedDraftHash) {
			return { ok: false, error: 'stale_version' }
		}
		const snapshot = parseChromeSnapshot(version.snapshot)
		const draftFor = (next: string | null, live: string | null) =>
			next === null || canonicalJson(next) === canonicalJson(live) ? null : next
		await db
			.update(Organization)
			.set({
				draftHeaderConfig: draftFor(snapshot.header, org.siteHeaderConfig),
				draftFooterConfig: draftFor(snapshot.footer, org.siteFooterConfig),
			})
			.where(eq(Organization.id, input.organizationId))
		return { ok: true, kind: 'chrome', missingMedia: [] }
	}

	if (version.kind === 'theme') {
		const current = await hashTheme(org.draftSiteTheme ?? org.siteTheme)
		if (current !== input.expectedDraftHash) {
			return { ok: false, error: 'stale_version' }
		}
		await db
			.update(Organization)
			.set({
				draftSiteTheme:
					canonicalJson(version.snapshot) === canonicalJson(org.siteTheme)
						? null
						: version.snapshot,
			})
			.where(eq(Organization.id, input.organizationId))
		return { ok: true, kind: 'theme', missingMedia: [] }
	}

	return { ok: false, error: 'version_not_found' }
}

/**
 * Media a set of sections points at that no longer exists in the media
 * library (an old version can reference deleted images). Restoring still
 * works; the editor flags these.
 */
export async function findMissingMedia(
	organizationId: string,
	sections: readonly SectionLike[],
): Promise<string[]> {
	const keys = new Set<string>()
	for (const section of sections) {
		for (const match of section.config.matchAll(/objectKey=([^&"\\\s]+)/g)) {
			try {
				keys.add(decodeURIComponent(match[1]!))
			} catch {
				keys.add(match[1]!)
			}
		}
	}
	if (keys.size === 0) return []
	const all = [...keys]
	const found = new Set<string>()
	for (let i = 0; i < all.length; i += 50) {
		const rows = await db
			.select({ objectKey: OrganizationMediaAsset.objectKey })
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.objectKey, all.slice(i, i + 50)),
				),
			)
		for (const row of rows) found.add(row.objectKey)
	}
	return all.filter((key) => !found.has(key)).slice(0, 20)
}

/**
 * The statement that keeps the versions of a deleted page for the 30 day
 * purge instead of removing them; for the same `db.batch` as the delete.
 */
export function keepDeletedPageVersions(
	organizationId: string,
	pageId: string,
) {
	return markPageVersionsDeletedStatement(db, organizationId, pageId)
}
