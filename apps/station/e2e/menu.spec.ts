import { type Page } from '@playwright/test'
import {
	addQuick,
	backend,
	expect,
	menuItem,
	openCategory,
	test,
} from './helpers.ts'

const categories = (page: Page) =>
	page.getByRole('navigation', { name: 'Categories' })

test.describe('translated menus', () => {
	test('names saved in several languages show in the till’s language, never as raw text', async ({
		paired: page,
	}) => {
		await backend.liveMenu({ translate: true, publish: true })
		await page.reload()
		const nav = categories(page)
		await expect(nav.getByRole('button', { name: /^Mains/ })).toBeVisible()
		await expect(menuItem(page, 'Smash Burger')).toBeVisible()
		await expect(page.getByText('{"en"', { exact: false })).toHaveCount(0)
		// In Arabic, the Arabic names.
		await page.evaluate(() => {
			const key = 'pos.settings.v1'
			const settings = JSON.parse(localStorage.getItem(key) ?? '{}')
			localStorage.setItem(key, JSON.stringify({ ...settings, locale: 'ar' }))
		})
		await page.reload()
		await expect(
			page.getByText('ع Smash Burger', { exact: true }),
		).toBeVisible()
		await expect(page.getByText('{"en"', { exact: false })).toHaveCount(0)
	})
})

test.describe('menu browsing', () => {
	test('shows branded categories with item counts and lands on the first one', async ({
		demo: page,
	}) => {
		const nav = categories(page)
		for (const name of [
			'Popular',
			'Mains',
			'Starters',
			'Pizza',
			'Drinks',
			'Dessert',
		]) {
			await expect(
				nav.getByRole('button', { name: new RegExp(`^${name}`) }),
			).toBeVisible()
		}
		await expect(nav.getByRole('button', { name: /^Mains/ })).toHaveAttribute(
			'aria-current',
			'true',
		)
		await expect(menuItem(page, 'Smash Burger')).toBeVisible()
		await expect(menuItem(page, 'Truffle Fries')).toBeHidden()
	})

	test('switches category and shows only that category', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await expect(menuItem(page, 'Truffle Fries')).toBeVisible()
		await expect(menuItem(page, 'Smash Burger')).toBeHidden()
		await expect(
			categories(page).getByRole('button', { name: /^Starters/ }),
		).toHaveAttribute('aria-current', 'true')
		await expect(
			categories(page).getByRole('button', { name: /^Mains/ }),
		).not.toHaveAttribute('aria-current', 'true')
	})

	test('Popular gathers the flagged items from every category', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Popular')
		for (const name of ['Smash Burger', 'Truffle Fries', 'Basque Cheesecake']) {
			await expect(menuItem(page, name)).toBeVisible()
		}
		await expect(menuItem(page, 'Seared Salmon')).toBeHidden()
	})

	test('a sold-out item is shown, labelled and cannot be added', async ({
		demo: page,
	}) => {
		const ribs = menuItem(page, 'Smoked Ribs')
		await expect(ribs).toBeVisible()
		await expect(ribs).toBeDisabled()
		await expect(ribs).toContainText('Sold out')
		await ribs.click({ force: true })
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await expect(page.getByText('No items yet')).toBeVisible()
	})

	test('search finds items across categories and by description, and clears', async ({
		demo: page,
	}) => {
		const search = page.getByRole('searchbox', { name: 'Search the menu' })
		await search.fill('cheese')
		await expect(menuItem(page, 'Basque Cheesecake')).toBeVisible()
		await expect(menuItem(page, 'Smash Burger')).toBeVisible() // description: "American cheese"
		await expect(menuItem(page, 'Truffle Fries')).toBeHidden()
		await expect(categories(page).locator('[aria-current="true"]')).toHaveCount(
			0,
		)
		await page.getByRole('button', { name: 'Clear search' }).click()
		await expect(search).toHaveValue('')
		await expect(menuItem(page, 'Smash Burger')).toBeVisible()
		await expect(
			categories(page).getByRole('button', { name: /^Mains/ }),
		).toHaveAttribute('aria-current', 'true')
	})

	test('search is case-insensitive and tells you when nothing matches', async ({
		demo: page,
	}) => {
		const search = page.getByRole('searchbox', { name: 'Search the menu' })
		await search.fill('LATTE')
		await expect(menuItem(page, 'Latte')).toBeVisible()
		await search.fill('zzzz')
		await expect(page.getByText('Nothing found')).toBeVisible()
		await expect(page.getByText('No items match “zzzz”.')).toBeVisible()
	})

	test('picking a category while searching leaves search and shows the category', async ({
		demo: page,
	}) => {
		await page.getByRole('searchbox', { name: 'Search the menu' }).fill('zzzz')
		await openCategory(page, 'Dessert')
		await expect(
			page.getByRole('searchbox', { name: 'Search the menu' }),
		).toHaveValue('')
		await expect(menuItem(page, 'Warm Brownie')).toBeVisible()
	})

	test('a card shows how many of that item are already in the order', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Truffle Fries')
		await expect(
			page.getByRole('button', { name: 'Truffle Fries, $7.50, 2 in order' }),
		).toBeVisible()
	})

	test('vegetarian items are marked', async ({ demo: page }) => {
		await openCategory(page, 'Starters')
		await expect(
			menuItem(page, 'Truffle Fries').getByLabel('Vegetarian'),
		).toBeVisible()
		await expect(
			menuItem(page, 'Buffalo Wings').getByLabel('Vegetarian'),
		).toHaveCount(0)
	})
})

