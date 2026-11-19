import { createId } from '@paralleldrive/cuid2'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	isNull,
	WebsitePageSection,
	WebsiteVersion,
} from '@repo/database'
import { sql, type SQL } from 'drizzle-orm'
import { isLockedBlockType } from './block-types.ts'
import {
	DELETED_PAGE_VERSION_DAYS,
	MAX_WEBSITE_VERSIONS,
	type SnapshotSection,
	type VersionSummary,
	type WebsiteVersionKind,
} from './versions.ts'

/** `db`, or the `tx` of a `db.transaction` callback. */
export type VersionWriter = Pick<
	typeof db,
	'select' | 'update' | 'insert' | 'delete'
>

export type NewVersion = {
	id?: string
	organizationId: string
	pageId: string | null
	kind: WebsiteVersionKind
	title?: string | null
	slug?: string | null
	snapshot: string
	contentHash: string
	summary?: VersionSummary | null
	publishedById: string | null
	publishedAt?: Date
	restoredFromId?: string | null
}

/**
 * The INSERT of one version, optionally only while `onlyIf` holds. It is an
 * `INSERT ... SELECT` so the condition can be the same one that guards the
 * live write it belongs to: a publish that lost a race writes no history.
 * The column order is the table's definition order (drizzle inserts them all).
 */
export function insertVersionStatement(
	writer: Pick<typeof db, 'insert'>,
	version: NewVersion,
	onlyIf?: SQL,
) {
	const id = version.id ?? createId()
	const publishedAt = version.publishedAt ?? new Date()
	if (!onlyIf) {
		// Nothing to guard against: a plain INSERT.
		return {
			id,
			statement: writer.insert(WebsiteVersion).values({
				id,
				organizationId: version.organizationId,
				pageId: version.pageId,
				kind: version.kind,
				title: version.title ?? null,
				slug: version.slug ?? null,
				snapshot: version.snapshot,
				contentHash: version.contentHash,
				summary: version.summary ? JSON.stringify(version.summary) : null,
				publishedById: version.publishedById,
				publishedAt,
				restoredFromId: version.restoredFromId ?? null,
			}),
		}
	}
	const values = [
		id,
		version.organizationId,
		version.pageId,
		version.kind,
		version.title ?? null,
		version.slug ?? null,
		version.snapshot,
		version.contentHash,
		version.summary ? JSON.stringify(version.summary) : null,
		version.publishedById,
		publishedAt.getTime(),
		version.restoredFromId ?? null,
		null,
	]
	const select = sql`select ${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)} where ${onlyIf}`
	return { id, statement: writer.insert(WebsiteVersion).select(select) }
}

/**
 * Deletes a page's (or the site chrome's, or the theme's) versions beyond the
 * newest 50. The newest version is the live one and is always inside the kept
 * set; versions of a deleted page have their own 30 day purge.
 */
export function pruneVersionsStatement(
	writer: Pick<typeof db, 'delete'>,
	input: {
		organizationId: string
		kind: WebsiteVersionKind
		pageId: string | null
		keep?: number
	},
) {
	const keep = input.keep ?? MAX_WEBSITE_VERSIONS
	const samePage =
		input.pageId === null
			? sql`${WebsiteVersion.pageId} IS NULL`
			: sql`${WebsiteVersion.pageId} = ${input.pageId}`
	const scope = sql`${WebsiteVersion.organizationId} = ${input.organizationId} AND ${WebsiteVersion.kind} = ${input.kind} AND ${samePage} AND ${WebsiteVersion.deletedAt} IS NULL`
	return writer.delete(WebsiteVersion).where(
		sql`${scope} AND ${WebsiteVersion.id} NOT IN (
			SELECT ${WebsiteVersion.id} FROM ${WebsiteVersion}
			WHERE ${scope}
			ORDER BY ${WebsiteVersion.publishedAt} DESC, rowid DESC
			LIMIT ${keep}
		)`,
	)
}

/** A page's working sections (its draft), body only, in order. */
export async function loadDraftSections(
	pageId: string,
	writer: Pick<typeof db, 'select'> = db,
) {
	const rows = await writer
		.select({
			id: WebsitePageSection.id,
			type: WebsitePageSection.type,
			position: WebsitePageSection.position,
			config: WebsitePageSection.config,
		})
		.from(WebsitePageSection)
		.where(eq(WebsitePageSection.pageId, pageId))
		.orderBy(asc(WebsitePageSection.position))
	return rows.filter((row) => !isLockedBlockType(row.type))
}

