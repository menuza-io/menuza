import {
	and,
	asc,
	db,
	eq,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { type SQL } from 'drizzle-orm'
import { isLockedBlockType } from './block-types.ts'

/** `db`, or the `tx` of a `db.transaction` callback. */
type PageWriter = Pick<typeof db, 'select' | 'update'>

/**
 * Publish a website page: set it published and store a snapshot of its
 * sections in `publishedData`. The public site serves that snapshot, never the
 * `WebsitePageSection` rows, which are the editor's working copy, so later
 * edits stay private until the page is published again. Locked chrome (header,
 * footer) is left out: the site adds the organization's own.
 *
 * Every path that makes a page published must go through here.
 */
export async function publishWebsitePage(
	pageId: string,
	writer: PageWriter = db,
) {
	const { update } = await buildPublishWebsitePageUpdate(pageId, writer)
	await update
}

/**
 * Reads the page's sections and returns the publishing UPDATE without running
 * it, so a caller can put it in a `db.batch` with other writes. `onlyIf` adds
 * a condition the update must meet when it runs. The query is wrapped in an
 * object because awaiting a query builder runs it.
 */
export async function buildPublishWebsitePageUpdate(
	pageId: string,
	writer: PageWriter = db,
	onlyIf?: SQL,
) {
	const sections = await writer
		.select({
			id: WebsitePageSection.id,
			type: WebsitePageSection.type,
			position: WebsitePageSection.position,
			config: WebsitePageSection.config,
		})
		.from(WebsitePageSection)
		.where(eq(WebsitePageSection.pageId, pageId))
		.orderBy(asc(WebsitePageSection.position))
	const publishedSections = sections.filter(
		(section) => !isLockedBlockType(section.type),
	)
	const update = writer
		.update(WebsitePage)
		.set({
			status: 'published',
			publishedData: JSON.stringify(publishedSections),
		})
		.where(and(eq(WebsitePage.id, pageId), onlyIf))
	return { update }
}
