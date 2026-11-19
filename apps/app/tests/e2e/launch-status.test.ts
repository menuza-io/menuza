import { faker } from '@faker-js/faker'
import { expect, test } from '#tests/playwright-utils.ts'

test.describe.serial('Launch Status Flows', () => {
	test.afterEach(async ({ page }) => {
		// Reset mock launch status
		await page.request.post('/api/mock-env', {
			form: { status: '' },
		})
	})

	test('CLOSED_BETA: user is redirected to waitlist and blocked from org creation', async ({
		page,
		login,
		navigate,
	}) => {
		// Set status to CLOSED_BETA
		const mockRes = await page.request.post('/api/mock-env', {
			form: { status: 'CLOSED_BETA' },
		})
		expect(mockRes.ok()).toBeTruthy()

		await login()

		// If a new user logs in, they should be taken to waitlist
		await navigate('/')
		await expect(page).toHaveURL(/.*\/waitlist.*/)

		// They should see the waitlist UI
		await expect(page.getByText(/you're on the waitlist/i)).toBeVisible()

		// They should be blocked from going to organizations/create directly
		await page.goto('/organizations/create')
		await expect(page).toHaveURL(/.*\/waitlist.*/)
	})

	test('PUBLIC_BETA: user can create organization but billing is hidden', async ({
		page,
		login,
		navigate,
	}) => {
		// Set status to PUBLIC_BETA
		const mockRes = await page.request.post('/api/mock-env', {
			form: { status: 'PUBLIC_BETA' },
		})
		expect(mockRes.ok()).toBeTruthy()

		await login()

		// A new user logging in without an org should be taken to org creation
		await navigate('/')
		await expect(page).toHaveURL(/.*\/organizations\/create.*/)

		// Create an organization
		const orgName = faker.company.name()
		const orgSlug = 'test-org-' + faker.string.alphanumeric(5).toLowerCase()
		// Retry until the form has hydrated; an early fill is wiped on hydration.
		await expect(async () => {
			const nameInput = page.getByRole('textbox', { name: /name/i })
			await nameInput.fill(orgName)
			await page
				.getByRole('textbox', { name: /description/i })
				.fill('Test Description')
			await page.getByRole('textbox', { name: /slug/i }).fill(orgSlug)
			await expect(nameInput).toHaveValue(orgName, { timeout: 1000 })
			await expect(page.getByRole('textbox', { name: /slug/i })).toHaveValue(
				orgSlug,
				{ timeout: 1000 },
			)
		}).toPass()

		// Submit the form (Step 1)
		await page.getByRole('button', { name: /continue/i }).click()

		// Wait for step 2 or 3 to load
		await expect(page).toHaveURL(/step=[23]/)
		if (page.url().includes('step=2')) {
			// We're on invitations step - skip it
			await page.getByRole('button', { name: /skip for now/i }).click()
			await expect(page).toHaveURL(/step=3/)
		}

		// Now we should be on the additional info step
		const sizeOption = page.getByRole('option', { name: /1-10 employees/i })
		await expect(async () => {
			if (!(await sizeOption.isVisible())) {
				await page.getByRole('combobox').first().click()
			}
			await expect(sizeOption).toBeVisible({ timeout: 2000 })
		}).toPass()
		await sizeOption.click()

		const deptOption = page.getByRole('option', { name: /engineering/i })
		await expect(async () => {
			if (!(await deptOption.isVisible())) {
				await page.getByRole('combobox').last().click()
			}
			await expect(deptOption).toBeVisible({ timeout: 2000 })
		}).toPass()
		await deptOption.click()
		await page.getByRole('button', { name: /complete setup/i }).click()
		await page.getByRole('button', { name: /finish onboarding/i }).click()

		// Should go to the org dashboard
		await expect(page).toHaveURL(new RegExp(`/${orgSlug}`))

		// Navigate to settings
		await navigate(`/${orgSlug}/settings`)

		// Billing should NOT be visible in public beta
		await expect(
			page.getByRole('link', { name: /^billing$/i }),
		).not.toBeVisible()
	})

	test('LAUNCHED: user can create organization and billing is available', async ({
		page,
		login,
		navigate,
	}) => {
		// Set status to LAUNCHED
		const mockRes = await page.request.post('/api/mock-env', {
			form: { status: 'LAUNCHED' },
		})
		expect(mockRes.ok()).toBeTruthy()

		await login()

		// Go to org creation
		await navigate('/')
		await expect(page).toHaveURL(/.*\/organizations\/create.*/)

		// Create an organization
		const orgName = faker.company.name()
		const orgSlug = 'test-org-' + faker.string.alphanumeric(5).toLowerCase()
		// Retry until the form has hydrated; an early fill is wiped on hydration.
		await expect(async () => {
			const nameInput = page.getByRole('textbox', { name: /name/i })
			await nameInput.fill(orgName)
			await page
				.getByRole('textbox', { name: /description/i })
				.fill('Test Description')
			await page.getByRole('textbox', { name: /slug/i }).fill(orgSlug)
			await expect(nameInput).toHaveValue(orgName, { timeout: 1000 })
			await expect(page.getByRole('textbox', { name: /slug/i })).toHaveValue(
				orgSlug,
				{ timeout: 1000 },
			)
		}).toPass()

		// Submit the form (Step 1)
		await page.getByRole('button', { name: /continue/i }).click()

		// Wait for step 2 or 3 to load
		await expect(page).toHaveURL(/step=[23]/)
		if (page.url().includes('step=2')) {
			// We're on invitations step - skip it
			await page.getByRole('button', { name: /skip for now/i }).click()
			await expect(page).toHaveURL(/step=3/)
		}

		// Now we should be on the additional info step
		const sizeOption = page.getByRole('option', { name: /1-10 employees/i })
		await expect(async () => {
			if (!(await sizeOption.isVisible())) {
				await page.getByRole('combobox').first().click()
			}
			await expect(sizeOption).toBeVisible({ timeout: 2000 })
		}).toPass()
		await sizeOption.click()

		const deptOption = page.getByRole('option', { name: /engineering/i })
		await expect(async () => {
			if (!(await deptOption.isVisible())) {
				await page.getByRole('combobox').last().click()
			}
			await expect(deptOption).toBeVisible({ timeout: 2000 })
		}).toPass()
		await deptOption.click()
		await page.getByRole('button', { name: /complete setup/i }).click()
		await page.getByRole('button', { name: /finish onboarding/i }).click()

		// Should go to the org dashboard
		await expect(page).toHaveURL(new RegExp(`/${orgSlug}`))

		// Navigate to settings
		await navigate(`/${orgSlug}/settings`)

		// Billing SHOULD be visible in LAUNCHED status
		await expect(page.getByRole('link', { name: /^billing$/i })).toBeVisible()
	})
})
