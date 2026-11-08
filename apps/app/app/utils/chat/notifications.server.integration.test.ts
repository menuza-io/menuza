import { and, db, eq, Notification, UserOrganization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'
import { findOrCreateDirectMessage } from './conversations.server.ts'
import { notifyChatMessage } from './notifications.server.ts'

async function dmNotificationsFor(userId: string) {
	return db
		.select({ id: Notification.id })
		.from(Notification)
		.where(
			and(eq(Notification.userId, userId), eq(Notification.type, 'chat-dm')),
		)
}

describe('notifyChatMessage direct messages', () => {
	it('notifies an active peer but not one removed from the organization', async () => {
		const alice = await createTestUser()
		const org = await createTestOrganization(alice.id, 'admin')
		const bob = await createTestUser()
		await addOrganizationMember(bob.id, org.id, 'org_role_member')
		const channel = await findOrCreateDirectMessage(org.id, alice.id, bob.id)
		const message = (id: number) => ({
			id,
			channel,
			parent: null,
			author: alice.id,
			body: `secret ${id}`,
			attachments: [],
			createdAt: Date.now(),
			editedAt: null,
			deleted: false,
			replyCount: 0,
			lastReplyAt: null,
			reactions: [],
		})
		const notify = (id: number) =>
			notifyChatMessage({
				organizationId: org.id,
				organizationSlug: org.slug,
				authorId: alice.id,
				message: message(id),
			})

		await notify(1)
		expect(await dmNotificationsFor(bob.id)).toHaveLength(1)

		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, bob.id))
		await notify(2)
		expect(await dmNotificationsFor(bob.id)).toHaveLength(1)
	})
})
