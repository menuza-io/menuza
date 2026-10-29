import {
	db,
	eq,
	OrganizationMediaAsset,
	SocialAccount,
	SocialPost,
	SocialPostTarget,
} from '@repo/database'
import { decryptAsync, getEncryptionKey } from '@repo/security'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const meta = vi.hoisted(() => ({
	publishToFacebook: vi.fn(),
	publishToInstagram: vi.fn(),
}))

vi.mock('./meta.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	publishToFacebook: meta.publishToFacebook,
	publishToInstagram: meta.publishToInstagram,
}))

const { SocialError } = await import('./errors.ts')
const { saveSocialAccounts } = await import('./accounts.server.ts')
const {
	getSocialPost,
	publishDueSocialPosts,
	publishSocialPost,
	retrySocialPost,
	saveSocialPost,
	SocialPostConflict,
} = await import('./posts.server.ts')

let counter = 0
const published = (platform: string) => ({
	externalPostId: `${platform}_${++counter}`,
	permalink: `https://example.com/${platform}/${counter}`,
})

beforeEach(() => {
	meta.publishToFacebook.mockReset()
	meta.publishToInstagram.mockReset()
	meta.publishToFacebook.mockImplementation(async () => published('facebook'))
	meta.publishToInstagram.mockImplementation(async () =>
		published('instagram'),
	)
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	const owner = { userId: user.id, organization: { id: organization.id } }
	const suffix = organization.id
	await saveSocialAccounts(owner, [
		{
			platform: 'facebook',
			externalId: `page-${suffix}`,
			name: 'Bakery Page',
			username: null,
			accessToken: 'page-token',
		},
		{
			platform: 'instagram',
			externalId: `ig-${suffix}`,
			name: 'Bakery',
			username: 'bakery',
			accessToken: 'page-token',
		},
	])
	const accounts = await db
		.select()
		.from(SocialAccount)
		.where(eq(SocialAccount.organizationId, organization.id))
	const facebook = accounts.find((a) => a.platform === 'facebook')!
	const instagram = accounts.find((a) => a.platform === 'instagram')!
	const [image] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId: organization.id,
			objectKey: `media/${suffix}/photo.jpg`,
			mimeType: 'image/jpeg',
		})
		.returning()
	return { owner, facebook, instagram, image: image! }
}

const past = () => new Date(Date.now() - 60_000)

async function schedule(
	owner: Awaited<ReturnType<typeof setup>>['owner'],
	input: { accountIds: string[]; mediaIds?: string[]; body?: string },
	scheduledAt = past(),
) {
	return saveSocialPost(owner, {
		body: input.body ?? 'Fresh bread today',
		mediaIds: input.mediaIds ?? [],
		accountIds: input.accountIds,
		status: 'scheduled',
		scheduledAt,
	})
}

