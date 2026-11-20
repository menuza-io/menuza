import { and, db, eq, Organization, WebsitePage } from '@repo/database'
import { sql, type SQL } from 'drizzle-orm'
import {
	insertVersionStatement,
	loadDraftSections,
	pruneVersionsStatement,
	type VersionWriter,
} from './versions.server.ts'
import {
	hashChrome,
	hashSections,
	hashTheme,
	parseSnapshotSections,
	summarizeSectionChange,
	siteDesignChanges,
} from './versions.ts'

/** `db`, or the `tx` of a `db.transaction` callback. */
type PageWriter = VersionWriter

export type PublishOptions = {
	/** Who published. Null for a system publish (and a deleted account). */
	publishedById?: string | null
	/** Set when the draft being published came from a restored version. */
	restoredFromId?: string | null
}

/**
 * Publish a website page: set it published, store a snapshot of its sections
 * in `publishedData` and write one immutable `WebsiteVersion` (#85). The
 * public site serves that snapshot, never the `WebsitePageSection` rows, which
 * are the editor's working copy, so later edits stay private until the page is
 * published again. Locked chrome (header, footer) is left out: the site adds
 * the organization's own.
 *
 * Every path that makes a page published must go through here.
 */
export async function publishWebsitePage(
	pageId: string,
	writer: PageWriter = db,
	options: PublishOptions = {},
) {
	const { statements } = await buildPublishWebsitePageUpdate(
		pageId,
		writer,
		undefined,
		options,
	)
	const batch = (writer as { batch?: typeof db.batch }).batch
	if (typeof batch === 'function') {
		// The page, its version and the pruning commit together or not at all.
		await batch.call(
			writer,
			statements as unknown as Parameters<typeof db.batch>[0],
		)
	} else {
		// A transaction (`db.transaction`) has no batch: it is the atomic unit.
		for (const statement of statements) await statement
	}
}

/**
 * Reads the page's sections and returns the publishing writes without running
 * them, so a caller can put them in a `db.batch` with other writes: `update`
 * is the page UPDATE alone and `statements` is the update, the version INSERT
 * and the pruning of old versions. `onlyIf` adds a condition every one of them
 * must meet when it runs. The statements are query builders, so awaiting one
 * runs it.
 */
export async function buildPublishWebsitePageUpdate(
	pageId: string,
	writer: PageWriter = db,
	onlyIf?: SQL,
	options: PublishOptions = {},
) {
	const [page] = await writer
		.select({
			organizationId: WebsitePage.organizationId,
			title: WebsitePage.title,
			slug: WebsitePage.slug,
			publishedData: WebsitePage.publishedData,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.id, pageId))
		.limit(1)
	if (!page) throw new Error('Page not found')
	const publishedSections = await loadDraftSections(pageId, writer)
	const snapshot = JSON.stringify(publishedSections)
	const previous = parseSnapshotSections(page.publishedData)
	const update = writer
		.update(WebsitePage)
		.set({ status: 'published', publishedData: snapshot })
		.where(and(eq(WebsitePage.id, pageId), onlyIf))
	const { id: versionId, statement: insertVersion } = insertVersionStatement(
		writer,
		{
			organizationId: page.organizationId,
			pageId,
			kind: 'page',
			title: page.title,
			slug: page.slug,
			snapshot,
			contentHash: await hashSections(publishedSections),
			summary: summarizeSectionChange(previous, publishedSections),
			publishedById: options.publishedById ?? null,
			restoredFromId: options.restoredFromId ?? null,
		},
		onlyIf,
	)
	const prune = pruneVersionsStatement(writer, {
		organizationId: page.organizationId,
		kind: 'page',
		pageId,
	})
	return {
		update,
		statements: [update, insertVersion, prune],
		versionId,
		organizationId: page.organizationId,
	}
}

/** Another save changed the site design while a publish was being written. */
export class PublishConflictError extends Error {
	constructor() {
		super('The site design changed while it was being published. Try again.')
		this.name = 'PublishConflictError'
	}
}

const MAX_ATTEMPTS = 5

type OrgDesignRow = {
	siteHeaderConfig: string | null
	siteFooterConfig: string | null
	siteTheme: string | null
	draftHeaderConfig: string | null
	draftFooterConfig: string | null
	draftSiteTheme: string | null
}

const orgDesignColumns = {
	siteHeaderConfig: Organization.siteHeaderConfig,
	siteFooterConfig: Organization.siteFooterConfig,
	siteTheme: Organization.siteTheme,
	draftHeaderConfig: Organization.draftHeaderConfig,
	draftFooterConfig: Organization.draftFooterConfig,
	draftSiteTheme: Organization.draftSiteTheme,
}

/** Holds only while none of the site design columns changed since they were read. */
export function siteDesignUnchanged(
	organizationId: string,
	row: OrgDesignRow,
): SQL {
	return sql`EXISTS (SELECT 1 FROM ${Organization} WHERE ${Organization.id} = ${organizationId}
		AND ${Organization.siteHeaderConfig} IS ${row.siteHeaderConfig}
		AND ${Organization.siteFooterConfig} IS ${row.siteFooterConfig}
		AND ${Organization.siteTheme} IS ${row.siteTheme}
		AND ${Organization.draftHeaderConfig} IS ${row.draftHeaderConfig}
		AND ${Organization.draftFooterConfig} IS ${row.draftFooterConfig}
		AND ${Organization.draftSiteTheme} IS ${row.draftSiteTheme})`
}

