import {
	and,
	db,
	eq,
	or,
	sql,
	MarketingEmailTemplate,
	NoteComment,
	NoteCommentImage,
	Organization,
	OrganizationImage,
	OrganizationMenuItem,
	OrganizationMenuOption,
	OrganizationNote,
	OrganizationNoteUpload,
	SocialPost,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { type SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { getSourceLabel, type MediaReferenceItem } from './references.ts'

/** A name column may hold plain text or a locale-keyed JSON object. */
function localizedLabel(raw: string | null) {
	if (!raw) return 'Untitled'
	try {
		const parsed = JSON.parse(raw) as unknown
		if (parsed && typeof parsed === 'object') {
			const first = Object.values(parsed as Record<string, unknown>).find(
				(value) => typeof value === 'string' && value.trim(),
			)
			if (typeof first === 'string') return first
		}
	} catch {
		// plain text
	}
	return raw
}

// D1 rejects LIKE patterns over 50 bytes; object keys exceed that, so use instr().
export function configContains(value: string) {
	return sql`instr(${WebsitePageSection.config}, ${value}) > 0`
}

export function columnContains(column: SQLiteColumn, value: string) {
	return sql`instr(coalesce(${column}, ''), ${value}) > 0`
}

/**
 * A saved email template (#154) names an image by its library URL, which holds
 * the object key (raw or URL-encoded) or the asset id. A template keeps using
 * an image the library would otherwise delete.
 */
export function emailTemplateReferenceCondition(
	objectKey: string,
	assetId?: string,
) {
	return or(
		columnContains(MarketingEmailTemplate.blocks, objectKey),
		columnContains(
			MarketingEmailTemplate.blocks,
			encodeURIComponent(objectKey),
		),
		assetId
			? columnContains(MarketingEmailTemplate.blocks, assetId)
			: undefined,
	)
}

/**
 * Published page snapshots and SEO images keep using an object after the
 * draft sections stop referencing it. SEO image URLs store the key
 * URL-encoded.
 */
export function publishedPageReferenceCondition(
	objectKey: string,
	assetId?: string,
) {
	const needles = [objectKey, encodeURIComponent(objectKey)]
	if (assetId) needles.push(assetId)
	return or(
		...needles.flatMap((needle) => [
			columnContains(WebsitePage.publishedData, needle),
			columnContains(WebsitePage.seoImageUrl, needle),
		]),
	)
}

/**
 * A dish or option names its photos by library id or object key: `imageKey`,
 * the `imageKeys` list and, for a dish, a variant's `imageKey` inside the
 * `variations` JSON (#147). `imageUrl` is the legacy URL form.
 */
export function menuItemReferenceCondition(
	objectKey: string,
	assetId?: string,
) {
	const needles = [objectKey, encodeURIComponent(objectKey)]
	if (assetId) needles.push(assetId)
	return or(
		...needles.flatMap((needle) => [
			columnContains(OrganizationMenuItem.imageKey, needle),
			columnContains(OrganizationMenuItem.imageKeys, needle),
			columnContains(OrganizationMenuItem.imageUrl, needle),
			columnContains(OrganizationMenuItem.variations, needle),
		]),
	)
}

export function menuOptionReferenceCondition(
	objectKey: string,
	assetId?: string,
) {
	const needles = [objectKey, encodeURIComponent(objectKey)]
	if (assetId) needles.push(assetId)
	return or(
		...needles.map((needle) =>
			columnContains(OrganizationMenuOption.imageKey, needle),
		),
	)
}

/**
 * Every place an asset is used, for the "Used in" list and for the archive
 * guard (#147). Notes and comments are listed only when this member could
 * open the note.
 */
export async function findMediaReferences(input: {
	organizationId: string
	orgSlug: string
	userId: string
	asset: { id: string; objectKey: string; source: string }
}): Promise<MediaReferenceItem[]> {
	const { userId, asset } = input
	const organization = { id: input.organizationId }
	const params = { orgSlug: input.orgSlug }
	// Notes and comments are listed only when this member could open the
	// note (the notes-list rule): public, their own, or shared with them.
	const readableNote = or(
		eq(OrganizationNote.isPublic, true),
		eq(OrganizationNote.createdById, userId),
		sql`EXISTS (SELECT 1 FROM NoteAccess WHERE NoteAccess.noteId = ${OrganizationNote.id} AND NoteAccess.userId = ${userId})`,
	)

	// 1. Notes
	const noteRefs = await db
		.select({
			id: OrganizationNote.id,
			title: OrganizationNote.title,
			createdAt: OrganizationNoteUpload.createdAt,
		})
		.from(OrganizationNoteUpload)
		.innerJoin(
			OrganizationNote,
			eq(OrganizationNoteUpload.noteId, OrganizationNote.id),
		)
		.where(
			and(
				eq(OrganizationNoteUpload.objectKey, asset.objectKey),
				eq(OrganizationNote.organizationId, organization.id),
				readableNote,
			),
		)

	// 2. Comments
	const commentRefs = await db
		.select({
			commentId: NoteComment.id,
			content: NoteComment.content,
			noteId: OrganizationNote.id,
			noteTitle: OrganizationNote.title,
			createdAt: NoteCommentImage.createdAt,
		})
		.from(NoteCommentImage)
		.innerJoin(NoteComment, eq(NoteCommentImage.commentId, NoteComment.id))
		.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
		.where(
			and(
				eq(NoteCommentImage.objectKey, asset.objectKey),
				eq(OrganizationNote.organizationId, organization.id),
				readableNote,
			),
		)

	// 3. Organization Logo
	const orgLogoRefs = await db
		.select({
			id: OrganizationImage.id,
			createdAt: OrganizationImage.createdAt,
		})
		.from(OrganizationImage)
		.where(
			and(
				eq(OrganizationImage.objectKey, asset.objectKey),
				eq(OrganizationImage.organizationId, organization.id),
			),
		)

	// 4. Site Icon
	const siteIconRefs = await db
		.select({
			id: Organization.id,
			name: Organization.name,
		})
		.from(Organization)
		.where(
			and(
				eq(Organization.id, organization.id),
				eq(Organization.siteIconKey, asset.objectKey),
			),
		)

	// 5. Website Pages
	const pageRefs = await db
		.select({
			pageId: WebsitePage.id,
			pageTitle: WebsitePage.title,
			pageSlug: WebsitePage.slug,
			sectionType: WebsitePageSection.type,
		})
		.from(WebsitePageSection)
		.innerJoin(WebsitePage, eq(WebsitePageSection.pageId, WebsitePage.id))
		.where(
			and(
				eq(WebsitePage.organizationId, organization.id),
				or(configContains(asset.objectKey), configContains(asset.id)),
			),
		)

	const references: MediaReferenceItem[] = []

	for (const note of noteRefs) {
		references.push({
			id: `note-${note.id}`,
			type: 'note',
			title: note.title || 'Untitled note',
			subtitle: 'Attached to organization note',
			url: `/${params.orgSlug}/notes/${note.id}`,
			createdAt: note.createdAt.toISOString(),
		})
	}

	for (const c of commentRefs) {
		references.push({
			id: `comment-${c.commentId}`,
			type: 'comment',
			title: `Comment on "${c.noteTitle || 'Untitled note'}"`,
			subtitle: c.content ? c.content.slice(0, 80) : undefined,
			url: `/${params.orgSlug}/notes/${c.noteId}`,
			createdAt: c.createdAt.toISOString(),
		})
	}

	for (const logo of orgLogoRefs) {
		references.push({
			id: `logo-${logo.id}`,
			type: 'logo',
			title: 'Organization Logo',
			subtitle: 'Current organization branding logo',
			url: `/${params.orgSlug}/settings/organization`,
			createdAt: logo.createdAt.toISOString(),
		})
	}

	for (const org of siteIconRefs) {
		references.push({
			id: `site-icon-${org.id}`,
			type: 'site-icon',
			title: 'Site Icon / Favicon',
			subtitle: 'Used as the published site icon',
			url: `/${params.orgSlug}/website`,
		})
	}

	const seenPages = new Set<string>()
	for (const p of pageRefs) {
		if (seenPages.has(p.pageId)) continue
		seenPages.add(p.pageId)
		references.push({
			id: `page-${p.pageId}`,
			type: 'page',
			title: `Website Page: ${p.pageTitle || p.pageSlug}`,
			subtitle: `Used in page section (${p.sectionType}) on /${p.pageSlug}`,
			url: `/${params.orgSlug}/website/pages/${p.pageId}`,
		})
	}

	// Published snapshots and SEO images can still use an image the draft
	// no longer shows.
	const publishedPageRefs = await db
		.select({
			pageId: WebsitePage.id,
			pageTitle: WebsitePage.title,
			pageSlug: WebsitePage.slug,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.organizationId, organization.id),
				publishedPageReferenceCondition(asset.objectKey, asset.id),
			),
		)
	for (const p of publishedPageRefs) {
		if (seenPages.has(p.pageId)) continue
		seenPages.add(p.pageId)
		references.push({
			id: `page-${p.pageId}`,
			type: 'page',
			title: `Website Page: ${p.pageTitle || p.pageSlug}`,
			subtitle: `Used on the published page or as its SEO image on /${p.pageSlug}`,
			url: `/${params.orgSlug}/website/pages/${p.pageId}`,
		})
	}

	const socialPostRefs = await db
		.select({ id: SocialPost.id, createdAt: SocialPost.createdAt })
		.from(SocialPost)
		.where(
			and(
				eq(SocialPost.organizationId, organization.id),
				columnContains(SocialPost.media, asset.id),
			),
		)
	for (const post of socialPostRefs) {
		references.push({
			id: `social-${post.id}`,
			type: 'social-post',
			title: 'Social media post',
			subtitle: 'Attached to a social media post',
			url: `/${params.orgSlug}/marketing/social/${post.id}`,
			createdAt: post.createdAt.toISOString(),
		})
	}

	const templateRefs = await db
		.select({
			id: MarketingEmailTemplate.id,
			name: MarketingEmailTemplate.name,
			updatedAt: MarketingEmailTemplate.updatedAt,
		})
		.from(MarketingEmailTemplate)
		.where(
			and(
				eq(MarketingEmailTemplate.organizationId, organization.id),
				emailTemplateReferenceCondition(asset.objectKey, asset.id),
			),
		)
	for (const template of templateRefs) {
		references.push({
			id: `email-template-${template.id}`,
			type: 'email-template',
			title: `Email template: ${template.name}`,
			subtitle: 'Used in a saved email template',
			url: `/${params.orgSlug}/marketing/templates`,
			createdAt: template.updatedAt.toISOString(),
		})
	}

	const dishRefs = await db
		.select({
			id: OrganizationMenuItem.id,
			name: OrganizationMenuItem.displayName,
		})
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.organizationId, organization.id),
				menuItemReferenceCondition(asset.objectKey, asset.id),
			),
		)
	for (const dish of dishRefs) {
		references.push({
			id: `menu-item-${dish.id}`,
			type: 'menu-item',
			title: `Dish: ${localizedLabel(dish.name)}`,
			subtitle: 'Used as a dish photo',
			url: `/${params.orgSlug}/menu/items/${dish.id}`,
		})
	}

	const optionRefs = await db
		.select({
			id: OrganizationMenuOption.id,
			name: OrganizationMenuOption.displayName,
		})
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.organizationId, organization.id),
				menuOptionReferenceCondition(asset.objectKey, asset.id),
			),
		)
	for (const option of optionRefs) {
		references.push({
			id: `menu-option-${option.id}`,
			type: 'menu-option',
			title: `Option: ${localizedLabel(option.name)}`,
			subtitle: 'Used as an option photo',
			url: `/${params.orgSlug}/menu/options/${option.id}`,
		})
	}

	if (references.length === 0 && asset.source && asset.source !== 'library') {
		references.push({
			id: 'source-origin',
			type: 'source',
			title: `Origin: ${getSourceLabel(asset.source)}`,
			subtitle: `Uploaded originally via ${getSourceLabel(asset.source)}.`,
		})
	}

	return references
}
