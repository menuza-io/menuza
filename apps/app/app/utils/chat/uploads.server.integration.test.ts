import { db, eq, OrganizationMediaAsset } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'

const { mockKey } = vi.hoisted(() => ({
	mockKey: `orgs/test/media/images/chat-${'a'.repeat(40)}.png`,
}))

vi.mock('@repo/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/storage')>()
	return {
		...actual,
		uploadOrganizationMediaImage: vi.fn().mockResolvedValue({
			key: mockKey,
			file: new File([new Uint8Array([137, 80, 78, 71])], 'chat.png', {
				type: 'image/png',
			}),
			width: 1,
			height: 1,
		}),
	}
})

import { uploadChatImage } from '#app/utils/storage.server.ts'

describe('uploadChatImage (integration)', () => {
	it('registers media so /resources/images can authorize the object key', async () => {
		const user = await createTestUser()
		const org = await createTestOrganization(user.id, 'admin')
		const file = new File([new Uint8Array([137, 80, 78, 71])], 'chat.png', {
			type: 'image/png',
		})

		const objectKey = await uploadChatImage(user.id, org.id, file)
		expect(objectKey).toBe(mockKey)

		const [asset] = await db
			.select({
				source: OrganizationMediaAsset.source,
				organizationId: OrganizationMediaAsset.organizationId,
			})
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.objectKey, objectKey))
			.limit(1)

		expect(asset).toEqual({ source: 'chat', organizationId: org.id })
	})
})
