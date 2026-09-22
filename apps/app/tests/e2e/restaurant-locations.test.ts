import { faker } from '@faker-js/faker'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Restaurant Locations Management & Switching', () => {
	test('Operators can view, create, edit locations and switch active location in the sidebar', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		// 1. Navigate to locations settings page
		await navigate('/:slug/settings/locations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify page header (h2 inside settings layout)
		await expect(
			page.getByRole('heading', { name: 'Locations', exact: true }),
		).toBeVisible()
		await expect(page.getByText(/manage restaurant locations/i)).toBeVisible()

		const addLocationBtn = page
			.getByRole('button', { name: /add location/i })
			.or(page.getByRole('link', { name: /add location/i }))
			.first()
		await expect(addLocationBtn).toBeVisible()

		// 2. Open "Add Location" form
		await addLocationBtn.click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/settings/locations/new`),
		)
		await page.waitForLoadState('networkidle')

		// Verify tabs are present
		await expect(
			page.getByRole('tab', { name: /details & address/i }),
		).toBeVisible()
		await expect(
			page.getByRole('tab', { name: /operating hours/i }),
		).toBeVisible()
		await expect(
			page.getByRole('tab', { name: /fulfillment & timing/i }),
		).toBeVisible()
		await expect(
			page.getByRole('tab', { name: /delivery & zones/i }),
		).toBeVisible()

		// Fill in Details & Address
		const locationName = `Downtown Flagship ${faker.string.alphanumeric(4)}`
		const locationSlug = `downtown-${faker.string.alphanumeric(6).toLowerCase()}`
		const phone = '555-0199'
		const taxRate = '8.75'

		// Localized Name input
		const nameInput = page.getByLabel(/location name/i)
		await nameInput.fill(locationName)

		const slugInput = page.getByLabel(/url slug/i)
		await slugInput.fill(locationSlug)

		const phoneInput = page.getByLabel(/phone number/i)
		await phoneInput.fill(phone)

		const taxInput = page.getByLabel(/sales tax rate/i)
		await taxInput.fill(taxRate)

		// 3. Switch to Operating Hours tab
		await page.getByRole('tab', { name: /operating hours/i }).click()
		await expect(
			page.getByRole('tab', { name: 'Store Hours', exact: true }),
		).toBeVisible()
		await expect(
			page.getByRole('tab', { name: 'Online Hours', exact: true }),
		).toBeVisible()

		// 4. Switch to Fulfillment & Timing tab
		await page.getByRole('tab', { name: /fulfillment & timing/i }).click()
		await expect(page.getByText('Order Preparation Time')).toBeVisible()

		const prepTimeInput = page.getByLabel(/base preparation time/i)
		await expect(prepTimeInput).toBeVisible()
		await prepTimeInput.fill('25')

		// 5. Submit form to create location
		const saveBtn = page.getByRole('button', { name: /create location/i })
		await expect(saveBtn).toBeVisible()

		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/settings/locations') &&
					res.request().method() === 'POST',
			),
			saveBtn.click(),
		])

		// Verify redirect to locations list
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/settings/locations$`))
		await page.waitForLoadState('networkidle')

		// Verify location appears in the table
		await expect(page.getByText(locationName)).toBeVisible()

		// Verify in SQLite database
		const [createdLocation] = await db
			.select()
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, org.id),
					eq(OrganizationLocation.slug, locationSlug),
				),
			)
			.limit(1)

		expect(createdLocation).toBeTruthy()
		expect(createdLocation?.name).toContain(locationName)
		expect(createdLocation?.phone).toBe(phone)
		expect(createdLocation?.prepTime).toBe(25)

		// 6. Edit Location
		await page.getByText(locationName).click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/settings/locations/${createdLocation?.id}`),
		)
		await page.waitForLoadState('networkidle')

		// Verify form loaded existing values
		await expect(page.getByLabel(/url slug/i)).toHaveValue(locationSlug)

		// Modify phone number
		const updatedPhone = '555-0200'
		const editPhoneInput = page.getByLabel(/phone number/i)
		await editPhoneInput.fill(updatedPhone)

		// Save edits
		const updateBtn = page.getByRole('button', { name: /save changes/i })
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes(`/settings/locations/${createdLocation?.id}`) &&
					res.request().method() === 'POST',
			),
			updateBtn.click(),
		])

		await expect(page).toHaveURL(new RegExp(`/${org.slug}/settings/locations$`))

		// Verify update persisted in DB
		const [updatedDbLocation] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, createdLocation!.id))
			.limit(1)
		expect(updatedDbLocation?.phone).toBe(updatedPhone)

		// 7. Test Location Switching in Team Switcher
		// Open team switcher in sidebar
		const teamSwitcherTrigger = page
			.getByRole('button', { name: new RegExp(org.name, 'i') })
			.first()

		await expect(teamSwitcherTrigger).toBeVisible()
		// Initial subtitle should show "All locations"
		await expect(teamSwitcherTrigger.getByText(/all locations/i)).toBeVisible()

		// Open dropdown
		await teamSwitcherTrigger.click()

		// Dropdown menu should show locations items
		await expect(
			page.getByRole('menuitem', { name: /all locations/i }),
		).toBeVisible()

		// Click the created location item
		const locationMenuItem = page.getByRole('menuitem', {
			name: new RegExp(locationName, 'i'),
		})
		await expect(locationMenuItem).toBeVisible()

		// Trigger background selection update
		await locationMenuItem.click()

		// Subtitle should now display the selected location name
		await expect(teamSwitcherTrigger.getByText(locationName)).toBeVisible()

		// Open dropdown again and switch back to "All locations"
		await teamSwitcherTrigger.click()
		const allLocationsMenuItem = page.getByRole('menuitem', {
			name: /all locations/i,
		})
		await allLocationsMenuItem.click()

		// Subtitle returns to "All locations"
		await expect(teamSwitcherTrigger.getByText(/all locations/i)).toBeVisible()
	})
})
