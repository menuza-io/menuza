import { createId } from '@paralleldrive/cuid2'
import {
	and,
	asc,
	between,
	db,
	desc,
	eq,
	inArray,
	isD1Bound,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	OrganizationMediaAsset,
	SocialAccount,
	SocialPost,
	SocialPostTarget,
	sql,
} from '@repo/database'
import { signMediaId } from '#app/utils/media-signing.server.ts'
import {
	markSocialAccountNeedsReauth,
	readSocialAccountForPublishing,
} from './accounts.server.ts'
import { isSocialMock, socialEnv } from './env.server.ts'
import { SocialError } from './errors.ts'
import { publishToFacebook, publishToInstagram } from './meta.server.ts'
import {
	SOCIAL_MAX_MEDIA,
	settledPostStatus,
	type SocialPlatform,
	type SocialPostMedia,
	type SocialPostStatus,
	type SocialTargetStatus,
} from './platforms.ts'

/**
 * Social posts: drafts, scheduled posts and what happened on each account.
 * A post is claimed (`scheduled` to `publishing`) by one caller only, so the
 * scheduled publisher and Publish now never send it twice. A target interrupted
 * mid-send is marked failed rather than sent again: the platform may already
 * show it.
 */

const EDITABLE_STATUSES = ['draft', 'scheduled'] as const
const RETRYABLE_STATUSES = ['failed', 'partial'] as const

function socialPostRevisionGuard(postId: string, updatedAtMs: number) {
	return sql`exists (select 1 from ${SocialPost} as p where p.id = ${postId} and p."updatedAt" = ${updatedAtMs} and p.status in ('draft', 'scheduled'))`
}

/** D1 allows 100 bound parameters per statement; a target row binds several fields. */
const TARGET_INSERT_CHUNK = 10

function chunkRows<T>(rows: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
	return out
}

type SocialPostTargetRow = {
	postId: string
	socialAccountId: string
	platform: SocialPlatform
	accountName: string
}

function socialPostTargetInsertStatements(
	postId: string,
	targets: Omit<SocialPostTargetRow, 'postId'>[],
) {
	return chunkRows(
		targets.map((target) => ({ postId, ...target })),
		TARGET_INSERT_CHUNK,
	).map((rows) => db.insert(SocialPostTarget).values(rows))
}

/** A post still `publishing` after this long was interrupted. */
const STALE_PUBLISHING_MS = 15 * 60_000

/** Signed media links handed to Meta stay valid this long. */
const MEDIA_LINK_TTL_SECONDS = 60 * 60

export type SocialPostInput = {
	body: string
	mediaIds: string[]
	accountIds: string[]
	status: 'draft' | 'scheduled'
	scheduledAt: Date | null
}

export type SocialPostTargetView = {
	id: string
	socialAccountId: string | null
	platform: SocialPlatform
	accountName: string
	status: SocialTargetStatus
	permalink: string | null
	error: string | null
	publishedAt: Date | null
}

export type SocialPostView = {
	id: string
	body: string
	media: SocialPostMedia[]
	status: SocialPostStatus
	scheduledAt: Date | null
	publishedAt: Date | null
	createdAt: Date
	updatedAt: Date
	targets: SocialPostTargetView[]
}

export class SocialPostConflict extends Error {}

function mediaUrl(id: string) {
	return `/resources/images?mediaId=${encodeURIComponent(id)}`
}

/** The org's images, in the order given. Unknown or non-image ids are dropped. */
export async function resolveSocialMedia(
	organizationId: string,
	mediaIds: string[],
): Promise<SocialPostMedia[]> {
	const ids = [...new Set(mediaIds)].slice(0, SOCIAL_MAX_MEDIA)
	if (ids.length === 0) return []
	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			mimeType: OrganizationMediaAsset.mimeType,
			altText: OrganizationMediaAsset.altText,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				inArray(OrganizationMediaAsset.id, ids),
			),
		)
	const byId = new Map(rows.map((row) => [row.id, row]))
	return ids.flatMap((id) => {
		const row = byId.get(id)
		if (
			!row ||
			!row.mimeType.startsWith('image/') ||
			row.mimeType.includes('svg')
		) {
			return []
		}
		return [{ mediaId: id, url: mediaUrl(id), altText: row.altText ?? null }]
	})
}

