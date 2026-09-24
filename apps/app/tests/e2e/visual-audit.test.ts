import path from 'node:path'
import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenuModifierGroup,
	UserOrganization,
} from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'

const SCREENSHOTS_DIR = 'test-results/audit'

test.describe('Visual Audit & Browser Layout Inspection', () => {
	test('Inspect operator and customer screens across viewports', async ({
		page,
		login,
	}) => {
		test.setTimeout(180_000)

		// 1. Get or create operator user and acme organization
		const user = await login()

		let [org] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.slug, 'acme'))
			.limit(1)

		expect(org).toBeTruthy()

		// Ensure user is an admin of the organization
		await db
			.insert(UserOrganization)
			.values({
				userId: user.id,
				organizationId: org!.id,
				organizationRoleId: 'org_role_admin',
			})
			.onConflictDoNothing()

		// Ensure a Pizza Topping modifier group exists for pizza option testing
		await db
			.insert(OrganizationMenuModifierGroup)
			.values({
				id: 'mg_pizza_toppings_test',
				organizationId: org!.id,
				name: JSON.stringify({
					en: 'Signature Pizza Toppings',
					ar: 'إضافات البيتزا المميزة',
				}),
				internalName: 'pizza-toppings',
				selectionType: 'pizza',
				minSelections: 0,
				maxSelections: 10,
				position: 2,
			})
			.onConflictDoNothing()

		// Get location
		const [location] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, org!.id))
			.limit(1)

		// Helper to capture both desktop and mobile
		async function captureScreen(
			name: string,
			url: string,
			options?: {
				actionBeforeSnap?: () => Promise<void>
			},
		) {
			// Desktop (1280x800)
			await page.setViewportSize({ width: 1280, height: 800 })
			await page.goto(url)
			await page.waitForLoadState('networkidle')
			if (options?.actionBeforeSnap) {
				await options.actionBeforeSnap()
			}

			// Check horizontal overflow
			const overflowInfo = await page.evaluate(() => {
				const hasOverflow =
					document.documentElement.scrollWidth > window.innerWidth
				if (!hasOverflow) return null
				const overflowing: string[] = []
				const all = document.querySelectorAll('*')
				for (const el of all) {
					const rect = el.getBoundingClientRect()
					if (rect.right > window.innerWidth) {
						overflowing.push(
							`${el.tagName}.${el.className} [id=${el.id}] (right=${Math.round(rect.right)}, w=${Math.round(rect.width)})`,
						)
					}
				}
				return {
					scrollWidth: document.documentElement.scrollWidth,
					innerWidth: window.innerWidth,
					overflowing: overflowing.slice(0, 10),
				}
			})
			if (overflowInfo) {
				console.log(
					`[OVERFLOW on ${name} desktop]:`,
					JSON.stringify(overflowInfo, null, 2),
				)
			}
			expect(overflowInfo).toBeNull()

			await page.screenshot({
				path: path.join(SCREENSHOTS_DIR, `audit-${name}-desktop.png`),
				fullPage: false,
			})

			// Mobile (390x844 iPhone)
			await page.setViewportSize({ width: 390, height: 844 })
			await page.goto(url)
			await page.waitForLoadState('networkidle')
			if (options?.actionBeforeSnap) {
				await options.actionBeforeSnap()
			}

			const mobileOverflowInfo = await page.evaluate(() => {
				const hasOverflow =
					document.documentElement.scrollWidth > window.innerWidth
				if (!hasOverflow) return null
				const overflowing: string[] = []
				const all = document.querySelectorAll('*')
				for (const el of all) {
					const rect = el.getBoundingClientRect()
					if (rect.right > window.innerWidth) {
						overflowing.push(
							`${el.tagName}.${el.className} [id=${el.id}] (right=${Math.round(rect.right)}, w=${Math.round(rect.width)})`,
						)
					}
				}
				return {
					scrollWidth: document.documentElement.scrollWidth,
					innerWidth: window.innerWidth,
					overflowing: overflowing.slice(0, 10),
				}
			})
			if (mobileOverflowInfo) {
				console.log(
					`[OVERFLOW on ${name} mobile]:`,
					JSON.stringify(mobileOverflowInfo, null, 2),
				)
			}
			expect(mobileOverflowInfo).toBeNull()

			await page.screenshot({
				path: path.join(SCREENSHOTS_DIR, `audit-${name}-mobile.png`),
				fullPage: false,
			})
		}

		// --- A. OPERATOR APP SCREENS ---
		// 1. Locations List
		await captureScreen(
			'operator-locations-list',
			`/${org!.slug}/settings/locations`,
		)

		// 2. Location Form (Edit or New)
		const locUrl = location
			? `/${org!.slug}/settings/locations/${location.id}`
			: `/${org!.slug}/settings/locations/new`
		await captureScreen('operator-location-form', locUrl, {
			actionBeforeSnap: async () => {
				await page.locator('#loc-country').scrollIntoViewIfNeeded()
				await page.waitForTimeout(300)
			},
		})

		// 3. Menu Overview
		await captureScreen('operator-menu-overview', `/${org!.slug}/menu`)

		// 4. Menus List & Form
		await captureScreen('operator-menus-list', `/${org!.slug}/menu/menus`)
		await captureScreen('operator-menu-form', `/${org!.slug}/menu/menus/new`)
		await captureScreen(
			'operator-menu-form-capabilities',
			`/${org!.slug}/menu/menus/new`,
			{
				actionBeforeSnap: async () => {
					await page
						.getByText('Menu Type & Capabilities')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)

		// 5. Categories List & Form
		await captureScreen(
			'operator-categories-list',
			`/${org!.slug}/menu/categories`,
		)
		await captureScreen(
			'operator-category-form',
			`/${org!.slug}/menu/categories/new`,
		)

		// 6. Items List & Form
		await captureScreen('operator-items-list', `/${org!.slug}/menu/items`)
		await captureScreen('operator-item-form', `/${org!.slug}/menu/items/new`)
		await captureScreen(
			'operator-item-form-dietary',
			`/${org!.slug}/menu/items/new`,
			{
				actionBeforeSnap: async () => {
					await page
						.getByText('Dietary, Allergens & Calories')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)
		await captureScreen(
			'operator-item-form-promotions',
			`/${org!.slug}/menu/items/new`,
			{
				actionBeforeSnap: async () => {
					await page
						.getByText('Promotions & Highlights')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)
		await captureScreen(
			'operator-item-form-locations',
			`/${org!.slug}/menu/items/new`,
			{
				actionBeforeSnap: async () => {
					await page
						.getByText('Location Availability & Pricing')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)

		// 7. Modifiers List & Form
		await captureScreen(
			'operator-modifiers-list',
			`/${org!.slug}/menu/modifiers`,
		)
		await captureScreen(
			'operator-modifier-form',
			`/${org!.slug}/menu/modifiers/new`,
		)
		await captureScreen(
			'operator-modifier-form-behavior',
			`/${org!.slug}/menu/modifiers/new`,
			{
				actionBeforeSnap: async () => {
					await page
						.getByText('Selection Behavior & Limits')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)

		// 8. Options List & Form
		await captureScreen('operator-options-list', `/${org!.slug}/menu/options`)
		await captureScreen(
			'operator-option-form',
			`/${org!.slug}/menu/options/new`,
		)
		await captureScreen(
			'operator-option-form-dietary',
			`/${org!.slug}/menu/options/new`,
			{
				actionBeforeSnap: async () => {
					await page
						.getByText('Dietary, Allergens & Calories')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)
		await captureScreen(
			'operator-option-form-pizza-assigned',
			`/${org!.slug}/menu/options/new`,
			{
				actionBeforeSnap: async () => {
					// Select the Pizza Topping group in Assigned Modifier Groups
					await page.getByText('Signature Pizza Toppings').click()
					await page.waitForTimeout(300)
					// Scroll to the dynamically revealed Pizza Whole / Half Pricing section
					await page
						.getByText('Pizza Whole / Half Pricing')
						.scrollIntoViewIfNeeded()
					await page.waitForTimeout(300)
				},
			},
		)

		// --- B. CUSTOMER SITES SCREENS ---
		// 11. Sites Menu Screen
		await captureScreen('sites-menu-rich', 'http://acme.menuza.test:3008/menu')

		// 12. Sites Customization Modal Screen
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto('http://acme.menuza.test:3008/menu')
		await page.waitForLoadState('networkidle')

		const itemCard = page.locator('.js-item-card').first()
		await expect(itemCard).toBeVisible()
		await itemCard.click()

		const modal = page.locator('#item-modal-backdrop')
		await expect(modal).not.toHaveClass(/hidden/)
		await page.waitForTimeout(400)

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-item-modal-desktop.png'),
		})

		// Modal Mobile
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(400)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-item-modal-mobile.png'),
		})

		// 13. Select Options & Add to Cart
		const gfCrust = page.getByText(/Gluten-Free Cauliflower/i).first()
		if (await gfCrust.isVisible()) {
			await gfCrust.click()
		}
		const addBtn = page.locator('#modal-add-btn')
		await addBtn.click()
		await page.waitForTimeout(400)

		// Open Drawer from Cart Tray
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})
		const openCartBtn = page.locator('#open-cart-btn')
		await expect(openCartBtn).toBeVisible()
		await openCartBtn.click({ force: true })
		await page.waitForTimeout(400)

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-cart-drawer-mobile.png'),
		})

		await page.setViewportSize({ width: 1280, height: 800 })
		await page.waitForTimeout(400)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-cart-drawer-desktop.png'),
		})

		// 14. Checkout Screen
		const checkoutBtn = page.locator('#drawer-checkout-btn')
		await checkoutBtn.click({ force: true })
		await page.waitForLoadState('networkidle')
		await page.waitForTimeout(400)
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-checkout-desktop.png'),
		})

		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(300)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-checkout-mobile.png'),
		})

		// 15. Submit Order -> Success Screen
		await page.locator('#cust-name').fill('Jane Doe')
		await page.locator('#cust-phone').fill('+1 (555) 234-5678')
		await page.locator('#cust-email').fill('jane@example.com')
		await page.locator('#place-order-btn').click({ force: true })
		await page.waitForLoadState('networkidle')
		await page.waitForTimeout(600)
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-success-mobile.png'),
		})

		await page.setViewportSize({ width: 1280, height: 800 })
		await page.waitForTimeout(300)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-success-desktop.png'),
		})
	})
})