describe('social posts', () => {
	it('stores page tokens encrypted', async () => {
		const { facebook } = await setup()
		expect(facebook.accessToken).not.toContain('page-token')
		expect(
			await decryptAsync(
				facebook.accessToken,
				getEncryptionKey('INTEGRATION_ENCRYPTION_KEY'),
			),
		).toBe('page-token')
	})

	it('only targets accounts and images of the same organization', async () => {
		const mine = await setup()
		const other = await setup()
		const post = await saveSocialPost(mine.owner, {
			body: 'Hello',
			mediaIds: [mine.image.id, other.image.id],
			accountIds: [mine.facebook.id, other.instagram.id],
			status: 'draft',
			scheduledAt: null,
		})
		const saved = await getSocialPost(mine.owner.organization.id, post.id)
		expect(saved?.targets.map((t) => t.socialAccountId)).toEqual([
			mine.facebook.id,
		])
		expect(saved?.media.map((m) => m.mediaId)).toEqual([mine.image.id])
		expect(await getSocialPost(other.owner.organization.id, post.id)).toBeNull()
	})

	it('publishes a due post to every account once, and leaves future posts', async () => {
		const { owner, facebook, instagram, image } = await setup()
		const due = await schedule(owner, {
			accountIds: [facebook.id, instagram.id],
			mediaIds: [image.id],
		})
		const later = await schedule(
			owner,
			{ accountIds: [facebook.id] },
			new Date(Date.now() + 3_600_000),
		)

		await publishDueSocialPosts()
		await publishDueSocialPosts()

		const post = await getSocialPost(owner.organization.id, due.id)
		expect(post?.status).toBe('published')
		expect(post?.publishedAt).toBeInstanceOf(Date)
		expect(post?.targets.every((t) => t.status === 'published')).toBe(true)
		expect(post?.targets.every((t) => t.permalink)).toBe(true)
		const calls = (mock: typeof meta.publishToFacebook) =>
			mock.mock.calls.filter(([account]) =>
				String(account.externalId).endsWith(owner.organization.id),
			)
		expect(calls(meta.publishToFacebook)).toHaveLength(1)
		expect(calls(meta.publishToInstagram)).toHaveLength(1)
		expect(calls(meta.publishToInstagram)[0]![1].imageUrls).toHaveLength(1)
		expect(
			(await getSocialPost(owner.organization.id, later.id))?.status,
		).toBe('scheduled')
	})

	it('claims a post once when two callers race', async () => {
		const { owner, facebook } = await setup()
		const { id } = await schedule(owner, { accountIds: [facebook.id] })
		const results = await Promise.all([
			publishSocialPost(id),
			publishSocialPost(id),
		])
		expect(results.filter(Boolean)).toHaveLength(1)
		expect(meta.publishToFacebook).toHaveBeenCalledTimes(1)
	})

	it('reports a partial post and retries only the failed account', async () => {
		const { owner, facebook, instagram, image } = await setup()
		meta.publishToInstagram.mockRejectedValueOnce(
			new SocialError('rejected', 'Aspect ratio not supported'),
		)
		const { id } = await schedule(owner, {
			accountIds: [facebook.id, instagram.id],
			mediaIds: [image.id],
		})
		await publishSocialPost(id)
		let post = await getSocialPost(owner.organization.id, id)
		expect(post?.status).toBe('partial')
		expect(post?.targets.find((t) => t.platform === 'instagram')).toMatchObject(
			{ status: 'failed', error: 'Aspect ratio not supported' },
		)

		expect(await retrySocialPost(owner.organization.id, id)).toBe(true)
		post = await getSocialPost(owner.organization.id, id)
		expect(post?.status).toBe('published')
		expect(meta.publishToFacebook).toHaveBeenCalledTimes(1)
		expect(meta.publishToInstagram).toHaveBeenCalledTimes(2)
	})

	it('asks to reconnect an account Meta refuses, without calling Meta again', async () => {
		const { owner, facebook } = await setup()
		meta.publishToFacebook.mockRejectedValueOnce(
			new SocialError('unauthorized', 'Error validating access token'),
		)
		const first = await schedule(owner, { accountIds: [facebook.id] })
		await publishSocialPost(first.id)
		const [account] = await db
			.select({ status: SocialAccount.status })
			.from(SocialAccount)
			.where(eq(SocialAccount.id, facebook.id))
		expect(account?.status).toBe('needs_reauth')

		const second = await schedule(owner, { accountIds: [facebook.id] })
		await publishSocialPost(second.id)
		const post = await getSocialPost(owner.organization.id, second.id)
		expect(post?.status).toBe('failed')
		expect(post?.targets[0]?.error).toBe('needs_reauth')
		expect(meta.publishToFacebook).toHaveBeenCalledTimes(1)
	})

	it('keeps the history of a disconnected account and fails its scheduled posts', async () => {
		const { owner, facebook } = await setup()
		const { id } = await schedule(owner, { accountIds: [facebook.id] })
		await db.delete(SocialAccount).where(eq(SocialAccount.id, facebook.id))
		await publishSocialPost(id)
		const post = await getSocialPost(owner.organization.id, id)
		expect(post?.targets[0]).toMatchObject({
			accountName: 'Bakery Page',
			status: 'failed',
			error: 'disconnected',
		})
		expect(meta.publishToFacebook).not.toHaveBeenCalled()
	})

	it('never sends an interrupted target twice', async () => {
		const { owner, facebook, instagram, image } = await setup()
		const { id } = await schedule(owner, {
			accountIds: [facebook.id, instagram.id],
			mediaIds: [image.id],
		})
		// A worker claimed the post, started Facebook, then died.
		const stale = new Date(Date.now() - 20 * 60_000)
		await db
			.update(SocialPost)
			.set({ status: 'publishing', updatedAt: stale })
			.where(eq(SocialPost.id, id))
		await db
			.update(SocialPostTarget)
			.set({ status: 'publishing' })
			.where(eq(SocialPostTarget.socialAccountId, facebook.id))

		await publishDueSocialPosts()

		const post = await getSocialPost(owner.organization.id, id)
		expect(post?.status).toBe('partial')
		expect(post?.targets.find((t) => t.platform === 'facebook')).toMatchObject(
			{ status: 'failed', error: 'interrupted' },
		)
		expect(meta.publishToFacebook).not.toHaveBeenCalled()
		expect(meta.publishToInstagram).toHaveBeenCalledTimes(1)
	})

	it('refuses to edit a post that has gone out', async () => {
		const { owner, facebook } = await setup()
		const { id } = await schedule(owner, { accountIds: [facebook.id] })
		await publishSocialPost(id)
		await expect(
			saveSocialPost(
				owner,
				{
					body: 'Changed',
					mediaIds: [],
					accountIds: [facebook.id],
					status: 'draft',
					scheduledAt: null,
				},
				id,
			),
		).rejects.toBeInstanceOf(SocialPostConflict)
	})
})
