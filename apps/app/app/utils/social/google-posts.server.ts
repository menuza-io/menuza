/**
 * Google Business Profile as a social channel (#135, flag `social.google`).
 * One publisher: this module plugs into `posts.server.ts` (the Meta
 * publisher's `deliverTarget`), never replaces it. The Google token stays on
 * the linked `Integration`; a `google_business` `SocialAccount` holds only the
 * Google location name and a marker.
 *
 *  - `syncGoogleSocialAccounts` makes every linked Google location a postable
 *    account (and marks one `needs_reauth` while its connection is broken).
 *  - `publishToGoogle` checks the connection FIRST: a broken connection fails
 *    without calling Google. It checks the post again (text length, offer and
 *    event dates, image) before sending the `localPosts` body.
 *  - Google may hold a post for review: the target stays `published` with
 *    `reviewState: 'pending'` until the hourly sweep sees it live or rejected.
 *  - Deleting a post here deletes nothing on Google unless the operator picks
 *    "Remove from Google" (`removePostFromGoogle`).
 */
import { getFeatureFlag } from '@repo/common/feature-flags'
import { GBP_FLAGS, GbpError } from '@repo/common/gbp-listing'
import {
	and,
	db,
	eq,
	GbpLocationSync,
	inArray,
	Integration,
	Organization,
	OrganizationLocation,
	OrganizationMediaAsset,
	SocialAccount,
	SocialPost,
	SocialPostTarget,
	Discount,
	DiscountCode,
} from '@repo/database'
import {
	type GbpClient,
	gbpClientFor,
	resolveGbpAccountName,
} from '@repo/integrations'
import { encryptAsync, getEncryptionKey } from '@repo/security'
import { SocialError } from './errors.ts'
import {
	type GooglePostDetails,
	type GoogleTopicType,
	buildLocalPostBody,
	googlePostProblems,
	isGoogleTopicType,
	parseGooglePostDetails,
} from './google-post.ts'
import { settledPostStatus } from './platforms.ts'
import { publicImageUrl } from './posts.server.ts'

const key = () => getEncryptionKey('INTEGRATION_ENCRYPTION_KEY')
const ACCOUNT_MARKER = 'google-business-integration'

export async function isGoogleSocialEnabled(organizationId: string) {
	return (
		(await getFeatureFlag(GBP_FLAGS.socialGoogle, { organizationId })) === true
	)
}

function connectionReady(sync: {
	state: string
	verificationState: string
}): boolean {
	return (
		sync.state === 'ok' &&
		sync.verificationState !== 'unverified' &&
		sync.verificationState !== 'pending'
	)
}

/** The error code the target shows for a Google connection that is not ready. */
export function googleConnectionError(sync: {
	state: string
	verificationState: string
}): string {
	if (sync.state === 'suspended') return 'google_suspended'
	if (sync.state === 'access_lost') return 'google_access_lost'
	if (sync.state === 'not_verified' || sync.verificationState !== 'verified') {
		return sync.state === 'token_expired'
			? 'google_reconnect'
			: 'google_not_verified'
	}
	return 'google_reconnect'
}

/**
 * Every Google location linked through the integration becomes a social
 * account; a location whose link is gone loses it. The status follows the
 * connection: anything but healthy is `needs_reauth` ("Reconnect needed").
 */