export async function resolveSocialAccounts(
	organizationId: string,
	accountIds: string[],
) {
	const ids = [...new Set(accountIds)]
	if (ids.length === 0) return []
	const rows = await db
		.select({
			id: SocialAccount.id,
			platform: SocialAccount.platform,
			name: SocialAccount.name,
			username: SocialAccount.username,
		})
		.from(SocialAccount)
		.where(
			and(
				eq(SocialAccount.organizationId, organizationId),
				inArray(SocialAccount.id, ids),
			),
		)
	return rows.map((row) => ({
		...row,
		platform: row.platform as SocialPlatform,
	}))
}

/**
 * Creates a post, or replaces a draft or scheduled one. Accounts and images
 * must belong to the organization. Throws `SocialPostConflict` when the post
 * has started publishing meanwhile.
 */
export async function saveSocialPost(
	owner: { userId: string; organization: { id: string } },
	input: SocialPostInput,
	postId?: string,
): Promise<{ id: string; media: SocialPostMedia[] }> {
	const organizationId = owner.organization.id
	const [media, accounts] = await Promise.all([
		resolveSocialMedia(organizationId, input.mediaIds),
		resolveSocialAccounts(organizationId, input.accountIds),
	])
	const values = {
		body: input.body,
		media,
		status: input.status,
		scheduledAt: input.scheduledAt,
		publishedAt: null,
	}
	const targets = accounts.map((account) => ({
		socialAccountId: account.id,
		platform: account.platform,
		accountName: account.username ? `@${account.username}` : account.name,
	}))

	if (postId) {
		if (isD1Bound()) {
			const saveStamp = Date.now()
			const updatePost = db
				.update(SocialPost)
				.set({ ...values, updatedAt: new Date(saveStamp) })
				.where(
					and(
						eq(SocialPost.id, postId),
						eq(SocialPost.organizationId, organizationId),
						inArray(SocialPost.status, [...EDITABLE_STATUSES]),
					),
				)
				.returning({ id: SocialPost.id })
			const deleteTargets = db
				.delete(SocialPostTarget)
				.where(
					and(
						eq(SocialPostTarget.postId, postId),
						socialPostRevisionGuard(postId, saveStamp),
					),
				)
			const targetInserts = socialPostTargetInsertStatements(postId, targets)
			const batchResult = await db.batch([
				updatePost,
				deleteTargets,
				...targetInserts,
			])
			const updatedRows = batchResult[0] as { id: string }[] | undefined
			if (!updatedRows?.[0]?.id) throw new SocialPostConflict()
		} else {
			await db.transaction(async (tx) => {
				const [updated] = await tx
					.update(SocialPost)
					.set(values)
					.where(
						and(
							eq(SocialPost.id, postId),
							eq(SocialPost.organizationId, organizationId),
							inArray(SocialPost.status, [...EDITABLE_STATUSES]),
						),
					)
					.returning({ id: SocialPost.id })
				if (!updated) throw new SocialPostConflict()
				await tx
					.delete(SocialPostTarget)
					.where(eq(SocialPostTarget.postId, postId))
				if (targets.length > 0) {
					await tx
						.insert(SocialPostTarget)
						.values(targets.map((target) => ({ postId, ...target })))
				}
			})
		}

		return { id: postId, media }
	}

	if (isD1Bound()) {
		const newId = createId()
		const insertPost = db.insert(SocialPost).values({
			id: newId,
			organizationId,
			createdById: owner.userId,
			...values,
		})
		const targetInserts = socialPostTargetInsertStatements(newId, targets)
		if (targetInserts.length === 0) {
			await insertPost
		} else {
			await db.batch([insertPost, ...targetInserts])
		}
		return { id: newId, media }
	}

	const newId = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(SocialPost)
			.values({ organizationId, createdById: owner.userId, ...values })
			.returning({ id: SocialPost.id })
		const id = created!.id
		if (targets.length > 0) {
			await tx
				.insert(SocialPostTarget)
				.values(targets.map((target) => ({ postId: id, ...target })))
		}
		return id
	})
	return { id: newId, media }
}

