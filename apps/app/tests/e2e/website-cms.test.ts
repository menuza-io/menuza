import { faker } from '@faker-js/faker'
import {
	and,
	db,
	eq,
	like,
	OrganizationAnnouncement,
	WebsitePage,
} from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Website CMS & Announcements', () => {
	test('Operators can create, view, publish, unpublish, and delete website pages', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/website/pages', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Step 1: Open "New Page" dialog
		const newPageButton = page.getByRole('button', { name: /new page/i })
		await expect(newPageButton).toBeVisible()
		await newPageButton.click()

		await expect(
			page.getByRole('heading', { name: /choose a template/i }),
		).toBeVisible()

		// Click "Next" on template step
		await page.getByRole('button', { name: /^next$/i }).click()

		// Step 2: Fill in page details
		await expect(page.getByRole('heading', { name: /new page/i })).toBeVisible()

		const pageTitle = `Test Page ${faker.string.alphanumeric(6)}`
		const pageSlug = `test-page-${faker.string.alphanumeric(6).toLowerCase()}`

		await page.getByLabel(/page title/i).fill(pageTitle)
		await page.getByLabel(/page url/i).fill(pageSlug)

		// Submit creation
		await page.getByRole('button', { name: /^create$/i }).click()

		// Should redirect to page builder
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/website/pages/[^/]+$`),
		)

		// Verify page was created in database
		const [createdDbPage] = await db
			.select({
				id: WebsitePage.id,
				title: WebsitePage.title,
				status: WebsitePage.status,
			})
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, org.id),
					eq(WebsitePage.slug, pageSlug),
				),
			)
			.limit(1)

		expect(createdDbPage).toBeTruthy()
		expect(createdDbPage?.title).toBe(pageTitle)
		expect(createdDbPage?.status).toBe('draft')

		// Navigate back to the pages table
		await navigate('/:slug/website/pages', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify row is rendered
		const pageRow = page.getByRole('row').filter({ hasText: pageTitle })
		await expect(pageRow).toBeVisible()
		await expect(pageRow.getByText(/draft/i)).toBeVisible()

		// Step 3: Publish the page via action menu
		await pageRow.getByRole('button', { name: /page actions/i }).click()
		await page.getByRole('menuitem', { name: /^publish$/i }).click()

		// Status should update to Published
		await expect(pageRow.getByText(/published/i)).toBeVisible()
		// The status is optimistic. Wait for the save before reading the database.
		await expect(
			pageRow.getByRole('button', { name: /page actions/i }),
		).toBeEnabled()

		const [publishedDbPage] = await db
			.select({ status: WebsitePage.status })
			.from(WebsitePage)
			.where(eq(WebsitePage.id, createdDbPage!.id))
			.limit(1)
		expect(publishedDbPage?.status).toBe('published')

		// Step 4: Unpublish the page
		await pageRow.getByRole('button', { name: /page actions/i }).click()
		await page.getByRole('menuitem', { name: /^unpublish$/i }).click()

		// Status should revert to Draft
		await expect(pageRow.getByText(/draft/i)).toBeVisible()
		await expect(
			pageRow.getByRole('button', { name: /page actions/i }),
		).toBeEnabled()

		// Step 5: Delete the page
		await pageRow.getByRole('button', { name: /page actions/i }).click()
		await page.getByRole('menuitem', { name: /^delete$/i }).click()

		// Confirm in AlertDialog
		await expect(page.getByRole('alertdialog')).toBeVisible()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: /^delete$/i })
			.click()

		// Wait for deletion and verify row disappears
		await expect(
			page.getByRole('row').filter({ hasText: pageTitle }),
		).not.toBeVisible()

		// Verify database removal
		const [deletedDbPage] = await db
			.select({ id: WebsitePage.id })
			.from(WebsitePage)
			.where(eq(WebsitePage.id, createdDbPage!.id))
			.limit(1)
		expect(deletedDbPage).toBeUndefined()
	})

	test('Operators can create, toggle, and delete announcements', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/website/announcements', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Open "Add announcement" sheet
		const addAnnouncementBtn = page.getByRole('button', {
			name: /add announcement/i,
		})
		await expect(addAnnouncementBtn).toBeVisible()
		await addAnnouncementBtn.click()

		await expect(
			page.getByRole('heading', { name: /new announcement/i }),
		).toBeVisible()

		const announcementText = `Important update: ${faker.string.alphanumeric(8)}`
		await page.getByLabel(/content/i).fill(announcementText)

		// Submit announcement creation inside sheet
		await page
			.getByRole('dialog')
			.getByRole('button', { name: /add announcement/i })
			.click()

		// Sheet should close and announcement should appear in table
		await expect(
			page.getByRole('heading', { name: /new announcement/i }),
		).toBeHidden()

		const announcementRow = page
			.getByRole('row')
			.filter({ hasText: announcementText })
		await expect(announcementRow).toBeVisible()

		// Toggle visibility switch
		const toggleSwitch = announcementRow.getByRole('switch', {
			name: /toggle announcement visibility/i,
		})
		await expect(toggleSwitch).toBeVisible()
		const initialChecked = await toggleSwitch.getAttribute('aria-checked')

		await toggleSwitch.click()
		const expectedChecked = initialChecked === 'true' ? 'false' : 'true'
		await expect(toggleSwitch).toHaveAttribute('aria-checked', expectedChecked)

		// Delete announcement
		await announcementRow
			.getByRole('button', { name: /announcement actions/i })
			.click()
		await page.getByRole('menuitem', { name: /^delete$/i }).click()

		// Confirm in AlertDialog
		await expect(page.getByRole('alertdialog')).toBeVisible()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: /^delete$/i })
			.click()

		// Verify announcement is removed
		await expect(
			page.getByRole('row').filter({ hasText: announcementText }),
		).not.toBeVisible()

		// Verify database removal
		const [dbAnnouncement] = await db
			.select({ id: OrganizationAnnouncement.id })
			.from(OrganizationAnnouncement)
			.where(
				and(
					eq(OrganizationAnnouncement.organizationId, org.id),
					like(OrganizationAnnouncement.content, `%${announcementText}%`),
				),
			)
			.limit(1)
		expect(dbAnnouncement).toBeUndefined()
	})
})
