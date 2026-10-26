import { type Page } from '@playwright/test'
import { APP, backend, cart, expect, openCategory, test } from './helpers.ts'

const cssVar = (page: Page, name: string) =>
	page.evaluate(
		(n) =>
			getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
		name,
	)

const refresh = async (page: Page) => {
	await page.getByRole('button', { name: 'Refresh menu' }).click()
}

const theme = (css: string, extra: Record<string, unknown> = {}) =>
	backend.theme({ css, ...extra })

test.describe("the till wears the restaurant's brand", () => {
	test('uses the published theme: name, initial, title and colours', async ({
		unpaired: page,
	}) => {
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await page.getByRole('button', { name: 'Apps', exact: true }).click()
		const launcher = page.getByRole('dialog', { name: 'Station apps' })
		await expect(launcher.getByText('Downtown', { exact: true })).toBeVisible()
		await expect(page).toHaveTitle('Demo Kitchen · Station')
		await expect(launcher.getByText('D', { exact: true })).toBeVisible()
		await page.keyboard.press('Escape')
		expect(await cssVar(page, '--primary')).toBe('oklch(.46 .11 150)')
		expect(await cssVar(page, '--radius')).toBe('.875rem')
		await expect(page.locator('style#org-theme')).toHaveCount(1)
	})

	test('buttons and chips take the brand colour, not a default', async ({
		unpaired: page,
	}) => {
		const chip = page
			.getByRole('navigation', { name: 'Categories' })
			.getByRole('button', { name: /^Mains/ })
		const before = await chip.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		)
		await theme(
			':root{--primary:oklch(.55 .22 27);--primary-foreground:oklch(1 0 0);--radius:.5rem}',
		)
		await refresh(page)
		await expect.poll(() => cssVar(page, '--primary')).toBe('oklch(.55 .22 27)')
		const after = await chip.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		)
		expect(after).not.toBe(before)
		// Only one theme tag at a time: a refresh replaces it.
		await expect(page.locator('style#org-theme')).toHaveCount(1)
	})

	test('the radius setting reshapes every card', async ({ unpaired: page }) => {
		const card = page.getByRole('button', { name: /^Smash Burger,/ })
		const radius = () =>
			card.evaluate((el) =>
				parseFloat(getComputedStyle(el).borderTopLeftRadius),
			)
		const rounded = await radius()
		expect(rounded).toBe(14) // Published .875rem, without a Station offset.
		await theme(':root{--radius:0rem}')
		await refresh(page)
		await expect.poll(radius).toBeLessThan(rounded)
		expect(await radius()).toBe(0)
	})

	test('a dark brand turns the whole till dark', async ({ unpaired: page }) => {
		await theme(
			':root{--background:oklch(.18 0 0);--foreground:oklch(.96 0 0);--card:oklch(.24 0 0);--card-foreground:oklch(.96 0 0)}',
			{ mode: 'dark' },
		)
		await refresh(page)
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				),
			)
			.toBe(true)
		expect(
			await page.evaluate(
				() => getComputedStyle(document.documentElement).colorScheme,
			),
		).toBe('dark')
		// And back to light when the brand says so.
		await theme(':root{--background:oklch(.99 0 0)}', { mode: 'light' })
		await refresh(page)
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				),
			)
			.toBe(false)
	})

	test('"system" follows the device\'s own setting', async ({
		unpaired: page,
	}) => {
		await theme(':root{--primary:oklch(.4 .1 250)}', { mode: 'system' })
		await page.emulateMedia({ colorScheme: 'dark' })
		await refresh(page)
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				),
			)
			.toBe(true)
		await page.emulateMedia({ colorScheme: 'light' })
		await refresh(page)
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				),
			)
			.toBe(false)
	})

	test('the brand is remembered: it is still there when the server cannot be reached', async ({
		unpaired: page,
	}) => {
		await theme(':root{--primary:oklch(.5 .2 300)}')
		await refresh(page)
		await expect.poll(() => cssVar(page, '--primary')).toBe('oklch(.5 .2 300)')
		await page.route('**/resources/**', (route) => route.abort('failed'))
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		expect(await cssVar(page, '--primary')).toBe('oklch(.5 .2 300)')
		await expect(
			page.getByRole('button', { name: /^Smash Burger,/ }),
		).toBeVisible()
	})

	test('uploaded brand fonts are loaded for headings and body; preset fonts fall back to the device font', async ({
		unpaired: page,
	}) => {
		expect(
			await page.evaluate(() => document.documentElement.dataset.headingFont),
		).toBe('system')
		await theme(':root{--primary:oklch(.4 .1 150)}', {
			headingFont: 'custom',
			bodyFont: 'custom',
			headingCustomFont: { url: `${APP}/brand/heading.woff2`, format: 'woff2' },
			bodyCustomFont: { url: `${APP}/brand/body.woff2`, format: 'woff2' },
		})
		await refresh(page)
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.dataset.headingFont),
			)
			.toBe('custom')
		expect(
			await page.evaluate(() => document.documentElement.dataset.bodyFont),
		).toBe('custom')
		const faces = await page.locator('style#org-fonts').textContent()
		expect(faces).toContain("font-family:'SiteHeading'")
		expect(faces).toContain("font-family:'SiteBody'")
		expect(faces).toContain('/brand/heading.woff2')
		// A preset (non-uploaded) font choice leaves the device font in place.
		await theme(':root{--primary:oklch(.4 .1 150)}', {
			headingFont: 'inter',
			bodyFont: 'geist',
			headingCustomFont: null,
			bodyCustomFont: null,
		})
		await refresh(page)
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.dataset.headingFont),
			)
			.toBe('system')
	})

	test('branding never changes how money or totals work', async ({
		unpaired: page,
	}) => {
		await theme(':root{--primary:oklch(.5 .2 20);--radius:2rem}')
		await refresh(page)
		await openCategory(page, 'Starters')
		await page.getByRole('button', { name: /^Truffle Fries,/ }).click()
		await expect(
			cart(page).getByRole('button', { name: /^Charge/ }),
		).toContainText('$8.12')
	})
})