async function targetsOf(postIds: string[]) {
	if (postIds.length === 0) return new Map<string, SocialPostTargetView[]>()
	const rows = await db
		.select({
			id: SocialPostTarget.id,
			postId: SocialPostTarget.postId,
			socialAccountId: SocialPostTarget.socialAccountId,
			platform: SocialPostTarget.platform,
			accountName: SocialPostTarget.accountName,
			status: SocialPostTarget.status,
			permalink: SocialPostTarget.permalink,
			error: SocialPostTarget.error,
			publishedAt: SocialPostTarget.publishedAt,
		})
		.from(SocialPostTarget)
		.where(inArray(SocialPostTarget.postId, postIds))
		.orderBy(asc(SocialPostTarget.platform), asc(SocialPostTarget.accountName))
	const byPost = new Map<string, SocialPostTargetView[]>()
	for (const { postId, ...target } of rows) {
		const list = byPost.get(postId) ?? []
		list.push(target as SocialPostTargetView)
		byPost.set(postId, list)
	}
	return byPost
}

const postColumns = {
	id: SocialPost.id,
	body: SocialPost.body,
	media: SocialPost.media,
	status: SocialPost.status,
	scheduledAt: SocialPost.scheduledAt,
	publishedAt: SocialPost.publishedAt,
	createdAt: SocialPost.createdAt,
	updatedAt: SocialPost.updatedAt,
}

type PostRow = {
	id: string
	body: string
	media: unknown
	status: string
	scheduledAt: Date | null
	publishedAt: Date | null
	createdAt: Date
	updatedAt: Date
}

/** D1 binds at most 100 parameters, so targets are read in chunks. */
async function withTargets(rows: PostRow[]): Promise<SocialPostView[]> {
	const byPost = new Map<string, SocialPostTargetView[]>()
	for (let i = 0; i < rows.length; i += 90) {
		const chunk = await targetsOf(rows.slice(i, i + 90).map((row) => row.id))
		for (const [id, targets] of chunk) byPost.set(id, targets)
	}
	return rows.map((row) => ({
		...row,
		media: Array.isArray(row.media) ? (row.media as SocialPostMedia[]) : [],
		status: row.status as SocialPostStatus,
		targets: byPost.get(row.id) ?? [],
	}))
}

