import type * as DatabaseModule from '@repo/database'
import {
	db,
	eq,
	SocialAccount,
	SocialPost,
	SocialPostTarget,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Saves take the Workers D1 path here: one `db.batch`, run on the real test
 * database. LibSQL runs a batch like D1 does: in order, in one transaction,
 * and a statement that matches nothing does not stop the ones after it.
 */
const batches = vi.hoisted(() => ({ count: 0 }))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		isD1Bound: () => true,
		db: new Proxy(actual.db, {
			get(target, prop, receiver) {
				if (prop === 'batch') {
					return (...args: Parameters<typeof actual.db.batch>) => {
						batches.count += 1
						return target.batch(...args)
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		}),
	}
})

const meta = vi.hoisted(() => ({
	publishToFacebook: vi.fn(),
	publishToInstagram: vi.fn(),
}))

vi.mock('./meta.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	publishToFacebook: meta.publishToFacebook,
	publishToInstagram: meta.publishToInstagram,
}))

const { saveSocialAccounts } = await import('./accounts.server.ts')
const { getSocialPost, retrySocialPost, saveSocialPost, SocialPostConflict } =
	await import('./posts.server.ts')

beforeEach(() => {
	batches.count = 0
	meta.publishToFacebook.mockReset()
	meta.publishToInstagram.mockReset()
	meta.publishToFacebook.mockResolvedValue({
		externalPostId: 'fb_1',
		permalink: 'https://example.com/fb/1',
	})
	meta.publishToInstagram.mockResolvedValue({
		externalPostId: 'ig_1',
		permalink: 'https://example.com/ig/1',
	})
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	const owner = { userId: user.id, organization: { id: organization.id } }
	await saveSocialAccounts(owner, [
		{
			platform: 'facebook',
			externalId: `page-${organization.id}`,
			name: 'Bakery Page',
			username: null,
			accessToken: 'page-token',
		},
		{
			platform: 'instagram',
			externalId: `ig-${organization.id}`,
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
	return { owner, facebook, instagram }
}

function targetRows(postId: string) {
	return db
		.select({
			id: SocialPostTarget.id,
			socialAccountId: SocialPostTarget.socialAccountId,
			status: SocialPostTarget.status,
		})
		.from(SocialPostTarget)
		.where(eq(SocialPostTarget.postId, postId))
		.orderBy(SocialPostTarget.id)
}

const edit = (accountIds: string[]) => ({
	body: 'Edited in a stale tab',
	mediaIds: [],
	accountIds,
	status: 'scheduled' as const,
	scheduledAt: new Date(Date.now() - 60_000),
})

describe('saveSocialPost on D1', () => {
	it('replaces the targets of an editable post in one batch', async () => {
		const { owner, facebook, instagram } = await setup()
		const { id } = await saveSocialPost(owner, {
			body: 'Hello',
			mediaIds: [],
			accountIds: [facebook.id],
			status: 'draft',
			scheduledAt: null,
		})
		batches.count = 0

		await saveSocialPost(owner, edit([instagram.id]), id)

		expect(batches.count).toBe(1)
		const post = await getSocialPost(owner.organization.id, id)
		expect(post).toMatchObject({
			body: 'Edited in a stale tab',
			status: 'scheduled',
		})
		expect(post?.targets).toEqual([
			expect.objectContaining({
				socialAccountId: instagram.id,
				platform: 'instagram',
				accountName: '@bakery',
				status: 'pending',
			}),
		])
	})

	it('adds no targets to a post that has started publishing', async () => {
		const { owner, facebook, instagram } = await setup()
		const { id } = await saveSocialPost(owner, {
			body: 'Fresh bread today',
			mediaIds: [],
			accountIds: [facebook.id],
			status: 'scheduled',
			scheduledAt: new Date(Date.now() - 60_000),
		})
		// The scheduled publisher claimed the post and is sending it.
		await db
			.update(SocialPost)
			.set({ status: 'publishing' })
			.where(eq(SocialPost.id, id))
		const before = await targetRows(id)
		batches.count = 0

		await expect(
			saveSocialPost(owner, edit([facebook.id, instagram.id]), id),
		).rejects.toBeInstanceOf(SocialPostConflict)

		expect(batches.count).toBe(1)
		expect(await targetRows(id)).toEqual(before)
		const post = await getSocialPost(owner.organization.id, id)
		expect(post).toMatchObject({
			body: 'Fresh bread today',
			status: 'publishing',
		})
	})

	it('adds nothing for Retry to send again after a stale save of a partial post', async () => {
		const { owner, facebook, instagram } = await setup()
		const { id } = await saveSocialPost(owner, {
			body: 'Fresh bread today',
			mediaIds: [],
			accountIds: [facebook.id, instagram.id],
			status: 'scheduled',
			scheduledAt: new Date(Date.now() - 60_000),
		})
		// Facebook went out; Instagram failed.
		await db
			.update(SocialPost)
			.set({ status: 'partial' })
			.where(eq(SocialPost.id, id))
		await db
			.update(SocialPostTarget)
			.set({ status: 'published', publishedAt: new Date() })
			.where(eq(SocialPostTarget.socialAccountId, facebook.id))
		await db
			.update(SocialPostTarget)
			.set({ status: 'failed', error: 'rejected' })
			.where(eq(SocialPostTarget.socialAccountId, instagram.id))
		const before = await targetRows(id)

		await expect(
			saveSocialPost(owner, edit([facebook.id, instagram.id]), id),
		).rejects.toBeInstanceOf(SocialPostConflict)
		expect(await targetRows(id)).toEqual(before)

		expect(await retrySocialPost(owner.organization.id, id)).toBe(true)
		expect(meta.publishToFacebook).not.toHaveBeenCalled()
		expect(meta.publishToInstagram).toHaveBeenCalledTimes(1)
		const post = await getSocialPost(owner.organization.id, id)
		expect(post?.status).toBe('published')
		expect(post?.targets).toHaveLength(2)
	})
})
