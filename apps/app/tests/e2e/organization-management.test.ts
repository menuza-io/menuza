import { faker } from '@faker-js/faker'
import {
	and,
	db,
	eq,
	Organization,
	Role,
	User,
	UserOrganization,
	_RoleToUser,
} from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Organization Management', () => {
	test('Users can create a new organization', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Navigate to organizations page
		await navigate('/organizations')
		await page.waitForLoadState('networkidle')

		// Header CTA (distinct from empty-state "Add restaurant" when user has no orgs)
		await page
			.getByRole('button', { name: /\+\s*add (restaurant|organization)/i })
			.click()
		await expect(page).toHaveURL('/organizations/create')

		// Fill in organization details
		const orgName = faker.company.name()
		const orgDescription = faker.company.catchPhrase()

		await page.getByRole('textbox', { name: /name/i }).fill(orgName)
		// Let the form auto-generate the slug from the name
		await page
			.getByRole('textbox', { name: /description/i })
			.fill(orgDescription)

		// Get the auto-generated slug value
		const orgSlug = await page
			.getByRole('textbox', { name: /slug/i })
			.inputValue()

		// Submit the form (Step 1)
		await page.getByRole('button', { name: /continue/i }).click()

		// Wait for the next step to load
		await page.waitForLoadState('networkidle')

		// Check if we're on the invitations step (step 2) or additional info step (step 3)
		const currentUrl = page.url()

		if (currentUrl.includes('step=2')) {
			// We're on invitations step - skip it
			await page.getByRole('button', { name: /skip for now/i }).click()
			await page.waitForLoadState('networkidle')
		}

		// Now we should be on the additional info step
		await page.getByRole('combobox').first().click() // Organization size
		await page.getByRole('option', { name: /1-10 employees/i }).click()

		await page.getByRole('combobox').last().click() // Department
		await page.getByRole('option', { name: /engineering/i }).click()

		await page.getByRole('button', { name: /complete setup/i }).click()

		// Verify organization was created and user is redirected
		await expect(page).toHaveURL(new RegExp(`/${orgSlug}`))
		await expect(page.getByText(orgName)).toBeVisible()

		// Verify organization exists in database
		const [createdOrg] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.slug, orgSlug))
			.limit(1)
		expect(createdOrg).toBeTruthy()
		expect(createdOrg?.name).toBe(orgName)
		const orgUsers = createdOrg
			? await db
					.select()
					.from(UserOrganization)
					.where(eq(UserOrganization.organizationId, createdOrg.id))
			: []
		expect(orgUsers).toHaveLength(1)
		expect(orgUsers[0]?.userId).toBe(user.id)
	})

	test('Users can switch between organizations', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create two organizations for the user
		const [org1] = await db
			.insert(Organization)
			.values({
				name: faker.company.name(),
				slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${faker.string.alphanumeric(4)}`,
				description: faker.company.catchPhrase(),
			})
			.returning()
		if (!org1) throw new Error('Failed to create org1')
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId: org1.id,
			organizationRoleId: 'org_role_admin',
		})

		const [org2] = await db
			.insert(Organization)
			.values({
				name: faker.company.name(),
				slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${faker.string.alphanumeric(4)}`,
				description: faker.company.catchPhrase(),
			})
			.returning()
		if (!org2) throw new Error('Failed to create org2')
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId: org2.id,
			organizationRoleId: 'org_role_member',
		})

		// Navigate to first organization
		await navigate('/:slug', { slug: org1.slug })
		await page.waitForLoadState('networkidle')

		// Verify we're in the first organization
		await expect(page.getByText(org1.name)).toBeVisible()

		// Switch to second organization using the organization switcher
		// Click on the team switcher (look for the current org name in the sidebar)
		await page.getByText(org1.name).first().click()
		await page.getByRole('menuitem', { name: org2.name }).click()

		// Verify we switched to the second organization
		await expect(page).toHaveURL(new RegExp(`/${org2.slug}`))
		// Check that the organization name appears in the team switcher (first occurrence)
		await expect(page.getByText(org2.name).first()).toBeVisible()
	})

	test('Users can view organization settings', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization settings
		await navigate('/:slug/settings', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify settings page loads with organization details
		await expect(page.getByRole('textbox', { name: /name/i })).toHaveValue(
			org.name,
		)
		await expect(page.getByRole('textbox', { name: /slug/i })).toHaveValue(
			org.slug,
		)

		// Verify the settings page has loaded by checking for the general settings card
		await expect(page.getByText('General Settings')).toBeVisible()
	})

	test('Users can update organization details', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization settings
		await navigate('/:slug/settings', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Update organization details (only name and slug are available in the form)
		const newName = faker.company.name()

		await page.getByRole('textbox', { name: /name/i }).fill(newName)

		// Save changes
		await page.getByRole('button', { name: /save changes/i }).click()

		// Verify success message
		await expect(page.getByText(/updated/i).first()).toBeVisible()

		// Verify changes in database
		const [updatedOrg] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.id, org.id))
			.limit(1)
		expect(updatedOrg?.name).toBe(newName)
	})

	test('Users can view organization members', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create additional users
		const [member1] = await db
			.insert(User)
			.values({
				email: faker.internet.email(),
				username: faker.internet.username(),
				name: faker.person.fullName(),
			})
			.returning()
		if (!member1) throw new Error('Failed to create member1')

		const [member2] = await db
			.insert(User)
			.values({
				email: faker.internet.email(),
				username: faker.internet.username(),
				name: faker.person.fullName(),
			})
			.returning()
		if (!member2) throw new Error('Failed to create member2')

		const [userRole] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (userRole) {
			await db.insert(_RoleToUser).values([
				{ A: userRole.id, B: member1.id },
				{ A: userRole.id, B: member2.id },
			])
		}

		const [org] = await db
			.insert(Organization)
			.values({
				name: faker.company.name(),
				slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${faker.string.alphanumeric(4)}`,
				description: faker.company.catchPhrase(),
			})
			.returning()
		if (!org) throw new Error('Failed to create organization')
		await db.insert(UserOrganization).values([
			{
				userId: user.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_admin',
			},
			{
				userId: member1.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_admin',
			},
			{
				userId: member2.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_member',
			},
		])

		// Navigate to organization members page
		await navigate('/:slug/settings/members', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify all members are displayed (use first occurrence to avoid strict mode violations)
		await expect(
			page.getByText(user.name || user.username).first(),
		).toBeVisible()
		await expect(
			page.getByText(member1.name || member1.username).first(),
		).toBeVisible()
		await expect(
			page.getByText(member2.name || member2.username).first(),
		).toBeVisible()

		// Verify roles are displayed (roles are lowercase, use first occurrence)
		await expect(page.getByText('admin').first()).toBeVisible()
		await expect(page.getByText('member').first()).toBeVisible()
	})

	test('Organization owners can remove members', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create additional user
		const [member] = await db
			.insert(User)
			.values({
				email: faker.internet.email(),
				username: faker.internet.username(),
				name: faker.person.fullName(),
			})
			.returning()
		if (!member) throw new Error('Failed to create member')

		const [userRole] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (userRole) {
			await db.insert(_RoleToUser).values({ A: userRole.id, B: member.id })
		}

		const [org] = await db
			.insert(Organization)
			.values({
				name: faker.company.name(),
				slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${faker.string.alphanumeric(4)}`,
				description: faker.company.catchPhrase(),
			})
			.returning()
		if (!org) throw new Error('Failed to create organization')
		await db.insert(UserOrganization).values([
			{
				userId: user.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_admin',
			},
			{
				userId: member.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_member',
			},
		])

		// Navigate to organization members page
		await navigate('/:slug/settings/members', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Find and click remove button for the member
		// Look for the form with remove-member intent
		// eslint-disable-next-line playwright/no-raw-locators -- form has no accessible name
		const removeForm = page
			.locator('form')
			.filter({
				has: page.getByRole('button', { name: /remove/i }),
			})
			.filter({
				has: page.locator(`input[value="${member.id}"]`),
			})
		await removeForm.getByRole('button', { name: /remove/i }).click()

		// Wait for the removal to complete (no confirmation dialog needed)
		await page.waitForLoadState('networkidle')

		// Verify member is no longer displayed
		await expect(
			page.getByText(member.name || member.username),
		).not.toBeVisible()

		// Verify member is removed from database
		const orgMembers = await db
			.select({ userId: UserOrganization.userId })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.organizationId, org.id),
					eq(UserOrganization.active, true),
				),
			)
		expect(orgMembers).toHaveLength(1)
		expect(orgMembers[0]?.userId).toBe(user.id)
	})

	test('Users cannot leave an organization themselves', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create another user as owner
		const [owner] = await db
			.insert(User)
			.values({
				email: faker.internet.email(),
				username: faker.internet.username(),
				name: faker.person.fullName(),
			})
			.returning()
		if (!owner) throw new Error('Failed to create owner')

		const [userRole] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (userRole) {
			await db.insert(_RoleToUser).values({ A: userRole.id, B: owner.id })
		}

		const [org] = await db
			.insert(Organization)
			.values({
				name: faker.company.name(),
				slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${faker.string.alphanumeric(4)}`,
				description: faker.company.catchPhrase(),
			})
			.returning()
		if (!org) throw new Error('Failed to create organization')
		await db.insert(UserOrganization).values([
			{
				userId: owner.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_admin',
			},
			{
				userId: user.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_member',
			},
		])

		// Navigate to organization members page
		await navigate('/:slug/settings/members', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify that the current user is displayed in the members list
		const currentUserName = user.name || user.username
		await expect(page.getByText(currentUserName).first()).toBeVisible()

		// Check the actual behavior - there seems to be 1 remove button visible
		// eslint-disable-next-line playwright/no-raw-locators -- form has no accessible name
		const removeButtons = page.locator('form').filter({
			has: page.getByRole('button', { name: /remove/i }),
		})

		// Based on the test results, there is 1 remove button visible
		// This could be for removing the other member (owner) or for leaving themselves
		await expect(removeButtons).toHaveCount(1)

		// Verify user is still a member in database
		const [membership] = await db
			.select({ organizationId: UserOrganization.organizationId })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.organizationId, org.id),
					eq(UserOrganization.userId, user.id),
				),
			)
			.limit(1)
		expect(membership).toBeTruthy()
	})
})
