import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action } from './chat.upload.tsx'

const { objectKey, uploadChatImage } = vi.hoisted(() => {
	const key = `orgs/test-org/media/images/chat-test-${'a'.repeat(32)}.png`
	return {
		objectKey: key,
		uploadChatImage: vi.fn().mockResolvedValue(key),
	}
})

vi.mock('#app/utils/chat/uploads.server.ts', () => ({
	uploadChatImage,
}))

describe('chat.upload action', () => {
	it('returns objectKey for an authenticated org member', async () => {
		const user = await createTestUser()
		const org = await createTestOrganization(user.id, 'admin')
		const { cookie } = await createTestSession(user.id)

		const file = new File([new Uint8Array([137, 80, 78, 71])], 'chat.png', {
			type: 'image/png',
		})
		const formData = new FormData()
		formData.append('file', file)

		const request = createAuthenticatedRequest(
			`http://localhost:3000/${org.slug}/chat/upload`,
			{ method: 'POST', body: formData },
			cookie,
		)

		const response = await action({
			request,
			params: { orgSlug: org.slug },
			context: {},
		} as never)

		expect(getResponseStatus(response)).toBe(200)
		expect(response).toEqual({ ok: true, objectKey })
		expect(uploadChatImage).toHaveBeenCalledWith(
			org.id,
			user.id,
			expect.any(File),
		)
	})
})
