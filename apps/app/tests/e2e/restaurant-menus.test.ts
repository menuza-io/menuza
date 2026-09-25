import { faker } from '@faker-js/faker'
import {
	and,
	db,
	eq,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
} from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Restaurant Menu Management System', () => {
	test('Operators can manage menus, categories, items, modifier groups with live preview, and view overview layout', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		// 1. Navigate to Menu top-level tabs
		await navigate('/:slug/menu', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		const main = page.getByRole('main')

		// Verify page title and top navigation links
		await expect(
			main.getByRole('heading', { name: /^menu$/i, level: 1 }),
		).toBeVisible()
		await expect(main.getByRole('link', { name: /overview/i })).toBeVisible()
		await expect(main.getByRole('link', { name: /^menus$/i })).toBeVisible()
		await expect(main.getByRole('link', { name: /categories/i })).toBeVisible()
		await expect(main.getByRole('link', { name: /^items$/i })).toBeVisible()
		await expect(
			main.getByRole('link', { name: /modifier groups/i }),
		).toBeVisible()

		// 2. Switch to "Menus" tab
		await main.getByRole('link', { name: /^menus$/i }).click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/menus`))
		await page.waitForLoadState('networkidle')

		// Open "Create Menu"
		const createMenuBtn = page
			.getByRole('button', { name: /create menu/i })
			.or(page.getByRole('link', { name: /create menu/i }))
			.first()
		await expect(createMenuBtn).toBeVisible()
		await createMenuBtn.click()

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/menus/new`))
		await page.waitForLoadState('networkidle')

		// Fill in Menu form
		const menuDisplayName = `Main Dinner ${faker.string.alphanumeric(4)}`
		const menuInternalName = 'dinner-service'

		await page
			.getByPlaceholder(/lunch menu, dinner specials/i)
			.fill(menuDisplayName)
		await page.getByPlaceholder(/spring_dinner/i).fill(menuInternalName)

		// Select Menu Type: Online Ordering, POS & Kiosk
		await expect(page.getByText(/online ordering, pos & kiosk/i)).toBeVisible()

		// Save menu
		const saveMenuBtn = page.getByRole('button', { name: /save menu/i })
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/menu/menus') &&
					res.request().method() === 'POST',
			),
			saveMenuBtn.click(),
		])

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/menus$`))
		await page.waitForLoadState('networkidle')

		// Verify menu listed in Framed Card table
		await expect(page.getByText(menuDisplayName)).toBeVisible()

		// Verify in SQLite database
		const [createdDbMenu] = await db
			.select()
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.organizationId, org.id),
					eq(OrganizationMenu.internalName, menuInternalName),
				),
			)
			.limit(1)

		expect(createdDbMenu).toBeTruthy()
		expect(createdDbMenu?.displayName).toContain(menuDisplayName)
		if (!createdDbMenu) throw new Error('Failed to create test menu')

		// 3. Switch to "Categories" tab and create a category
		await main.getByRole('link', { name: /categories/i }).click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/categories`))
		await page.waitForLoadState('networkidle')

		const createCategoryBtn = page
			.getByRole('button', { name: /create category/i })
			.or(page.getByRole('link', { name: /create category/i }))
			.first()
		await createCategoryBtn.click()

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/categories/new`))
		await page.waitForLoadState('networkidle')

		// Fill in Category form
		const categoryDisplayName = `Pizzas & Calzones ${faker.string.alphanumeric(4)}`
		const categoryInternalName = 'pizzas'

		await page
			.getByPlaceholder(/starters, wood-fired pizza/i)
			.fill(categoryDisplayName)
		await page
			.getByPlaceholder(/appetizers_main_kitchen/i)
			.fill(categoryInternalName)

		// Assign to the created menu. "Assigned Menus" is not a checkbox list —
		// it is an "Add menu" button that opens a picker dialog. We assert the
		// control is present and usable so a missing/renamed control fails the
		// test loudly instead of silently skipping the assignment (which would
		// leave an orphan category that never renders on the overview).
		const addMenuBtn = page.getByRole('button', { name: /^add menu$/i })
		await expect(addMenuBtn).toBeVisible()
		await expect(addMenuBtn).toBeEnabled()
		await addMenuBtn.click()

		const addMenuDialog = page.getByRole('dialog')
		await expect(addMenuDialog).toBeVisible()
		await addMenuDialog.getByRole('button', { name: menuDisplayName }).click()
		await expect(addMenuDialog).toBeHidden()

		// The form must have staged the selected menu id before it is submitted.
		await expect(page.locator('input[name="assignedMenuIds"]')).toHaveValue(
			new RegExp(createdDbMenu.id),
		)

		// Save category
		const saveCategoryBtn = page.getByRole('button', {
			name: /save category/i,
		})
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/menu/categories') &&
					res.request().method() === 'POST',
			),
			saveCategoryBtn.click(),
		])

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/categories$`))
		await page.waitForLoadState('networkidle')

		// Verify category listed in table
		await expect(page.getByText(categoryDisplayName)).toBeVisible()

		// Verify in SQLite
		const [createdDbCategory] = await db
			.select()
			.from(OrganizationMenuCategory)
			.where(
				and(
					eq(OrganizationMenuCategory.organizationId, org.id),
					eq(OrganizationMenuCategory.internalName, categoryInternalName),
				),
			)
			.limit(1)

		expect(createdDbCategory).toBeTruthy()
		if (!createdDbCategory) throw new Error('Failed to create test category')

		// The category must be linked to the menu in the join table the Menu
		// Overview reads; an unassigned category can never render there.
		const categoryMenuLinks = await db
			.select()
			.from(OrganizationMenuCategoryAssignment)
			.where(
				and(
					eq(
						OrganizationMenuCategoryAssignment.categoryId,
						createdDbCategory.id,
					),
					eq(OrganizationMenuCategoryAssignment.menuId, createdDbMenu.id),
				),
			)
		expect(categoryMenuLinks).toHaveLength(1)

		// 4. Switch to "Items" tab and create an item
		await main.getByRole('link', { name: /^items$/i }).click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/items`))
		await page.waitForLoadState('networkidle')

		const createItemBtn = page
			.getByRole('button', { name: /create item/i })
			.or(page.getByRole('link', { name: /create item/i }))
			.first()
		await createItemBtn.click()

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/items/new`))
		await page.waitForLoadState('networkidle')

		// Fill in Item form
		const itemDisplayName = `Margherita Classica ${faker.string.alphanumeric(4)}`
		const itemInternalName = 'margherita-pizza'
		const itemPrice = '16.50'

		await page
			.getByPlaceholder(/truffle mushroom risotto/i)
			.fill(itemDisplayName)
		await page.getByPlaceholder(/risotto_truffle/i).fill(itemInternalName)
		await page.getByPlaceholder('0.00').first().fill(itemPrice)

		// Assign the item to the category just created. "Assigned Categories" is
		// also an "Add category" picker dialog rather than a checkbox list, and
		// the assignment is required for the item to show up on the overview.
		const addCategoryBtn = page.getByRole('button', {
			name: /^add category$/i,
		})
		await expect(addCategoryBtn).toBeVisible()
		await expect(addCategoryBtn).toBeEnabled()
		await addCategoryBtn.click()

		const addCategoryDialog = page.getByRole('dialog')
		await expect(addCategoryDialog).toBeVisible()
		await addCategoryDialog
			.getByRole('button', { name: categoryDisplayName })
			.click()
		await expect(addCategoryDialog).toBeHidden()

		// The form must have staged the selected category id before it is submitted.
		await expect(page.locator('input[name="assignedCategoryIds"]')).toHaveValue(
			new RegExp(createdDbCategory.id),
		)

		// Save item
		const saveItemBtn = page.getByRole('button', { name: /save item/i })
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/menu/items') &&
					res.request().method() === 'POST',
			),
			saveItemBtn.click(),
		])

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/items$`))
		await page.waitForLoadState('networkidle')

		// Verify item in Framed Card table
		await expect(page.getByText(itemDisplayName)).toBeVisible()
		await expect(page.getByText('$16.50')).toBeVisible()

		// Verify in SQLite
		const [createdDbItem] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, org.id),
					eq(OrganizationMenuItem.internalName, itemInternalName),
				),
			)
			.limit(1)

		expect(createdDbItem).toBeTruthy()
		expect(createdDbItem?.price).toBe(16.5)
		if (!createdDbItem) throw new Error('Failed to create test item')

		// The item must be linked to the category so it renders inside the
		// category card on the Menu Overview.
		const itemCategoryLinks = await db
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.where(
				and(
					eq(
						OrganizationMenuItemCategoryAssignment.categoryId,
						createdDbCategory.id,
					),
					eq(OrganizationMenuItemCategoryAssignment.itemId, createdDbItem.id),
				),
			)
		expect(itemCategoryLinks).toHaveLength(1)

		// 5. Switch to "Modifier Groups" tab and test Live Guest Preview
		await main.getByRole('link', { name: /modifier groups/i }).click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/modifiers`))
		await page.waitForLoadState('networkidle')

		const createModifierBtn = page
			.getByRole('button', { name: /create modifier group/i })
			.or(page.getByRole('link', { name: /create modifier group/i }))
			.first()
		await createModifierBtn.click()

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/modifiers/new`))
		await page.waitForLoadState('networkidle')

		// Live Guest Preview widget should be visible in the right sidebar
		await expect(page.getByText(/guest live preview/i)).toBeVisible()

		// Fill in group details
		const groupDisplayName = `Pizza Size & Crust ${faker.string.alphanumeric(4)}`
		await page
			.getByPlaceholder(/choice of protein, pizza toppings/i)
			.fill(groupDisplayName)

		// Verify the live guest preview header updates dynamically with the group name!
		await expect(page.getByText(groupDisplayName).last()).toBeVisible()

		// Options are created through the "Add option" dialog - it does not
		// append an inline row on the page - so drive that dialog for each one.
		const addOptionBtn = main.getByRole('button', { name: /add option/i })
		await expect(addOptionBtn).toBeVisible()

		const addOptionViaDialog = async (name: string, price?: string) => {
			await addOptionBtn.click()

			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()

			// The dialog opens in "pick an existing option" mode whenever
			// reusable options already exist; switch it to the create form so
			// the name/price inputs are rendered.
			const createNewOptionBtn = dialog.getByRole('button', {
				name: /create new option/i,
			})
			if (await createNewOptionBtn.isVisible().catch(() => false)) {
				await createNewOptionBtn.click()
			}

			await dialog.getByPlaceholder(/ranch, pepperoni/i).fill(name)
			if (price !== undefined) {
				await dialog.getByPlaceholder('0.00').fill(price)
			}

			await dialog.getByRole('button', { name: /add option/i }).click()
			await expect(dialog).toBeHidden()
		}

		// Option 1: Regular Crust ($0.00)
		await addOptionViaDialog('Regular 12" Thin')

		// Verify option appears in Guest Live Preview!
		await expect(page.getByText('Regular 12" Thin').last()).toBeVisible()

		// Add second option: Large Crust ($3.50)
		await addOptionViaDialog('Large 16" Hand Tossed', '3.50')

		// Verify second option in Guest Live Preview
		await expect(page.getByText('Large 16" Hand Tossed').last()).toBeVisible()

		// Save modifier group
		const saveModifierBtn = page.getByRole('button', {
			name: /save modifier group/i,
		})
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/menu/modifiers') &&
					res.request().method() === 'POST',
			),
			saveModifierBtn.click(),
		])

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/modifiers$`))
		await page.waitForLoadState('networkidle')

		// Verify in table
		await expect(page.getByText(groupDisplayName)).toBeVisible()

		// Verify in SQLite
		const [createdDbGroup] = await db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, org.id))
			.limit(1)

		expect(createdDbGroup).toBeTruthy()

		// 6. Return to Overview Tab to verify pills & sortable categories/items
		await main.getByRole('link', { name: /overview/i }).click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu$`))
		await page.waitForLoadState('networkidle')

		// Menu selector pill for our menu should be visible
		await expect(page.getByText(menuDisplayName)).toBeVisible()

		// Category card should be rendered on overview
		await expect(page.getByText(categoryDisplayName)).toBeVisible()

		// Item row inside category should be visible
		await expect(page.getByText(itemDisplayName)).toBeVisible()
		await expect(page.getByText('$16.50')).toBeVisible()
	})

	test('Operators can manage standalone menu options with allergens, pizza pricing, and link them to modifier groups', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		// 1. Create a Modifier Group in DB to test assignment
		const [modGroup] = await db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId: org.id,
				name: 'Choose Your Sauce',
				internalName: 'sauces',
				selectionType: 'single',
				minSelections: 1,
				maxSelections: 1,
				position: 0,
			})
			.returning()
		if (!modGroup) throw new Error('Failed to create test modifier group')

		// 2. Navigate to Options tab
		await navigate('/:slug/menu/options', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		const main = page.getByRole('main')
		await expect(
			main.getByRole('heading', { name: /menu options/i }),
		).toBeVisible()

		// 3. Click Create Option
		const createOptionBtn = page
			.getByRole('link', { name: /create option/i })
			.or(page.getByRole('button', { name: /create option/i }))
			.first()
		await expect(createOptionBtn).toBeVisible()
		await createOptionBtn.click()

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/options/new`))
		await page.waitForLoadState('networkidle')

		// 4. Fill in Option details
		const optionName = `Truffle Glaze ${faker.string.alphanumeric(4)}`
		const optionInternal = 'truffle-glaze'
		const optionDesc =
			'Savory glaze crafted with Italian black summer truffles.'

		await page
			.getByPlaceholder(/extra cheese, ranch dressing/i)
			.fill(optionName)
		await page.locator('input[name="internalName"]').fill(optionInternal)

		// Base price delta
		const priceInput = page.getByPlaceholder('0.00').first()
		await priceInput.fill('2.50')

		// Pizza half price (whole uses base price field above)
		const halfPriceInput = page.locator('#option-price-half')
		if (await halfPriceInput.isVisible()) {
			await halfPriceInput.fill('1.25')
		}

		// Calories
		const caloriesInput = page
			.getByPlaceholder('e.g. 120')
			.or(page.locator('input[name="calories"]'))
		if (await caloriesInput.isVisible()) {
			await caloriesInput.fill('140')
		}

		// Toggle Dietary Flags (Vegetarian, Gluten-Free)
		await page.getByText('Vegetarian', { exact: true }).click()
		await page.getByText('Gluten-Free', { exact: true }).click()

		// Check Allergen (Dairy)
		await page.getByRole('button', { name: 'Dairy', exact: true }).click()

		// Assign to Modifier Group
		await page.getByText(modGroup.name).first().click()

		// 5. Submit Save Option
		const saveOptionBtn = page.getByRole('button', { name: /save option/i })
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/menu/options') &&
					res.request().method() === 'POST',
			),
			saveOptionBtn.click(),
		])

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/menu/options$`))
		await page.waitForLoadState('networkidle')

		// 6. Verify in Options table
		await expect(page.getByText(optionName)).toBeVisible()
		await expect(page.getByText('+$2.50')).toBeVisible()
		await expect(page.getByText(modGroup.name)).toBeVisible()

		// 7. Verify Database persistence
		const [createdOption] = await db
			.select()
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, org.id),
					eq(OrganizationMenuOption.internalName, optionInternal),
				),
			)
			.limit(1)

		if (!createdOption) throw new Error('Expected createdOption to exist in DB')
		expect(createdOption.price).toBe(2.5)
		expect(createdOption.isVegetarian).toBe(true)
		expect(createdOption.isGlutenFree).toBe(true)

		const assignments = await db
			.select()
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.where(
				and(
					eq(
						OrganizationMenuModifierGroupOptionAssignment.optionId,
						createdOption.id,
					),
					eq(
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
						modGroup.id,
					),
				),
			)

		expect(assignments).toHaveLength(1)
	})
})
