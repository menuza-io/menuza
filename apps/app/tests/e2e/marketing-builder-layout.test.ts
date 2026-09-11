import { type Page } from '@playwright/test'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * The marketing builder shells (automation editor + email designer) mirror the
 * website page/form editors: a muted backdrop, a compact 48px header, and
 * rounded surface cards instead of flush bordered panels.
 */

async function openAutomation(
	page: Page,
	login: () => Promise<{ id: string }>,
	navigate: (r: string, p?: Record<string, string | number>) => Promise<void>,
) {
	const user = await login()
	const org = await createTestOrganization(user.id, 'admin')
	await page.setViewportSize({ width: 1440, height: 900 })
	await navigate('/:slug/marketing/automations/new', { slug: org.slug })
	await page.waitForLoadState('networkidle')
	await page.waitForTimeout(1200)
}

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

test.describe('marketing builder layout', () => {
	test('automation editor uses the shared builder shell', async ({
		page,
		login,
		navigate,
	}) => {
		await openAutomation(page, login, navigate)

		const shell = await page.evaluate(() => {
			const root = document.querySelector('.fixed.inset-0.z-50') as HTMLElement
			const header = root?.querySelector('header')
			const aside = root?.querySelector('aside')
			return {
				headerHeight: header?.getBoundingClientRect().height ?? 0,
				headerHasDivider: Boolean(header?.querySelector('div[aria-hidden]')),
				sidebarRadius: aside ? getComputedStyle(aside).borderRadius : null,
			}
		})

		// Same compact header as the page/form editors.
		expect(shell.headerHeight).toBe(48)
		expect(shell.headerHasDivider).toBe(true)
		// The sidebar is a rounded surface, not a bordered rail.
		expect(shell.sidebarRadius).not.toBe('0px')
	})

	test('docked AI panel keeps a visible margin against the canvas', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		await page.setViewportSize({ width: 1440, height: 900 })
		// Dark mode makes the margin contrast obvious; in light mode both
		// surfaces are near-white, which is why this regressed silently.
		await page.emulateMedia({ colorScheme: 'dark' })

		await navigate('/:slug/marketing/automations/new', { slug: org.slug })
		await page.waitForLoadState('networkidle')
		await page.waitForTimeout(1500)

		await page.evaluate(() => {
			const visible = Array.from(document.querySelectorAll('button')).find(
				(button) =>
					/open assistant/i.test(button.getAttribute('aria-label') ?? '') &&
					(button as HTMLElement).offsetParent !== null,
			)
			visible?.click()
		})
		await page.waitForTimeout(1500)

		const contrast = await page.evaluate(() => {
			const panel = document.querySelector(
				'aside[aria-label="AI assistant"]',
			) as HTMLElement | null
			if (!panel) return null
			const rect = panel.getBoundingClientRect()
			const panelBg = getComputedStyle(panel).backgroundColor

			// Resolve the first opaque background behind a point.
			const backgroundAt = (x: number, y: number) => {
				let el = document.elementFromPoint(x, y) as HTMLElement | null
				while (el) {
					const bg = getComputedStyle(el).backgroundColor
					if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
					el = el.parentElement
				}
				return null
			}

			const midY = Math.round(rect.top + rect.height / 2)
			return {
				panelBg,
				// The 8px strip between the panel and the viewport edge.
				marginBg: backgroundAt(rect.right + 4, midY),
				bottomMarginBg: backgroundAt(
					Math.round(rect.left + rect.width / 2),
					rect.bottom + 4,
				),
			}
		})

		expect(contrast).not.toBeNull()
		// The margin must be the muted backdrop, not the panel's own surface —
		// otherwise the rounded corners and inset read as a flush edge.
		expect(contrast!.marginBg).not.toBe(contrast!.panelBg)
		expect(contrast!.bottomMarginBg).not.toBe(contrast!.panelBg)
	})

	test('email designer sections are separate surfaces with equal gaps', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		await createTestOrganization(user.id, 'admin')
		await page.setViewportSize({ width: 1600, height: 900 })

		await openAutomation(page, login, navigate)
		await selectEmailNode(page)
		await page.getByRole('button', { name: /design email/i }).click()

		const overlay = page.getByRole('dialog', { name: 'Email design' })
		await expect(overlay).toBeVisible()
		// Give the preview content so both sections render.
		await overlay.getByText('Announcement').click()
		await page.waitForTimeout(1500)

		await page.evaluate(() => {
			const visible = Array.from(document.querySelectorAll('button')).find(
				(button) =>
					/open assistant/i.test(button.getAttribute('aria-label') ?? '') &&
					(button as HTMLElement).offsetParent !== null,
			)
			visible?.click()
		})
		await expect(
			page.getByRole('complementary', { name: 'AI assistant' }),
		).toBeVisible()
		await page.waitForTimeout(800)

		const gaps = await page.evaluate(() => {
			const overlay = document.querySelector(
				'[aria-label="Email design"]',
			) as HTMLElement | null
			const panel = document.querySelector(
				'aside[aria-label="AI assistant"]',
			) as HTMLElement | null
			if (!overlay || !panel) return null

			const right = (el: HTMLElement) => el.getBoundingClientRect().right
			const left = (el: HTMLElement) => el.getBoundingClientRect().left
			const cards = Array.from(
				overlay.querySelectorAll('[data-slot="email-designer-section"]'),
			) as HTMLElement[]

			return {
				cardCount: cards.length,
				blocksToPreview:
					cards.length === 2
						? Math.round(left(cards[1]!) - right(cards[0]!))
						: null,
				previewToPanel:
					cards.length === 2
						? Math.round(left(panel) - right(cards[1]!))
						: null,
				panelToViewport: Math.round(window.innerWidth - right(panel)),
			}
		})

		expect(gaps).not.toBeNull()
		// Two sibling cards — not one card wrapping a nested panel.
		expect(gaps!.cardCount).toBe(2)
		// Equal gutters across blocks | preview | AI chat.
		expect(gaps!.blocksToPreview).toBe(8)
		expect(gaps!.previewToPanel).toBe(8)
		expect(gaps!.panelToViewport).toBe(8)
	})

	test('email designer exposes the AI assistant in its header', async ({
		page,
		login,
		navigate,
	}) => {
		await openAutomation(page, login, navigate)
		await selectEmailNode(page)
		await page.getByRole('button', { name: /design email/i }).click()

		const overlay = page.getByRole('dialog', { name: 'Email design' })
		await expect(overlay).toBeVisible()

		// The canvas toolbar is covered by the designer, so the toggle must live
		// in the designer's own header.
		await expect(
			overlay.getByRole('button', { name: 'Open assistant' }),
		).toBeVisible()

		await overlay.getByText('Announcement').click()
		await expect(overlay.getByText('Unsaved changes')).toBeVisible()
		await expect(overlay.getByRole('button', { name: /^save$/i })).toBeEnabled()

		// Opening it from inside the designer works and stays above the overlay.
		await overlay.getByRole('button', { name: 'Open assistant' }).click()
		await page.waitForTimeout(1000)
		// eslint-disable-next-line playwright/no-raw-locators -- panel is addressed by aria-label
		const panel = page.locator('aside[aria-label="AI assistant"]')
		await expect(panel).toBeVisible()
		const onTop = await panel.evaluate((el) => {
			const rect = el.getBoundingClientRect()
			const hit = document.elementFromPoint(rect.x + 40, rect.y + 60)
			return Boolean(hit && el.contains(hit))
		})
		expect(onTop).toBe(true)
	})
})
