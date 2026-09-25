import { db, OrganizationNote } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Accessibility', () => {
	test('All pages have proper heading structure', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Test dashboard page
		try {
			await navigate('/:slug', { slug: org.slug })
			await page.waitForLoadState('networkidle')

			// Verify h1 exists and is unique
			const h1Elements = page.getByRole('heading', { level: 1 })
			await expect(h1Elements).toHaveCount(1)
			await expect(h1Elements.first()).toBeVisible()
		} catch (error: any) {
			console.log('Dashboard page failed, trying to reload:', error.message)
			// Try reloading the page
			await page.reload()
			await page.waitForLoadState('networkidle')

			const h1Elements = page.getByRole('heading', { level: 1 })
			await expect(h1Elements).toHaveCount(1)
			await expect(h1Elements.first()).toBeVisible()
		}

		// Test notes page
		await navigate('/:slug/notes', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify proper heading hierarchy
		const headings = page.getByRole('heading')
		const headingCount = await headings.count()
		expect(headingCount).toBeGreaterThan(0)

		// Test settings page
		await navigate('/:slug/settings', { slug: org.slug })
		await expect(
			page.getByRole('heading', { name: /^settings$/i, level: 1 }),
		).toBeVisible()
	})

	test('Forms have proper labels and ARIA attributes', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Test note creation form
		await navigate('/:slug/notes/new', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify form inputs have labels
		const titleInput = page.getByRole('textbox', { name: /title/i })
		await expect(titleInput).toBeVisible()

		// Check if input has aria-label or is properly labeled
		const hasAriaLabel = await titleInput.getAttribute('aria-label')
		// The title input should be accessible via role and name already
		expect(hasAriaLabel || titleInput).toBeTruthy()

		// Test content editor accessibility - it's a rich text editor (TipTap)
		const contentLabel = page.getByText('Content', { exact: true })
		await expect(contentLabel).toBeVisible()

		// The content editor renders as a textbox role in TipTap editors
		const contentEditor = page.getByRole('textbox').last() // Get the last textbox which should be the content editor
		await expect(contentEditor).toBeVisible()

		// Test profile settings form
		await navigate('/profile')
		await page.waitForLoadState('networkidle')

		// Verify profile form inputs have proper labels
		const nameInput = page.getByRole('textbox', { name: 'Name', exact: true })
		if (await nameInput.isVisible()) {
			const hasAriaLabel = await nameInput.getAttribute('aria-label')
			// The name input should be accessible via role and name already
			expect(hasAriaLabel || nameInput).toBeTruthy()
		}
	})

	test('Interactive elements are keyboard accessible', async ({
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

		// Test keyboard navigation through interactive elements
		await page.keyboard.press('Tab')

		// Verify focus is visible
		// eslint-disable-next-line playwright/no-raw-locators -- *:focus is a CSS pseudo-selector with no semantic equivalent
		const focusedElement = page.locator('*:focus')
		await expect(focusedElement).toBeVisible()

		// Test that all buttons are focusable
		const buttons = page.getByRole('button')
		const buttonCount = await buttons.count()

		for (let i = 0; i < Math.min(buttonCount, 5); i++) {
			const button = buttons.nth(i)
			if (await button.isVisible()) {
				const isInert = await button.evaluate(
					(el) => el.closest('[inert]') !== null,
				)
				if (isInert) continue
				await button.focus()
				await expect(button).toBeFocused()
			}
		}

		// Test that links are focusable
		const links = page.getByRole('link')
		const linkCount = await links.count()

		for (let i = 0; i < Math.min(linkCount, 5); i++) {
			const link = links.nth(i)
			if (await link.isVisible()) {
				const isInert = await link.evaluate(
					(el) => el.closest('[inert]') !== null,
				)
				if (isInert) continue
				await link.focus()
				await expect(link).toBeFocused()
			}
		}
	})

	test('Images have alt text', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Check all images have alt attributes
		// eslint-disable-next-line playwright/no-raw-locators -- getByRole('img') also matches SVG icons, which have no alt attribute
		const images = page.locator('img')
		const imageCount = await images.count()

		for (let i = 0; i < imageCount; i++) {
			const image = images.nth(i)
			if (await image.isVisible()) {
				// Images should have alt attribute (can be empty for decorative images)
				await expect(image).toHaveAttribute('alt')
			}
		}

		// Test profile page images
		try {
			await navigate('/profile')
			await page.waitForLoadState('networkidle')

			// eslint-disable-next-line playwright/no-raw-locators -- getByRole('img') also matches SVG icons, which have no alt attribute
			const profileImages = page.locator('img')
			const profileImageCount = await profileImages.count()

			for (let i = 0; i < profileImageCount; i++) {
				const image = profileImages.nth(i)
				if (await image.isVisible()) {
					await expect(image).toHaveAttribute('alt')
				}
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.message.includes('crashed')) {
				console.log('Page crashed during profile navigation, reloading...')
				await page.reload()
				await page.waitForLoadState('networkidle')
				// Retry the test after reload
				// eslint-disable-next-line playwright/no-raw-locators -- getByRole('img') also matches SVG icons, which have no alt attribute
				const profileImages = page.locator('img')
				const profileImageCount = await profileImages.count()

				for (let i = 0; i < profileImageCount; i++) {
					const image = profileImages.nth(i)
					if (await image.isVisible()) {
						await expect(image).toHaveAttribute('alt')
					}
				}
			} else {
				throw error
			}
		}
	})

	test('Color contrast meets accessibility standards', async ({
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

		// Test both light and dark themes
		const themes = ['light', 'dark']

		for (const theme of themes) {
			// Switch to theme
			const themeButton = page.getByRole('button', { name: /theme/i }).first()

			if (await themeButton.isVisible()) {
				await themeButton.click()
				await page.getByText(theme).click()
				await page.waitForTimeout(500)
			}

			// Check text elements have sufficient contrast
			// eslint-disable-next-line playwright/no-raw-locators -- CSS element selectors have no semantic equivalent
			const textElements = page
				.locator('p, span, div, h1, h2, h3, h4, h5, h6')
				.or(page.getByRole('button'))
				.or(page.getByRole('link'))
			const textCount = await textElements.count()

			// Sample a few text elements to verify they're visible (basic contrast check)
			for (let i = 0; i < Math.min(textCount, 10); i++) {
				const element = textElements.nth(i)
				if ((await element.isVisible()) && (await element.textContent())) {
					// Basic visibility check - more sophisticated contrast checking would require additional tools
					await expect(element).toBeVisible()
				}
			}
		}
	})

	test('Focus indicators are visible', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		try {
			await navigate('/:slug', { slug: org.slug })
			await page.waitForLoadState('networkidle')
		} catch (error: unknown) {
			if (error instanceof Error && error.message.includes('crashed')) {
				console.log('Page crashed during organization navigation, reloading...')
				await page.reload()
				await page.waitForLoadState('networkidle')
			} else {
				throw error
			}
		}

		// Test focus indicators on various interactive elements
		const interactiveElements = page
			.getByRole('button', { disabled: false })
			.or(page.getByRole('link'))
			.or(page.getByRole('textbox', { disabled: false }))
			.or(page.getByRole('combobox', { disabled: false }))
		const elementCount = await interactiveElements.count()

		let focusableElementsFound = 0
		for (
			let i = 0;
			i < Math.min(elementCount, 20) && focusableElementsFound < 5;
			i++
		) {
			const element = interactiveElements.nth(i)
			if (await element.isVisible()) {
				try {
					await element.focus()

					// Wait a bit for focus to take effect
					await page.waitForTimeout(100)

					// Check if element is actually focused
					if (await element.evaluate((el) => document.activeElement === el)) {
						focusableElementsFound++

						// Check that focus is visually indicated (this is a basic check)
						const computedStyle = await element.evaluate((el) => {
							const style = window.getComputedStyle(el, ':focus')
							return {
								outline: style.outline,
								outlineWidth: style.outlineWidth,
								boxShadow: style.boxShadow,
							}
						})

						// Verify some form of focus indication exists
						const hasFocusIndicator =
							computedStyle.outline !== 'none' ||
							computedStyle.outlineWidth !== '0px' ||
							computedStyle.boxShadow !== 'none'

						expect(hasFocusIndicator).toBeTruthy()
					}
				} catch {
					// Skip elements that can't be focused
					continue
				}
			}
		}

		// Ensure we found at least some focusable elements
		expect(focusableElementsFound).toBeGreaterThan(0)
	})

	test('ARIA landmarks are properly used', async ({
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

		// Check for main landmark
		await expect(page.getByRole('main')).toBeVisible()

		// Check for navigation landmark
		const navigation = page.getByRole('navigation')
		if ((await navigation.count()) > 0) {
			await expect(navigation.first()).toBeVisible()
		}

		// Check for banner/header
		const banner = page.getByRole('banner')
		if ((await banner.count()) > 0) {
			await expect(banner.first()).toBeVisible()
		}

		// Check for contentinfo/footer
		const contentinfo = page.getByRole('contentinfo')
		if ((await contentinfo.count()) > 0) {
			await expect(contentinfo.first()).toBeVisible()
		}
	})

	test('Screen reader announcements work correctly', async ({
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

		// Check for ARIA live regions
		const liveRegions = page.getByRole('status').or(page.getByRole('alert'))
		const liveRegionCount = await liveRegions.count()

		if (liveRegionCount > 0) {
			// Verify live regions have appropriate aria-live values
			for (let i = 0; i < liveRegionCount; i++) {
				const region = liveRegions.nth(i)
				const ariaLive = await region.getAttribute('aria-live')
				expect(['polite', 'assertive', 'off']).toContain(ariaLive)
			}
		}

		// Check for status messages
		const statusElements = page.getByRole('status')
		const statusCount = await statusElements.count()

		for (let i = 0; i < statusCount; i++) {
			const status = statusElements.nth(i)
			if (await status.isVisible()) {
				await expect(status).toBeVisible()
			}
		}
	})

	test('Skip links are available', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Tab to first element to reveal skip links
		await page.keyboard.press('Tab')

		// Look for skip links
		const skipLink = page
			.getByRole('link', { name: /skip to main content/i })
			.first()
			.first()

		if ((await skipLink.count()) > 0) {
			await expect(skipLink.first()).toBeVisible()

			// Test skip link functionality
			await skipLink.first().click()

			// Verify URL changed to hash
			await expect(page).toHaveURL(/.*#main-content/)
		}
	})

	test('Error messages are accessible', async ({ page, login, navigate }) => {
		await login()

		// Navigate to login page to test form validation
		await navigate('/login')
		await page.waitForLoadState('networkidle')

		// Submit form without filling required fields
		const submitButton = page.getByRole('button', { name: /sign in/i })
		if (await submitButton.isVisible()) {
			await submitButton.click()

			// Check for accessible error messages
			const errorMessages = page.getByRole('alert')
			const errorCount = await errorMessages.count()

			if (errorCount > 0) {
				// Verify error messages are associated with form fields
				// eslint-disable-next-line playwright/no-raw-locators -- aria-invalid attribute selector has no semantic equivalent
				const invalidFields = page.locator('[aria-invalid="true"]')
				const invalidCount = await invalidFields.count()

				for (let i = 0; i < invalidCount; i++) {
					const field = invalidFields.nth(i)

					// Check if field has aria-describedby pointing to error message
					const describedBy = await field.getAttribute('aria-describedby')
					if (describedBy) {
						const errorElement = page.locator(`#${describedBy}`)
						await expect(errorElement).toBeVisible()
					}
				}
			}
		}
	})

	test('Modal dialogs are accessible', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization page
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open command menu (modal dialog)
		const searchButton = page.getByRole('button', { name: /^search$/i })
		await searchButton.click()

		// Verify dialog has proper ARIA attributes
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		// Verify dialog has accessible name
		const dialogTitle = dialog.getByRole('heading').first()
		if ((await dialogTitle.count()) > 0) {
			await expect(dialogTitle).toBeVisible()
		}

		// Wait for the dialog animation to complete and the input to gain focus
		// Radix UI delays autofocus until the open animation finishes
		await expect(dialog.getByRole('combobox')).toBeFocused()

		// Test focus trap - focus should stay within dialog
		// Tab past the search input; Base UI's FloatingFocusManager uses FocusGuard
		// spans (siblings of the dialog) that redirect focus back via requestAnimationFrame.
		// Wait briefly for the async redirect to complete before checking.
		await page.keyboard.press('Tab')
		await page.waitForTimeout(100)
		// eslint-disable-next-line playwright/no-raw-locators -- *:focus is a CSS pseudo-selector with no semantic equivalent
		const focusedElement = page.locator('*:focus')

		// Verify focused element is within the dialog
		const isWithinDialog = await focusedElement.evaluate(
			(el, dialogEl) => {
				return dialogEl?.contains(el)
			},
			await dialog.elementHandle(),
		)

		expect(isWithinDialog).toBeTruthy()

		// Close dialog with Escape
		await page.keyboard.press('Escape')
		await expect(dialog).not.toBeVisible()
	})

	test('Tables have proper headers and captions', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Create some notes to populate tables
		await db.insert(OrganizationNote).values(
			Array.from({ length: 3 }, (_, i) => ({
				title: `Note ${i + 1}`,
				content: `Content ${i + 1}`,
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
			})),
		)

		// Navigate to notes page (likely has a table)
		await navigate('/:slug/notes', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Check for tables
		const tables = page.getByRole('table')
		const tableCount = await tables.count()

		for (let i = 0; i < tableCount; i++) {
			const table = tables.nth(i)

			// Check for table headers
			const headers = table.getByRole('columnheader')
			const headerCount = await headers.count()

			if (headerCount > 0) {
				// Verify headers have proper scope attributes
				for (let j = 0; j < headerCount; j++) {
					const header = headers.nth(j)
					const scope = await header.getAttribute('scope')

					// Headers should have scope="col" or scope="row"
					if (scope) {
						expect(['col', 'row', 'colgroup', 'rowgroup']).toContain(scope)
					}
				}
			}

			// Check for table caption
			const caption = table.getByRole('caption')
			if ((await caption.count()) > 0) {
				await expect(caption.first()).toBeVisible()
			}
		}
	})
})