/**
 * The writes that make the pending site design (header, footer, theme drafts)
 * live, with one version for the chrome and one for the theme, whichever
 * changed. The Organization UPDATE is last and carries `guard`, so every
 * earlier statement (which carries it too) saw the same, unchanged columns.
 */
export async function buildPublishSiteDesign(
	organizationId: string,
	row: OrgDesignRow,
	guard: SQL,
	options: PublishOptions = {},
) {
	const changes = siteDesignChanges(row)
	const statements: unknown[] = []
	const versionIds: string[] = []
	const set: Record<string, string | null> = {}
	if (changes.chrome) {
		const header = row.draftHeaderConfig ?? row.siteHeaderConfig
		const footer = row.draftFooterConfig ?? row.siteFooterConfig
		const snapshot = { header, footer }
		const { id, statement } = insertVersionStatement(
			db,
			{
				organizationId,
				pageId: null,
				kind: 'chrome',
				snapshot: JSON.stringify(snapshot),
				contentHash: await hashChrome(snapshot),
				publishedById: options.publishedById ?? null,
				restoredFromId: options.restoredFromId ?? null,
			},
			guard,
		)
		versionIds.push(id)
		statements.push(
			statement,
			pruneVersionsStatement(db, {
				organizationId,
				kind: 'chrome',
				pageId: null,
			}),
		)
		set.siteHeaderConfig = header
		set.siteFooterConfig = footer
		set.draftHeaderConfig = null
		set.draftFooterConfig = null
	}
	if (changes.theme) {
		const theme = row.draftSiteTheme ?? row.siteTheme
		const { id, statement } = insertVersionStatement(
			db,
			{
				organizationId,
				pageId: null,
				kind: 'theme',
				snapshot: theme ?? '',
				contentHash: await hashTheme(theme),
				publishedById: options.publishedById ?? null,
			},
			guard,
		)
		versionIds.push(id)
		statements.push(
			statement,
			pruneVersionsStatement(db, {
				organizationId,
				kind: 'theme',
				pageId: null,
			}),
		)
		set.siteTheme = theme
		set.draftSiteTheme = null
	}
	// A draft that already equals live is cleared too, so nothing lingers.
	if (!changes.header && !changes.footer && row.draftHeaderConfig !== null) {
		set.draftHeaderConfig = null
	}
	if (!changes.header && !changes.footer && row.draftFooterConfig !== null) {
		set.draftFooterConfig = null
	}
	if (!changes.theme && row.draftSiteTheme !== null) set.draftSiteTheme = null
	const hasWrites = Object.keys(set).length > 0
	// The guarded UPDATE always runs last to tell whether the batch applied, so
	// it needs something to set: its own current value when nothing changes.
	if (!hasWrites) set.draftHeaderConfig = row.draftHeaderConfig
	return { changes, statements, versionIds, set, hasWrites }
}

/**
 * Publishes a page together with the pending site design (header, footer and
 * theme drafts) so the page and the design it was edited with go live
 * together or not at all. Every write is one `db.batch` guarded by the site
 * design columns; if another save changed them meanwhile the whole batch
 * writes nothing and is read and tried again.
 */
export async function publishPageWithSiteDesign(
	pageId: string,
	organizationId: string,
	options: PublishOptions = {},
) {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const [row] = await db
			.select(orgDesignColumns)
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)
		if (!row) throw new Error('Organization not found')
		const guard = siteDesignUnchanged(organizationId, row)
		const page = await buildPublishWebsitePageUpdate(pageId, db, guard, options)
		const design = await buildPublishSiteDesign(
			organizationId,
			row,
			guard,
			options,
		)
		const orgUpdate = db
			.update(Organization)
			.set(design.set)
			.where(and(eq(Organization.id, organizationId), guard))
			.returning({ id: Organization.id })
		const results = await db.batch([
			...page.statements,
			...design.statements,
			orgUpdate,
		] as unknown as [typeof orgUpdate])
		const updated = results[results.length - 1] as unknown as { id: string }[]
		if (updated.length > 0) {
			return {
				versionId: page.versionId,
				publishedChrome: design.changes.chrome,
				publishedTheme: design.changes.theme,
			}
		}
	}
	throw new PublishConflictError()
}

/**
 * Publishes only the pending site design (the Branding panel's Publish).
 * Returns what went live; nothing pending is a no-op.
 */
export async function publishSiteDesign(
	organizationId: string,
	options: PublishOptions = {},
) {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const [row] = await db
			.select(orgDesignColumns)
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)
		if (!row) throw new Error('Organization not found')
		const guard = siteDesignUnchanged(organizationId, row)
		const design = await buildPublishSiteDesign(
			organizationId,
			row,
			guard,
			options,
		)
		if (!design.changes.any) {
			// Nothing differs from live; make sure no equal draft lingers.
			if (design.hasWrites) {
				await db
					.update(Organization)
					.set(design.set)
					.where(eq(Organization.id, organizationId))
			}
			return { publishedChrome: false, publishedTheme: false }
		}
		const orgUpdate = db
			.update(Organization)
			.set(design.set)
			.where(and(eq(Organization.id, organizationId), guard))
			.returning({ id: Organization.id })
		const results = await db.batch([
			...design.statements,
			orgUpdate,
		] as unknown as [typeof orgUpdate])
		const updated = results[results.length - 1] as unknown as { id: string }[]
		if (updated.length > 0) {
			return {
				publishedChrome: design.changes.chrome,
				publishedTheme: design.changes.theme,
			}
		}
	}
	throw new PublishConflictError()
}
