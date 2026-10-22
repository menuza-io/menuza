import { type Page } from '@playwright/test'
import { addQuick, cart, expect, openCategory, test } from './helpers.ts'

const overflow = (page: Page) =>
	page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	)

test.describe('responsive layout', () => {
	for (const [name, width, height, sideCart] of [
		['wide tablet landscape', 1366, 1024, true],
		['tablet landscape', 1180, 820, true],
		['small tablet landscape', 1024, 768, true],
		['tablet portrait', 820, 1180, false],
		['small tablet portrait', 768, 1024, false],
		['large phone', 430, 932, false],
		['phone', 390, 844, false],
		['small phone', 360, 640, false],
		['smallest phone', 320, 568, false],
	] as const) {
		test(`${name} (${width}×${height}): ${sideCart ? 'order panel beside the menu' : 'order bar at the bottom'}, nothing overflows`, async ({
			demo: page,
		}) => {
			await page.setViewportSize({ width, height })
			await expect(
				page.getByRole('button', { name: /^Smash Burger,/ }),
			).toBeVisible()
			if (sideCart) {
				await expect(cart(page)).toBeVisible()
				await expect(
					page.getByRole('button', { name: /Order is empty|View order/ }),
				).toHaveCount(0)
			} else {
				await expect(cart(page)).toHaveCount(0)
				await expect(
					page.getByRole('button', { name: 'Order is empty' }),
				).toBeVisible()
			}
			// Measured only once the layout has settled into its mode.
			await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0)
			// The header's controls are all on screen.
			for (const label of [/^Orders/, 'Settings']) {
				const box = await page
					.getByRole('button', { name: label })
					.boundingBox()
				expect(box, String(label)).not.toBeNull()
				expect(box!.x + box!.width).toBeLessThanOrEqual(width)
				expect(box!.x).toBeGreaterThanOrEqual(0)
			}
		})
	}

	test('resizing keeps the order: it just moves between the panel and the bar', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Buffalo Wings')
		await expect(cart(page).getByText('Subtotal · 2 items')).toBeVisible()
		await page.setViewportSize({ width: 600, height: 900 })
		await expect(cart(page)).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: /View order/ }),
		).toContainText('$20.03')
		await page.setViewportSize({ width: 1180, height: 820 })
		await expect(cart(page).getByText('Subtotal · 2 items')).toBeVisible()
	})

	test('touch targets are at least 40px tall everywhere a finger goes', async ({
		demo: page,
	}) => {
		const tooSmall: string[] = []
		for (const locator of [
			page.getByRole('button', { name: /^Orders/ }),
			page.getByRole('button', { name: 'Settings' }),
			page
				.getByRole('navigation', { name: 'Categories' })
				.getByRole('button')
				.first(),
			page.getByRole('button', { name: /^Smash Burger,/ }),
			cart(page).getByRole('button', { name: 'Pay later' }),
			cart(page).getByRole('button', { name: /^Charge/ }),
			cart(page).getByRole('radio', { name: 'Takeaway' }),
		]) {
			const box = await locator.boundingBox()
			if (!box || box.height < 40 || box.width < 40)
				tooSmall.push(
					`${await locator.textContent()} ${box?.width}×${box?.height}`,
				)
		}
		expect(tooSmall).toEqual([])
	})
})
