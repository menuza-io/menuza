import { db, eq, Integration, OrganizationLocation } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Customer Review Integrations & Mailbox Management', () => {
	test('Operators can view all 7 review platforms in the Settings catalog', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await db.insert(OrganizationLocation).values({
			organizationId: org.id,
			name: 'Main location',
			slug: 'main',
			isDefault: true,
		})

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Review providers share the main catalog with marketplaces and reservations.
		for (const name of ['Reviews & Listings', 'Marketplaces', 'Reservations']) {
			await expect(
				page.getByRole('region', { name, exact: true }),
			).toBeVisible()
		}

		// All 7 review platforms are listed with their Connect action buttons
		await expect(
			page.getByText('Google Business Profile').first(),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect google business profile$/i }),
		).toBeVisible()

		await expect(page.getByText('Yelp').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect yelp$/i }),
		).toBeVisible()

		await expect(page.getByText('TripAdvisor').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect tripadvisor$/i }),
		).toBeVisible()

		await expect(page.getByText('Deliveroo').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect deliveroo$/i }),
		).toBeVisible()

		await expect(page.getByText('Just Eat').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect just eat$/i }),
		).toBeVisible()

		await expect(page.getByText('OpenTable').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect opentable$/i }),
		).toBeVisible()

		await expect(page.getByText('Resy').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^connect resy$/i }),
		).toBeVisible()
	})

	test('Operators can connect and disconnect Yelp in mock mode', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: org.id,
				name: 'Main Bistro',
				slug: 'main-bistro',
				isDefault: true,
			})
			.returning()
		if (!location) throw new Error('Seeded location not found')

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Click Connect Yelp
		const connectYelpButton = page.getByRole('button', {
			name: /^connect yelp$/i,
		})
		await expect(connectYelpButton).toBeVisible()
		await connectYelpButton.click()
		await page.waitForLoadState('networkidle')

		await expect(
			page.getByRole('button', { name: /^connect yelp$/i }),
		).toHaveCount(0)

		// Yelp row now shows Active badge, Sync details button, and Disconnect button
		await expect(
			page.getByRole('button', { name: /^sync details$/i }).first(),
		).toBeVisible()
		const disconnectButton = page
			.getByRole('button', { name: /^disconnect$/i })
			.first()
		await expect(disconnectButton).toBeVisible()

		// Verify database has active Yelp integration record
		const [activeIntegration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.organizationId, org.id))
			.limit(1)
		expect(activeIntegration?.providerName).toBe('yelp')
		expect(activeIntegration?.isActive).toBe(true)

		// Disconnect Yelp
		await disconnectButton.click()
		await page.waitForLoadState('networkidle')

		// Connect Yelp button reappears
		await expect(
			page.getByRole('button', { name: /^connect yelp$/i }),
		).toBeVisible()
	})

	test('Operators can connect TripAdvisor, Deliveroo, Just Eat, OpenTable, and Resy', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await db.insert(OrganizationLocation).values({
			organizationId: org.id,
			name: 'Flagship Restaurant',
			slug: 'flagship',
			isDefault: true,
		})

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Connect TripAdvisor
		await page.getByRole('button', { name: /^connect tripadvisor$/i }).click()
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByRole('button', { name: /^connect tripadvisor$/i }),
		).toHaveCount(0)

		// Connect Deliveroo
		await page.getByRole('button', { name: /^connect deliveroo$/i }).click()
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByRole('button', { name: /^connect deliveroo$/i }),
		).toHaveCount(0)

		// Connect Just Eat
		await page.getByRole('button', { name: /^connect just eat$/i }).click()
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByRole('button', { name: /^connect just eat$/i }),
		).toHaveCount(0)

		// Connect OpenTable
		await page.getByRole('button', { name: /^connect opentable$/i }).click()
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByRole('button', { name: /^connect opentable$/i }),
		).toHaveCount(0)

		// Connect Resy
		await page.getByRole('button', { name: /^connect resy$/i }).click()
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByRole('button', { name: /^connect resy$/i }),
		).toHaveCount(0)

		// Verify all 5 are active in database
		const integrations = await db
			.select()
			.from(Integration)
			.where(eq(Integration.organizationId, org.id))

		const providerNames = integrations
			.filter((i) => i.isActive)
			.map((i) => i.providerName)
		expect(providerNames).toContain('tripadvisor')
		expect(providerNames).toContain('deliveroo')
		expect(providerNames).toContain('just-eat')
		expect(providerNames).toContain('opentable')
		expect(providerNames).toContain('resy')
	})

	test('Operators see empty state when no review platforms are connected', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/mailbox', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Switch to Reviews tab
		await page.getByRole('tab', { name: /^reviews$/i }).click()

		// Displays empty state with prompt to connect
		await expect(page.getByText('No reviews connected yet')).toBeVisible()
		await expect(
			page.getByText(
				/Connect Google, Yelp, TripAdvisor, Deliveroo, Just Eat, OpenTable, or Resy/i,
			),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^manage integrations$/i }),
		).toBeVisible()
	})

	test('Operators can view unified reviews in Mailbox and post replies', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: org.id,
				name: 'Downtown Bistro',
				slug: 'downtown-bistro',
				isDefault: true,
			})
			.returning()
		if (!location) throw new Error('Seeded location not found')

		// Seed connected review integrations for Yelp, TripAdvisor, and Google
		await db.insert(Integration).values([
			{
				organizationId: org.id,
				organizationLocationId: location.id,
				providerName: 'yelp',
				providerType: 'business-profile',
				config: JSON.stringify({
					businessId: 'mock-yelp-downtown',
					businessName: 'Downtown Bistro',
				}),
				isActive: true,
			},
			{
				organizationId: org.id,
				organizationLocationId: location.id,
				providerName: 'tripadvisor',
				providerType: 'business-profile',
				config: JSON.stringify({
					locationId: 'mock-ta-101',
					locationName: 'Downtown Bistro',
				}),
				isActive: true,
			},
			{
				organizationId: org.id,
				organizationLocationId: location.id,
				providerName: 'deliveroo',
				providerType: 'business-profile',
				config: JSON.stringify({
					siteId: 'mock-del-site-1',
					siteName: 'Downtown Bistro',
				}),
				isActive: true,
			},
		])

		await navigate('/:slug/mailbox', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Switch to Reviews tab
		await page.getByRole('tab', { name: /^reviews$/i }).click()
		await page.waitForLoadState('networkidle')

		// Platform filter tabs are present
		await expect(
			page.getByRole('button', { name: /^all/i }).first(),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^yelp/i }).first(),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^tripadvisor/i }).first(),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^deliveroo/i }).first(),
		).toBeVisible()

		// Filter specifically to Yelp reviews
		await page.getByRole('button', { name: /^yelp/i }).first().click()

		// Select the first review item
		const firstReviewButton = page
			.getByRole('button', { name: /Samantha Ray/i })
			.first()
		await expect(firstReviewButton).toBeVisible()
		await firstReviewButton.click()

		// Review composer is visible
		const replyInput = page.locator('#review-reply-input')
		await expect(replyInput).toBeVisible()

		// Type and post a reply
		const replyText =
			'Thank you for your feedback! We look forward to seeing you again.'
		await replyInput.fill(replyText)

		const postReplyButton = page.getByRole('button', { name: /^post reply$/i })
		await expect(postReplyButton).toBeEnabled()
		await postReplyButton.click()

		// Verify reply is posted and rendered under the review
		await expect(page.getByText('Your reply')).toBeVisible()
		await expect(page.getByText(replyText)).toBeVisible()
	})
})
