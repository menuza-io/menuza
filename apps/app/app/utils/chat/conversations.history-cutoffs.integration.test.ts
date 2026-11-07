import { chatChannelInputSchema } from '@repo/common/chat'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'
import { createChannel } from './channels.server.ts'
import {
	createGroupChat,
	getMessageHistoryCutoff,
	getMessageHistoryCutoffs,
} from './conversations.server.ts'

describe('getMessageHistoryCutoffs', () => {
	it('matches the single-channel cutoff for every channel kind', async () => {
		const alice = await createTestUser()
		const org = await createTestOrganization(alice.id, 'admin')
		const bob = await createTestUser()
		const carol = await createTestUser()
		await addOrganizationMember(bob.id, org.id, 'org_role_member')
		await addOrganizationMember(carol.id, org.id, 'org_role_member')

		const hidden = await createGroupChat(org.id, alice.id, {
			name: 'hidden',
			memberIds: [bob.id],
			showHistoryToNewMembers: false,
		})
		const shown = await createGroupChat(org.id, alice.id, {
			name: 'shown',
			memberIds: [bob.id],
			showHistoryToNewMembers: true,
		})
		const channel = await createChannel(
			org.id,
			alice.id,
			chatChannelInputSchema.parse({ name: 'general-cut', access: 'everyone' }),
		)
		const ids = [hidden, shown, channel, 'missing-channel']

		for (const user of [bob, carol]) {
			const batched = await getMessageHistoryCutoffs(org.id, user.id, ids)
			for (const id of ids) {
				const single = await getMessageHistoryCutoff(org.id, user.id, id)
				const got = batched.get(id)
				if (single === null) expect(got).toBeNull()
				// Non-members get "now" from both, so compare loosely.
				else expect(Math.abs(got! - single)).toBeLessThan(5_000)
			}
		}
		// bob is a member of the hidden group: his cutoff is his join time.
		expect(
			(await getMessageHistoryCutoffs(org.id, bob.id, [hidden])).get(hidden),
		).toBeTypeOf('number')
	})
})
