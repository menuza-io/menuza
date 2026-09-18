import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Command Menu', () => {
	test('Command menu opens with Cmd+K shortcut', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu with keyboard shortcut
		await page.keyboard.press('Meta+k') // Mac

		// Verify command menu is visible
		await expect(page.getByRole('dialog')).toBeVisible()
		await expect(page.getByRole('dialog').getByRole('combobox')).toBeVisible()
	})

	test('Command menu opens with Ctrl+K shortcut on Windows/Linux', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu with keyboard shortcut
		await page.keyboard.press('Control+k') // Windows/Linux

		// Verify command menu is visible
		await expect(page.getByRole('dialog')).toBeVisible()
		await expect(page.getByRole('dialog').getByRole('combobox')).toBeVisible()
	})

	test('Command menu can be closed with Escape key', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu
		await page.keyboard.press('Meta+k')
		await expect(page.getByRole('dialog')).toBeVisible()

		// Close with Escape key
		await page.keyboard.press('Escape')
		await expect(page.getByRole('dialog')).not.toBeVisible()
	})

	test('Command menu search functionality', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu
		await page.keyboard.press('Meta+k')
		await expect(page.getByRole('dialog')).toBeVisible()

		// Test search input functionality
		const searchInput = page.getByRole('dialog').getByRole('combobox')
		await expect(searchInput).toBeVisible()

		// Type in search box
		await searchInput.fill('test')
		await page.waitForTimeout(500)

		// Verify search box accepts input
		await expect(searchInput).toHaveValue('test')
	})

	test('Command menu basic navigation', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu
		await page.keyboard.press('Meta+k')
		await expect(page.getByRole('dialog')).toBeVisible()

		// Test that command menu can be closed
		await page.keyboard.press('Escape')
		await expect(page.getByRole('dialog')).not.toBeVisible()
	})

	test('Command menu interface elements', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu
		await page.keyboard.press('Meta+k')
		await expect(page.getByRole('dialog')).toBeVisible()

		// Verify basic interface elements
		await expect(page.getByRole('dialog').getByRole('combobox')).toBeVisible()
		await expect(page.getByRole('listbox')).toBeVisible()
	})

	test('Command menu keyboard interaction', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu
		await page.keyboard.press('Meta+k')
		await expect(page.getByRole('dialog')).toBeVisible()

		// Test keyboard navigation
		await page.keyboard.press('ArrowDown')
		await page.keyboard.press('ArrowUp')

		// Close with Escape
		await page.keyboard.press('Escape')
		await expect(page.getByRole('dialog')).not.toBeVisible()
	})

	// Remove duplicate test - functionality covered in previous test

	test('Command menu shows empty state when no results', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu
		await page.keyboard.press('Meta+k')
		await expect(page.getByRole('dialog')).toBeVisible()

		// Search for something that doesn't exist
		await page
			.getByRole('dialog')
			.getByRole('combobox')
			.fill('nonexistent-search-term-xyz')
		await page.waitForTimeout(500)

		// Verify empty state message (based on actual UI)
		await expect(page.getByText(/no notes found/i)).toBeVisible()
	})
})
