import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatChannelInputSchema } from '@repo/common/chat'
import { createChannel } from '#app/utils/chat/channels.server.ts'
import { expect, test, waitFor } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const e2eDir = path.dirname(fileURLToPath(import.meta.url))
const CHAT_IMAGE_FIXTURE = path.join(
	e2eDir,
	'../fixtures/openimg/example-r2-cloudflarestorage-com/mock-bucket/user/kody-png-w-base-h-base-fit-base.png',
)

test.describe('Team chat image attachments', () => {
	// Playwright fixtures write to libsql; Workers dev uses local D1 (see `db:migrate:d1:local`).
	// Chat also requires the Cloudflare dev server. Verify attachments manually on
	// `https://app.{brand}.test:2999/{org}/chat` after `npm run dev`.
	test.skip(
		true,
		'Workers D1 + chat WebSocket; use unit/integration tests and manual browser check',
	)

	test('uploads an image and renders it in the message thread', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const channelName = `img-${Date.now()}`
		const channelId = await createChannel(
			org.id,
			user.id,
			chatChannelInputSchema.parse({
				name: channelName,
				access: 'everyone',
			}),
		)

		await navigate(`/:slug/chat?channel=${channelId}`, { slug: org.slug })
		await expect(page.getByRole('link', { name: channelName })).toBeVisible({
			timeout: 30_000,
		})

		await waitFor(
			async () => {
				const lost = page.getByText(/connection lost/i)
				if (await lost.isVisible().catch(() => false)) {
					throw new Error('Chat WebSocket did not connect')
				}
				const send = page.getByRole('button', { name: /send message/i })
				if (!(await send.isEnabled().catch(() => false))) {
					throw new Error('Composer not ready')
				}
				return true
			},
			{ timeout: 20_000, errorMessage: 'Chat did not become ready' },
		)

		const fileInput = page.locator('input[type="file"][accept="image/*"]')
		await fileInput.setInputFiles(CHAT_IMAGE_FIXTURE)

		await page.getByRole('button', { name: /send message/i }).click()

		const messageImage = page
			.locator(`a[href*="/resources/images?objectKey="] img`)
			.last()
		await expect(messageImage).toBeVisible({ timeout: 20_000 })

		const loaded = await messageImage.evaluate(
			(img) =>
				img instanceof HTMLImageElement &&
				img.complete &&
				img.naturalWidth > 0 &&
				img.naturalHeight > 0,
		)
		expect(loaded).toBe(true)
	})
})