export async function syncGoogleSocialAccounts(
	organizationId: string,
): Promise<number> {
	if (!(await isGoogleSocialEnabled(organizationId))) return 0
	const rows = await db
		.select({
			sync: GbpLocationSync,
			locationName: OrganizationLocation.name,
			integrationActive: Integration.isActive,
		})
		.from(GbpLocationSync)
		.innerJoin(
			OrganizationLocation,
			eq(OrganizationLocation.id, GbpLocationSync.organizationLocationId),
		)
		.leftJoin(Integration, eq(Integration.id, GbpLocationSync.integrationId))
		.where(eq(GbpLocationSync.organizationId, organizationId))
	const existing = await db
		.select()
		.from(SocialAccount)
		.where(
			and(
				eq(SocialAccount.organizationId, organizationId),
				eq(SocialAccount.platform, 'google_business'),
			),
		)
	const marker = await encryptAsync(ACCOUNT_MARKER, key())
	const linked = new Set<string>()
	for (const row of rows) {
		if (!row.integrationActive) continue
		linked.add(row.sync.googleLocationName)
		const status = connectionReady(row.sync) ? 'active' : 'needs_reauth'
		const current = existing.find(
			(account) => account.externalId === row.sync.googleLocationName,
		)
		if (!current) {
			await db
				.insert(SocialAccount)
				.values({
					organizationId,
					platform: 'google_business',
					externalId: row.sync.googleLocationName,
					name: row.locationName.slice(0, 200),
					accessToken: marker,
					status,
					organizationLocationId: row.sync.organizationLocationId,
				})
				.onConflictDoNothing()
		} else if (
			current.status !== status ||
			current.name !== row.locationName.slice(0, 200)
		) {
			await db
				.update(SocialAccount)
				.set({ status, name: row.locationName.slice(0, 200) })
				.where(eq(SocialAccount.id, current.id))
		}
	}
	for (const account of existing) {
		if (!linked.has(account.externalId)) {
			await db.delete(SocialAccount).where(eq(SocialAccount.id, account.id))
		}
	}
	return linked.size
}

export type GooglePublishInput = {
	post: {
		id: string
		organizationId: string
		body: string
		media: unknown
		googleTopicType: string | null
		googleDetails: string | null
	}
	account: {
		id: string
		organizationId: string
		externalId: string
		organizationLocationId: string | null
	}
	client?: GbpClient
}

export type GooglePublishResult = {
	externalPostId: string
	permalink: string | null
	reviewState: 'pending' | 'live'
}

async function mediaFacts(organizationId: string, media: unknown) {
	const ids = Array.isArray(media)
		? (media as Array<{ mediaId?: string }>).flatMap((item) =>
				item.mediaId ? [item.mediaId] : [],
			)
		: []
	if (ids.length === 0) return { ids, facts: [] }
	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			mimeType: OrganizationMediaAsset.mimeType,
			width: OrganizationMediaAsset.width,
			height: OrganizationMediaAsset.height,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				inArray(OrganizationMediaAsset.id, ids),
			),
		)
	return {
		ids: rows.map((row) => row.id),
		facts: rows.map((row) => ({
			mimeType: row.mimeType,
			width: row.width,
			height: row.height,
		})),
	}
}

/**
 * Whether a coupon can be redeemed online right now: an active, unarchived
 * code of a discount that is on, inside its dates, with an online channel.
 */
export async function couponValidOnline(
	organizationId: string,
	code: string,
	now = new Date(),
): Promise<boolean> {
	const normalized = code.toUpperCase().replace(/[\s-]/g, '')
	const [row] = await db
		.select({
			status: Discount.status,
			channels: Discount.channels,
			endsAt: Discount.endsAt,
			archivedAt: DiscountCode.archivedAt,
		})
		.from(DiscountCode)
		.innerJoin(Discount, eq(Discount.id, DiscountCode.discountId))
		.where(
			and(
				eq(DiscountCode.organizationId, organizationId),
				eq(DiscountCode.normalizedCode, normalized),
			),
		)
		.limit(1)
	if (!row || row.archivedAt || row.status !== 'active') return false
	const channels = safeParse(row.channels)
	// Valid online means the website (or QR ordering) can redeem it.
	if (
		!Array.isArray(channels) ||
		!channels.some((channel) => channel === 'web' || channel === 'qr')
	) {
		return false
	}
	// `endsAt` is a local date-time; the day is close enough to refuse an
	// offer that has clearly ended.
	if (row.endsAt && row.endsAt.slice(0, 10) < now.toISOString().slice(0, 10)) {
		return false
	}
	return true
}

