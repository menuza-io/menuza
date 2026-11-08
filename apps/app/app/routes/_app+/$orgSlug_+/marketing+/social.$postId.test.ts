import {
	db,
	eq,
	SocialAccount,
	SocialPost,
	SocialPostTarget,
} from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '#app/modules/lingui/lingui.ts'
import { type SocialAccess } from '#app/utils/social/access.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const signedIn = vi.hoisted(() => ({ access: null as SocialAccess | null }))

vi.mock('#app/utils/social/access.server.ts', () => ({
	requireSocialAccess: async () => signedIn.access,
}))

const { saveSocialAccounts } =
	await import('#app/utils/social/accounts.server.ts')
const { getSocialPost, saveSocialPost } =
	await import('#app/utils/social/posts.server.ts')
const { action } = await import('./social.$postId.tsx')

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	signedIn.access = {
		userId: user.id,
		organization: {
			id: organization.id,
			slug: organization.slug,
			name: organization.name,
		},
		canWrite: true,
	}
	await saveSocialAccounts(signedIn.access, [
		{
			platform: 'facebook',
			externalId: `page-${organization.id}`,
			name: 'Bakery Page',
			username: null,
			accessToken: 'page-token',
		},
	])
	const [facebook] = await db
		.select({ id: SocialAccount.id })
		.from(SocialAccount)
		.where(eq(SocialAccount.organizationId, organization.id))
	const { id } = await saveSocialPost(signedIn.access, {
		body: 'Fresh bread today',
		mediaIds: [],
		accountIds: [facebook!.id],
		status: 'scheduled',
		scheduledAt: new Date(Date.now() - 60_000),
	})
	return { organization, postId: id, accountId: facebook!.id }
}

function submit(
	orgSlug: string,
	postId: string,
	fields: Record<string, string>,
) {
	const body = new FormData()
	for (const [name, value] of Object.entries(fields)) body.append(name, value)
	const request = new Request(
		`http://localhost:3001/${orgSlug}/marketing/social/${postId}`,
		{ method: 'POST', body },
	)
	return action({
		request,
		params: { orgSlug, postId },
		context: {},
	} as unknown as ActionFunctionArgs)
}

describe('social post action', () => {
	beforeAll(async () => {
		await loadCatalog('en')
	})

	it('answers a conflict when the post has started publishing', async () => {
		const { organization, postId, accountId } = await setup()
		await db
			.update(SocialPost)
			.set({ status: 'publishing' })
			.where(eq(SocialPost.id, postId))
		const targetsBefore = await db
			.select()
			.from(SocialPostTarget)
			.where(eq(SocialPostTarget.postId, postId))

		const result = await submit(organization.slug, postId, {
			intent: 'draft',
			body: 'Edited in a stale tab',
			accountIds: accountId,
		})

		expect(result).toEqual({ error: 'not_editable' })
		const post = await getSocialPost(organization.id, postId)
		expect(post).toMatchObject({
			body: 'Fresh bread today',
			status: 'publishing',
		})
		expect(
			await db
				.select()
				.from(SocialPostTarget)
				.where(eq(SocialPostTarget.postId, postId)),
		).toEqual(targetsBefore)
	})

	it('still saves a scheduled post', async () => {
		const { organization, postId, accountId } = await setup()

		const result = await submit(organization.slug, postId, {
			intent: 'draft',
			body: 'Edited',
			accountIds: accountId,
		})

		expect(result).toBeInstanceOf(Response)
		expect((result as Response).status).toBe(302)
		const post = await getSocialPost(organization.id, postId)
		expect(post).toMatchObject({ body: 'Edited', status: 'draft' })
	})
})