test.describe('sub-categories', () => {
	const sections = (page: Page, parent: string) =>
		page.getByRole('navigation', { name: `${parent} sections` })

	test('a category with sub-categories offers them, defaulting to everything under it', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Drinks')
		const row = sections(page, 'Drinks')
		await expect(
			row.getByRole('button', { name: /^All Drinks/ }),
		).toHaveAttribute('aria-current', 'true')
		await expect(row.getByRole('button', { name: /^Hot/ })).toBeVisible()
		await expect(row.getByRole('button', { name: /^Cold/ })).toBeVisible()
		// Everything below, including the third level.
		for (const name of [
			'Sparkling Water',
			'Latte',
			'Pot of Tea',
			'Cola',
			'Orange Juice',
			'Apple Juice',
			'Fresh Lemonade',
		]) {
			await expect(menuItem(page, name)).toBeVisible()
		}
	})

	test('choosing a sub-category narrows the grid', async ({ demo: page }) => {
		await openCategory(page, 'Drinks')
		await sections(page, 'Drinks').getByRole('button', { name: /^Hot/ }).click()
		await expect(menuItem(page, 'Latte')).toBeVisible()
		await expect(menuItem(page, 'Pot of Tea')).toBeVisible()
		await expect(menuItem(page, 'Cola')).toBeHidden()
		await expect(menuItem(page, 'Sparkling Water')).toBeHidden()
	})

	test('goes three levels deep: Drinks, Cold, Juice', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Drinks')
		await sections(page, 'Drinks')
			.getByRole('button', { name: /^Cold/ })
			.click()
		// The second row appears for Cold's own children.
		const cold = sections(page, 'Cold')
		await expect(
			cold.getByRole('button', { name: /^All Cold/ }),
		).toHaveAttribute('aria-current', 'true')
		await expect(menuItem(page, 'Cola')).toBeVisible()
		await expect(menuItem(page, 'Orange Juice')).toBeVisible()
		await cold.getByRole('button', { name: /^Juice/ }).click()
		await expect(menuItem(page, 'Orange Juice')).toBeVisible()
		await expect(menuItem(page, 'Apple Juice')).toBeVisible()
		await expect(menuItem(page, 'Cola')).toBeHidden()
		await expect(menuItem(page, 'Fresh Lemonade')).toBeHidden()
		await expect(
			sections(page, 'Drinks').getByRole('button', { name: /^Cold/ }),
		).toHaveAttribute('aria-current', 'true')
	})

	test('"All" climbs back up a level and a different top category resets the path', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Drinks')
		await sections(page, 'Drinks')
			.getByRole('button', { name: /^Cold/ })
			.click()
		await sections(page, 'Cold')
			.getByRole('button', { name: /^Juice/ })
			.click()
		await sections(page, 'Drinks')
			.getByRole('button', { name: /^All Drinks/ })
			.click()
		await expect(sections(page, 'Cold')).toHaveCount(0)
		await expect(menuItem(page, 'Latte')).toBeVisible()
		await sections(page, 'Drinks').getByRole('button', { name: /^Hot/ }).click()
		await openCategory(page, 'Mains')
		await expect(sections(page, 'Drinks')).toHaveCount(0)
		await openCategory(page, 'Drinks')
		await expect(
			sections(page, 'Drinks').getByRole('button', { name: /^All Drinks/ }),
		).toHaveAttribute('aria-current', 'true')
	})

	test('categories without sub-categories show no extra row, and search ignores the path', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Mains')
		await expect(
			page.getByRole('navigation', { name: /sections$/ }),
		).toHaveCount(0)
		await openCategory(page, 'Drinks')
		await sections(page, 'Drinks').getByRole('button', { name: /^Hot/ }).click()
		await page.getByRole('searchbox', { name: 'Search the menu' }).fill('juice')
		await expect(menuItem(page, 'Orange Juice')).toBeVisible()
		await expect(
			page.getByRole('navigation', { name: /sections$/ }),
		).toHaveCount(0)
	})

	test('items from sub-categories can be added and sized like any other', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Drinks')
		await sections(page, 'Drinks')
			.getByRole('button', { name: /^Cold/ })
			.click()
		await sections(page, 'Cold')
			.getByRole('button', { name: /^Fountain/ })
			.click()
		await menuItem(page, 'Fresh Lemonade').click()
		const sheet = page.getByRole('dialog')
		await sheet.getByRole('button', { name: /^Large/ }).click()
		await sheet.getByRole('button', { name: /^Add ·/ }).click()
		await expect(
			page
				.getByRole('region', { name: 'Current order' })
				.getByText('Fresh Lemonade'),
		).toBeVisible()
		await expect(
			page.getByRole('region', { name: 'Current order' }).getByText('Large'),
		).toBeVisible()
	})
})