export async function getSocialPost(
	organizationId: string,
	postId: string,
): Promise<SocialPostView | null> {
	const [row] = await db
		.select(postColumns)
		.from(SocialPost)
		.where(
			and(
				eq(SocialPost.id, postId),
				eq(SocialPost.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row) return null
	const [post] = await withTargets([row])
	return post ?? null
}

/**
 * Posts on the calendar between two instants: published ones at the time
 * they went out, the others at their scheduled time.
 */
export async function listSocialPostsBetween(
	organizationId: string,
	from: Date,
	to: Date,
): Promise<SocialPostView[]> {
	const rows = await db
		.select(postColumns)
		.from(SocialPost)
		.where(
			and(
				eq(SocialPost.organizationId, organizationId),
				or(
					and(
						isNotNull(SocialPost.publishedAt),
						between(SocialPost.publishedAt, from, to),
					),
					and(
						isNull(SocialPost.publishedAt),
						between(SocialPost.scheduledAt, from, to),
					),
				),
			),
		)
		.orderBy(asc(SocialPost.scheduledAt))
		.limit(1000)
	return withTargets(rows)
}

/** Drafts without a date: they have no place on the calendar. */
export async function listUndatedSocialDrafts(
	organizationId: string,
): Promise<SocialPostView[]> {
	const rows = await db
		.select(postColumns)
		.from(SocialPost)
		.where(
			and(
				eq(SocialPost.organizationId, organizationId),
				eq(SocialPost.status, 'draft'),
				isNull(SocialPost.scheduledAt),
			),
		)
		.orderBy(desc(SocialPost.updatedAt))
		.limit(50)
	return withTargets(rows)
}

/** Deletes a post here; anything already on Facebook or Instagram stays. */
export async function deleteSocialPost(
	organizationId: string,
	postId: string,
): Promise<boolean> {
	const deleted = await db
		.delete(SocialPost)
		.where(
			and(
				eq(SocialPost.id, postId),
				eq(SocialPost.organizationId, organizationId),
				inArray(SocialPost.status, [
					'draft',
					'scheduled',
					'published',
					'partial',
					'failed',
				]),
			),
		)
		.returning({ id: SocialPost.id })
	return deleted.length > 0
}

/** Sends the failed accounts of a post again, now. */
export async function retrySocialPost(
	organizationId: string,
	postId: string,
): Promise<boolean> {
	const now = new Date()
	const reopened = await db.transaction(async (tx) => {
		const updated = await tx
			.update(SocialPost)
			.set({ status: 'scheduled', scheduledAt: now })
			.where(
				and(
					eq(SocialPost.id, postId),
					eq(SocialPost.organizationId, organizationId),
					inArray(SocialPost.status, [...RETRYABLE_STATUSES]),
				),
			)
			.returning({ id: SocialPost.id })
		if (updated.length === 0) return false
		await tx
			.update(SocialPostTarget)
			.set({ status: 'pending', error: null })
			.where(
				and(
					eq(SocialPostTarget.postId, postId),
					eq(SocialPostTarget.status, 'failed'),
				),
			)
		return true
	})
	if (!reopened) return false
	await publishSocialPost(postId, now)
	return true
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * A link Meta can fetch: signed (the media library is private), converted to
 * JPEG (Instagram takes no other image format).
 */
function publicImageUrl(mediaId: string): string {
	const expires = Math.floor(Date.now() / 1000) + MEDIA_LINK_TTL_SECONDS
	const url = new URL('/resources/images', socialEnv('BASE_URL'))
	url.searchParams.set('mediaId', mediaId)
	url.searchParams.set('expires', String(expires))
	url.searchParams.set('sig', signMediaId(mediaId, expires))
	url.searchParams.set('format', 'jpeg')
	return url.toString()
}

type ClaimedPost = {
	id: string
	organizationId: string
	body: string
	media: unknown
}

async function deliverTarget(
	post: ClaimedPost,
	target: { id: string; socialAccountId: string | null },
) {
	const [claimed] = await db
		.update(SocialPostTarget)
		.set({
			status: 'publishing',
			attempts: sql`${SocialPostTarget.attempts} + 1`,
		})
		.where(
			and(
				eq(SocialPostTarget.id, target.id),
				eq(SocialPostTarget.status, 'pending'),
			),
		)
		.returning({ id: SocialPostTarget.id })
	if (!claimed) return

	let accountId: string | null = null
	try {
		const account = target.socialAccountId
			? await readSocialAccountForPublishing(target.socialAccountId)
			: null
		if (
			!account ||
			account.organizationId !== post.organizationId ||
			!account.accessToken
		) {
			throw new SocialError('unauthorized', 'disconnected')
		}
		if (account.status === 'needs_reauth') {
			throw new SocialError('unauthorized', 'needs_reauth')
		}
		accountId = account.id
		const media = Array.isArray(post.media)
			? (post.media as SocialPostMedia[])
			: []
		const input = {
			body: post.body,
			imageUrls: isSocialMock()
				? media.map((item) => item.url)
				: media.map((item) => publicImageUrl(item.mediaId)),
		}
		const publishing = {
			externalId: account.externalId,
			accessToken: account.accessToken,
		}
		const result =
			account.platform === 'instagram'
				? await publishToInstagram(publishing, input)
				: await publishToFacebook(publishing, input)
		await db
			.update(SocialPostTarget)
			.set({
				status: 'published',
				externalPostId: result.externalPostId,
				permalink: result.permalink,
				publishedAt: new Date(),
				error: null,
			})
			.where(eq(SocialPostTarget.id, target.id))
	} catch (error) {
		if (!(error instanceof SocialError)) {
			console.error('Social post target failed', {
				postId: post.id,
				targetId: target.id,
				error: error instanceof Error ? error.name : 'unknown',
			})
		}
		if (
			error instanceof SocialError &&
			error.code === 'unauthorized' &&
			accountId
		) {
			await markSocialAccountNeedsReauth(accountId)
		}
		const message = error instanceof SocialError ? error.message : 'unexpected'
		await db
			.update(SocialPostTarget)
			.set({ status: 'failed', error: message.slice(0, 500) })
			.where(eq(SocialPostTarget.id, target.id))
	}
}

/** Sends every pending target of a claimed post, then settles its status. */
async function deliver(post: ClaimedPost) {
	const targets = await db
		.select({
			id: SocialPostTarget.id,
			socialAccountId: SocialPostTarget.socialAccountId,
		})
		.from(SocialPostTarget)
		.where(
			and(
				eq(SocialPostTarget.postId, post.id),
				eq(SocialPostTarget.status, 'pending'),
			),
		)
	await Promise.all(targets.map((target) => deliverTarget(post, target)))

	const settled = await db
		.select({
			status: SocialPostTarget.status,
			publishedAt: SocialPostTarget.publishedAt,
		})
		.from(SocialPostTarget)
		.where(eq(SocialPostTarget.postId, post.id))
	if (
		settled.some((t) => t.status === 'pending' || t.status === 'publishing')
	) {
		return
	}
	const status = settledPostStatus(settled)
	const firstPublished = settled
		.map((t) => t.publishedAt?.getTime() ?? Infinity)
		.reduce((min, time) => Math.min(min, time), Infinity)
	await db
		.update(SocialPost)
		.set({
			status,
			publishedAt: Number.isFinite(firstPublished)
				? new Date(firstPublished)
				: null,
		})
		.where(and(eq(SocialPost.id, post.id), eq(SocialPost.status, 'publishing')))
}

/**
 * Publishes a scheduled post whose time has come. Returns false when it is
 * not due, or another caller already claimed it.
 */
export async function publishSocialPost(
	postId: string,
	now = new Date(),
): Promise<boolean> {
	const [claimed] = await db
		.update(SocialPost)
		.set({ status: 'publishing' })
		.where(
			and(
				eq(SocialPost.id, postId),
				eq(SocialPost.status, 'scheduled'),
				lte(SocialPost.scheduledAt, now),
			),
		)
		.returning({
			id: SocialPost.id,
			organizationId: SocialPost.organizationId,
			body: SocialPost.body,
			media: SocialPost.media,
		})
	if (!claimed) return false
	await deliver(claimed)
	return true
}

/**
 * The scheduled publisher: finishes interrupted posts (their in-flight targets are
 * marked failed, never sent twice), then publishes the posts that are due.
 */
export async function publishDueSocialPosts(
	now = new Date(),
	limit = 25,
): Promise<{ published: number; recovered: number }> {
	const stale = await db
		.select({
			id: SocialPost.id,
			organizationId: SocialPost.organizationId,
			body: SocialPost.body,
			media: SocialPost.media,
		})
		.from(SocialPost)
		.where(
			and(
				eq(SocialPost.status, 'publishing'),
				lt(SocialPost.updatedAt, new Date(now.getTime() - STALE_PUBLISHING_MS)),
			),
		)
		.limit(limit)
	for (const post of stale) {
		await db
			.update(SocialPostTarget)
			.set({
				status: 'failed',
				error: 'interrupted',
			})
			.where(
				and(
					eq(SocialPostTarget.postId, post.id),
					eq(SocialPostTarget.status, 'publishing'),
				),
			)
		await deliver(post)
	}

	const due = await db
		.select({ id: SocialPost.id })
		.from(SocialPost)
		.where(
			and(eq(SocialPost.status, 'scheduled'), lte(SocialPost.scheduledAt, now)),
		)
		.orderBy(asc(SocialPost.scheduledAt))
		.limit(limit)
	let published = 0
	for (const { id } of due) {
		if (await publishSocialPost(id, now)) published++
	}
	return { published, recovered: stale.length }
}
