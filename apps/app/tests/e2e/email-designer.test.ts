import { type Page } from '@playwright/test'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Email designer in the automation builder: full-screen editing with an
 * explicit save, so edits are not applied to the journey until confirmed.
 */

type Login = () => Promise<{ id: string }>

async function openAutomation(
	page: Page,
	login: Login,
	navigate: (r: string, p?: Record<string, string | number>) => Promise<void>,
) {
	const user = await login()
	const org = await createTestOrganization(user.id, 'admin')
	await page.setViewportSize({ width: 1440, height: 900 })
	await navigate('/:slug/marketing/automations/new', { slug: org.slug })
	await page.waitForLoadState('networkidle')
	await page.waitForTimeout(1200)
}

/** Select the seeded email action node on the canvas. */
async function selectEmailNode(page: Page) {
	// eslint-disable-next-line playwright/no-raw-locators -- React Flow node has no semantic role
	const node = page
		.locator('.react-flow__node', { hasText: /welcome to our platform/i })
		.first()
	const box = await node.boundingBox()
	if (!box) throw new Error('email node not visible')
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
	await page.waitForTimeout(300)
}

/** The workflow toolbar, not the app shell's own AI toggle. */
function workflowToolbar(page: Page) {
	// eslint-disable-next-line playwright/no-raw-locators -- toolbar has no distinct role
	return page.locator('header').filter({ hasText: /save draft/i })
}

test.describe('automation email designer', () => {
	test('is full screen, drafts edits, and saves on confirm', async ({
		page,
		login,
		navigate,
	}) => {
		// Log (never intercept) journey saves; the designer also posts preview
		// requests, so only the save payload is captured.
		const savePosts: string[] = []
		page.on('request', (request) => {
			if (request.method() !== 'POST') return
			if (!request.url().includes('/marketing/automations')) return
			const body = request.postData() ?? ''
			if (!body.includes('graphJson')) return
			// React Router submits a plain object as URL-encoded FormData.
			try {
				savePosts.push(decodeURIComponent(body.replace(/\+/g, ' ')))
			} catch {
				savePosts.push(body)
			}
		})

		await openAutomation(page, login, navigate)
		await selectEmailNode(page)
		await page.getByRole('button', { name: /design email/i }).click()

		const overlay = page.getByRole('dialog', { name: 'Email design' })
		await expect(overlay).toBeVisible()

		// Full screen: the surface covers the viewport.
		const box = await overlay.boundingBox()
		expect(box?.width).toBeGreaterThan(1400)
		expect(box?.height).toBeGreaterThan(880)

		// A fresh node has no design, so Save is disabled until we edit.
		const save = page.getByRole('button', { name: /^save$/i })
		await expect(save).toBeDisabled()

		// Applying a template is a draft edit; nothing is persisted yet.
		await overlay.getByText('Announcement').click()
		await expect(page.getByText('Unsaved changes')).toBeVisible()
		await expect(save).toBeEnabled()
		expect(savePosts).toHaveLength(0)

		// Cancel -> discard guard; "Keep editing" preserves the draft.
		await page.getByRole('button', { name: /^cancel$/i }).click()
		await expect(page.getByText('Discard unsaved changes?')).toBeVisible()
		await page.getByRole('button', { name: /keep editing/i }).click()
		await expect(page.getByText('Discard unsaved changes?')).not.toBeVisible()
		await expect(overlay).toBeVisible()
		await expect(save).toBeEnabled()
		expect(savePosts).toHaveLength(0)

		// Save -> the draft is posted to the journey and the overlay closes.
		await save.click()
		await expect(overlay).not.toBeVisible({ timeout: 20_000 })
		await expect
			.poll(() => savePosts.length, { timeout: 15_000 })
			.toBeGreaterThan(0)
		expect(savePosts.join('')).toContain('Something new is here')
	})

	test('discarding leaves the stored design untouched', async ({
		page,
		login,
		navigate,
	}) => {
		await openAutomation(page, login, navigate)
		await selectEmailNode(page)
		await page.getByRole('button', { name: /design email/i }).click()

		const overlay = page.getByRole('dialog', { name: 'Email design' })
		await overlay.getByText('Announcement').click()
		await page.getByRole('button', { name: /^cancel$/i }).click()
		await page.getByRole('button', { name: /^discard$/i }).click()
		await expect(overlay).not.toBeVisible()

		// Reopening shows the original (empty) design, not the discarded draft.
		await page.getByRole('button', { name: /design email/i }).click()
		const reopened = page.getByRole('dialog', { name: 'Email design' })
		await expect(reopened).toBeVisible()
		await expect(reopened.getByText('Start with a template')).toBeVisible()
		await expect(page.getByRole('button', { name: /^save$/i })).toBeDisabled()
	})

	test('AI assistant opens above the automation canvas', async ({
		page,
		login,
		navigate,
	}) => {
		await openAutomation(page, login, navigate)

		const toggle = workflowToolbar(page).getByRole('button', {
			name: 'Open assistant',
		})
		await expect(toggle).toBeVisible()
		await toggle.click()
		await page.waitForTimeout(1200)

		// eslint-disable-next-line playwright/no-raw-locators -- panel is addressed by aria-label
		const panel = page.locator('aside[aria-label="AI assistant"]')
		await expect(panel).toBeVisible()

		// The panel must paint above the editor's fixed z-50 container.
		const onTop = await panel.evaluate((el) => {
			const rect = el.getBoundingClientRect()
			const hit = document.elementFromPoint(rect.x + 40, rect.y + 60)
			return Boolean(hit && el.contains(hit))
		})
		expect(onTop).toBe(true)
	})
})