/**
 * The statements that make a page's draft equal to `sections`: the body rows
 * are replaced, locked chrome is left alone. For one `db.batch`.
 */
export function replaceDraftSectionsStatements(
	pageId: string,
	sections: readonly SnapshotSection[],
) {
	const body = sections.filter((section) => !isLockedBlockType(section.type))
	const rows = body.map((section, index) => ({
		id: createId(),
		pageId,
		type: section.type,
		position: index,
		config: section.config,
	}))
	const lockedIds = db
		.select({ id: WebsitePageSection.id })
		.from(WebsitePageSection)
		.where(
			and(
				eq(WebsitePageSection.pageId, pageId),
				inArray(WebsitePageSection.type, ['header', 'footer']),
			),
		)
	const statements = [
		db
			.delete(WebsitePageSection)
			.where(
				and(
					eq(WebsitePageSection.pageId, pageId),
					sql`${WebsitePageSection.id} NOT IN ${lockedIds}`,
				),
			),
	]
	// D1 allows 100 bound parameters per statement: insert in small groups.
	const GROUP = 12
	for (let i = 0; i < rows.length; i += GROUP) {
		statements.push(
			db.insert(WebsitePageSection).values(rows.slice(i, i + GROUP)) as never,
		)
	}
	return statements
}

/** Marks every version of a deleted page, so the 30 day purge can find them. */
export function markPageVersionsDeletedStatement(
	writer: Pick<typeof db, 'update'>,
	organizationId: string,
	pageId: string,
	at = new Date(),
) {
	return writer
		.update(WebsiteVersion)
		.set({ deletedAt: at })
		.where(
			and(
				eq(WebsiteVersion.organizationId, organizationId),
				eq(WebsiteVersion.kind, 'page'),
				eq(WebsiteVersion.pageId, pageId),
				isNull(WebsiteVersion.deletedAt),
			),
		)
}

/** Versions of a page, newest first, with who published them. */
export async function listPageVersions(
	organizationId: string,
	input: { kind: WebsiteVersionKind; pageId: string | null },
	limit = MAX_WEBSITE_VERSIONS,
) {
	const samePage =
		input.pageId === null
			? isNull(WebsiteVersion.pageId)
			: eq(WebsiteVersion.pageId, input.pageId)
	return db.query.WebsiteVersion.findMany({
		where: and(
			eq(WebsiteVersion.organizationId, organizationId),
			eq(WebsiteVersion.kind, input.kind),
			samePage,
			isNull(WebsiteVersion.deletedAt),
		),
		orderBy: [desc(WebsiteVersion.publishedAt), sql`rowid DESC`],
		limit,
		with: { publishedBy: { columns: { name: true, username: true } } },
	})
}

/** The newest version of a page: the one that is live. */
export async function getLiveVersion(
	organizationId: string,
	input: { kind: WebsiteVersionKind; pageId: string | null },
) {
	const [live] = await listPageVersions(organizationId, input, 1)
	return live ?? null
}

/**
 * The daily purge (#85): versions of a page deleted more than 30 days ago go,
 * and any page, chrome or theme history that somehow holds more than 50
 * versions is cut back to the newest 50 (the live one is the newest).
 */
export async function purgeWebsiteVersions(now = new Date()) {
	const cutoff = new Date(
		now.getTime() - DELETED_PAGE_VERSION_DAYS * 86_400_000,
	)
	const purged = await db
		.delete(WebsiteVersion)
		.where(
			and(
				sql`${WebsiteVersion.deletedAt} IS NOT NULL`,
				sql`${WebsiteVersion.deletedAt} < ${cutoff.getTime()}`,
			),
		)
		.returning({ id: WebsiteVersion.id })
	const over = await db
		.select({
			organizationId: WebsiteVersion.organizationId,
			kind: WebsiteVersion.kind,
			pageId: WebsiteVersion.pageId,
		})
		.from(WebsiteVersion)
		.where(isNull(WebsiteVersion.deletedAt))
		.groupBy(
			WebsiteVersion.organizationId,
			WebsiteVersion.kind,
			WebsiteVersion.pageId,
		)
		.having(sql`count(*) > ${MAX_WEBSITE_VERSIONS}`)
	for (const group of over) {
		await pruneVersionsStatement(db, {
			organizationId: group.organizationId,
			kind: group.kind as WebsiteVersionKind,
			pageId: group.pageId,
		})
	}
	return { purged: purged.length, pruned: over.length }
}
