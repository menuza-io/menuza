import {
	addQuick,
	cart,
	dialog,
	expect,
	openCategory,
	test,
} from './helpers.ts'

test.describe('POS interaction polish', () => {
	test('the viewport allows pinch zoom', async ({ demo: page }) => {
		const viewport = await page
			.locator('meta[name="viewport"]')
			.getAttribute('content')
		expect(viewport).not.toContain('user-scalable=no')
		expect(viewport).not.toContain('maximum-scale=1')
	})

	test('order type uses one tab stop and arrow keys move selection and focus', async ({
		demo: page,
	}) => {
		const dineIn = cart(page).getByRole('radio', { name: 'Dine in' })
		const takeaway = cart(page).getByRole('radio', { name: 'Takeaway' })
		await expect(dineIn).toHaveAttribute('tabindex', '0')
		await expect(takeaway).toHaveAttribute('tabindex', '-1')
		await dineIn.focus()
		await page.keyboard.press('ArrowRight')
		await expect(takeaway).toBeFocused()
		await expect(takeaway).toBeChecked()
		await page.keyboard.press('Home')
		await expect(dineIn).toBeFocused()
		await expect(dineIn).toBeChecked()
		await page.evaluate(() => {
			document.documentElement.dir = 'rtl'
		})
		await page.keyboard.press('ArrowLeft')
		await expect(takeaway).toBeFocused()
		await expect(takeaway).toBeChecked()
	})

	test('search has a clear recovery action and restores the selected category', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await page.getByRole('searchbox').fill('a dish that does not exist')
		await expect(page.getByText('Nothing found')).toBeVisible()
		await expect(page.getByRole('status')).toContainText('0 items')
		await page
			.getByRole('button', { name: 'Clear search' })
			.filter({ hasText: 'Clear search' })
			.click()
		await expect(
			page.getByRole('heading', { name: 'Starters', exact: true }),
		).toBeVisible()
		await expect(page.getByRole('searchbox')).toHaveValue('')
		await expect(
			page.getByRole('button', { name: /^Truffle Fries,/ }),
		).toBeVisible()
	})

	test('an item count never covers its dish name', async ({ demo: page }) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		const card = page.getByRole('button', { name: /^Truffle Fries,/ })
		const name = await card
			.getByText('Truffle Fries', { exact: true })
			.boundingBox()
		const count = await card.getByText('1', { exact: true }).boundingBox()
		expect(name).not.toBeNull()
		expect(count).not.toBeNull()
		expect(name!.x + name!.width).toBeLessThanOrEqual(count!.x)
	})

	test('a long phone order scrolls independently of its payment actions', async ({
		demo: page,
	}) => {
		await page.setViewportSize({ width: 360, height: 640 })
		await openCategory(page, 'Starters')
		for (const name of ['Truffle Fries', 'Buffalo Wings', 'Tomato Soup']) {
			await addQuick(page, name)
		}
		await openCategory(page, 'Drinks')
		await addQuick(page, 'Sparkling Water')
		await openCategory(page, 'Dessert')
		await addQuick(page, 'Warm Brownie')
		await addQuick(page, 'Basque Cheesecake')
		await page.getByRole('button', { name: /View order/ }).click()
		const order = dialog(page)
		const charge = order.getByRole('button', { name: /^Charge/ })
		const later = order.getByRole('button', { name: 'Pay later' })
		await expect(charge).toBeInViewport()
		await expect(later).toBeInViewport()
		await order
			.getByText('Basque Cheesecake', { exact: true })
			.scrollIntoViewIfNeeded()
		await expect(charge).toBeInViewport()
		await expect(later).toBeInViewport()
		expect(await order.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
			true,
		)
	})

	test('small-phone item and checkout actions fit without horizontal overflow', async ({
		demo: page,
	}) => {
		await page.setViewportSize({ width: 320, height: 568 })
		await page.getByRole('button', { name: /^Smash Burger,/ }).click()
		const item = dialog(page)
		const add = item.getByRole('button', { name: /^Add ·/ })
		await expect(add).toBeInViewport()
		expect(await item.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
			true,
		)
		await add.click()
		await page.getByRole('button', { name: /View order/ }).click()
		await dialog(page)
			.getByRole('button', { name: /^Charge/ })
			.click()
		const payment = dialog(page)
		await expect(
			payment.getByRole('button', { name: /^Confirm/ }),
		).toBeInViewport()
		expect(
			await payment.evaluate((el) => el.scrollWidth <= el.clientWidth),
		).toBe(true)
	})
})