function safeParse(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

/** Server-side check of a Google post (the composer runs the same rules). */
export async function googlePostServerProblems(input: {
	organizationId: string
	body: string
	topicType: GoogleTopicType
	details: GooglePostDetails
	media: unknown
}) {
	const { facts } = await mediaFacts(input.organizationId, input.media)
	const problems = googlePostProblems({
		body: input.body,
		topicType: input.topicType,
		details: input.details,
		media: facts,
	})
	const code = input.details.offer?.couponCode
	if (
		input.topicType === 'OFFER' &&
		code &&
		!(await couponValidOnline(input.organizationId, code))
	) {
		problems.push('coupon_not_valid_online')
	}
	return problems
}

/**
 * Publishes one post to one Google location. A connection that is not
 * healthy fails BEFORE any Google call (`unauthorized`, with our own code).
 */
export async function publishToGoogle(
	input: GooglePublishInput,
): Promise<GooglePublishResult> {
	const { post, account } = input
	const topicType = isGoogleTopicType(post.googleTopicType)
		? post.googleTopicType
		: 'STANDARD'
	const [row] = await db
		.select({ sync: GbpLocationSync, integration: Integration })
		.from(GbpLocationSync)
		.leftJoin(Integration, eq(Integration.id, GbpLocationSync.integrationId))
		.where(
			and(
				eq(GbpLocationSync.organizationId, post.organizationId),
				eq(GbpLocationSync.googleLocationName, account.externalId),
			),
		)
		.limit(1)
	if (!row || !row.integration?.isActive) {
		throw new SocialError('unauthorized', 'google_reconnect')
	}
	if (!connectionReady(row.sync)) {
		throw new SocialError('unauthorized', googleConnectionError(row.sync))
	}
	const details = parseGooglePostDetails(post.googleDetails)
	const problems = await googlePostServerProblems({
		organizationId: post.organizationId,
		body: post.body,
		topicType,
		details,
		media: post.media,
	})
	if (problems.length > 0) {
		throw new SocialError('rejected', `google_invalid:${problems.join(',')}`)
	}
	const { ids } = await mediaFacts(post.organizationId, post.media)
	const [organization] = await db
		.select({ locale: Organization.siteDefaultLocale })
		.from(Organization)
		.where(eq(Organization.id, post.organizationId))
		.limit(1)
	const body = buildLocalPostBody({
		body: post.body,
		topicType,
		details,
		imageUrl: ids[0] ? publicImageUrl(ids[0]) : null,
		languageCode: (organization?.locale ?? 'en').split('-')[0] || 'en',
	})
	try {
		const client = input.client ?? (await gbpClientFor(row.integration))
		const accountName =
			row.sync.googleAccountName ??
			(await resolveGbpAccountName(
				post.organizationId,
				row.sync.organizationLocationId,
			))
		const created = await client.createLocalPost(
			accountName,
			row.sync.googleLocationName,
			body,
		)
		if (created.state === 'REJECTED') {
			throw new SocialError('rejected', 'google_removed')
		}
		return {
			externalPostId: created.name,
			permalink: created.searchUrl ?? null,
			reviewState: created.state === 'LIVE' ? 'live' : 'pending',
		}
	} catch (error) {
		if (error instanceof SocialError) throw error
		if (error instanceof GbpError) {
			switch (error.code) {
				case 'gbp_token_expired':
					throw new SocialError(
						'unauthorized',
						'google_reconnect',
						error.status,
					)
				case 'gbp_suspended':
					throw new SocialError(
						'unauthorized',
						'google_suspended',
						error.status,
					)
				case 'gbp_not_verified':
					throw new SocialError(
						'unauthorized',
						'google_not_verified',
						error.status,
					)
				case 'gbp_access_lost':
					throw new SocialError(
						'unauthorized',
						'google_access_lost',
						error.status,
					)
				case 'gbp_rate_limited':
					throw new SocialError(
						'rate_limited',
						'google_unavailable',
						error.status,
					)
				case 'gbp_rejected':
					throw new SocialError(
						'rejected',
						error.reason ? error.reason.slice(0, 400) : 'google_rejected',
						error.status,
					)
				default:
					throw new SocialError(
						'unavailable',
						'google_unavailable',
						error.status,
					)
			}
		}
		throw new SocialError('unavailable', 'google_unavailable')
	}
}

// ---------------------------------------------------------------------------
// Review state and removal
// ---------------------------------------------------------------------------

/**
 * Hourly: posts Google held for review. LIVE clears the pending mark;
 * REJECTED fails the target with Google's reason and re-settles the post.
 */
export async function refreshGooglePostStates(
	options: { client?: GbpClient; limit?: number } = {},
): Promise<{ checked: number; live: number; rejected: number }> {
	const targets = await db
		.select({
			id: SocialPostTarget.id,
			postId: SocialPostTarget.postId,
			externalPostId: SocialPostTarget.externalPostId,
			organizationId: SocialPost.organizationId,
			accountExternalId: SocialAccount.externalId,
		})
		.from(SocialPostTarget)
		.innerJoin(SocialPost, eq(SocialPost.id, SocialPostTarget.postId))
		.leftJoin(
			SocialAccount,
			eq(SocialAccount.id, SocialPostTarget.socialAccountId),
		)
		.where(
			and(
				eq(SocialPostTarget.platform, 'google_business'),
				eq(SocialPostTarget.reviewState, 'pending'),
			),
		)
		.limit(options.limit ?? 50)
	let live = 0
	let rejected = 0
	for (const target of targets) {
		if (!target.externalPostId || !target.accountExternalId) continue
		const [row] = await db
			.select({ integration: Integration })
			.from(GbpLocationSync)
			.innerJoin(Integration, eq(Integration.id, GbpLocationSync.integrationId))
			.where(
				and(
					eq(GbpLocationSync.organizationId, target.organizationId),
					eq(GbpLocationSync.googleLocationName, target.accountExternalId),
				),
			)
			.limit(1)
		if (!row?.integration.isActive) continue
		try {
			const client = options.client ?? (await gbpClientFor(row.integration))
			const state = await client.getLocalPost(target.externalPostId)
			if (state.state === 'LIVE') {
				await db
					.update(SocialPostTarget)
					.set({ reviewState: 'live' })
					.where(eq(SocialPostTarget.id, target.id))
				live += 1
			} else if (state.state === 'REJECTED') {
				await db
					.update(SocialPostTarget)
					.set({
						reviewState: 'rejected',
						status: 'failed',
						error: (state.rejectionReason || 'google_removed').slice(0, 500),
					})
					.where(eq(SocialPostTarget.id, target.id))
				await resettlePost(target.postId)
				rejected += 1
			}
		} catch {
			// Still pending: the next sweep looks again.
		}
	}
	return { checked: targets.length, live, rejected }
}

async function resettlePost(postId: string) {
	const targets = await db
		.select({ status: SocialPostTarget.status })
		.from(SocialPostTarget)
		.where(eq(SocialPostTarget.postId, postId))
	if (targets.some((t) => t.status === 'pending' || t.status === 'publishing'))
		return
	await db
		.update(SocialPost)
		.set({ status: settledPostStatus(targets) })
		.where(eq(SocialPost.id, postId))
}

/**
 * "Remove from Google": deletes this post's Google posts. Without it, deleting
 * a post in Menuza leaves Google alone. Returns how many were removed.
 */
export async function removePostFromGoogle(
	organizationId: string,
	postId: string,
	options: { client?: GbpClient } = {},
): Promise<number> {
	const targets = await db
		.select({
			externalPostId: SocialPostTarget.externalPostId,
			accountExternalId: SocialAccount.externalId,
		})
		.from(SocialPostTarget)
		.innerJoin(SocialPost, eq(SocialPost.id, SocialPostTarget.postId))
		.leftJoin(
			SocialAccount,
			eq(SocialAccount.id, SocialPostTarget.socialAccountId),
		)
		.where(
			and(
				eq(SocialPostTarget.postId, postId),
				eq(SocialPost.organizationId, organizationId),
				eq(SocialPostTarget.platform, 'google_business'),
			),
		)
	let removed = 0
	for (const target of targets) {
		if (!target.externalPostId || !target.accountExternalId) continue
		const [row] = await db
			.select({ integration: Integration })
			.from(GbpLocationSync)
			.innerJoin(Integration, eq(Integration.id, GbpLocationSync.integrationId))
			.where(
				and(
					eq(GbpLocationSync.organizationId, organizationId),
					eq(GbpLocationSync.googleLocationName, target.accountExternalId),
				),
			)
			.limit(1)
		if (!row?.integration.isActive) continue
		try {
			const client = options.client ?? (await gbpClientFor(row.integration))
			await client.deleteLocalPost(target.externalPostId)
			removed += 1
		} catch {
			// Google keeps the post; the operator is told how many were removed.
		}
	}
	return removed
}
