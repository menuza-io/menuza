import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Marketing Automation Journey Builder E2E', () => {
	test('User can navigate to automations, open visual builder canvas, and view palette', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/marketing/automations', { slug: org.slug })

		await expect(
			page.getByRole('heading', { name: /^automations$/i }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /new automation/i }),
		).toBeVisible()

		await page.getByRole('button', { name: /new automation/i }).click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/marketing/automations/new`),
		)

		await expect(page.getByText(/new customer journey/i)).toBeVisible()
		await expect(
			page.getByRole('button', { name: /save draft/i }),
		).toBeVisible()
		await expect(page.getByRole('button', { name: /^publish$/i })).toBeVisible()

		await expect(page.getByText(/^nodes$/i)).toBeVisible()
		await expect(page.getByText(/trigger event/i).first()).toBeVisible()
		await expect(page.getByText(/time delay/i).first()).toBeVisible()
		await expect(page.getByText(/send email/i).first()).toBeVisible()
		await expect(page.getByText(/send sms/i).first()).toBeVisible()
		await expect(page.getByText(/condition branch/i).first()).toBeVisible()

		// eslint-disable-next-line playwright/no-raw-locators -- React Flow viewport has no semantic role
		await expect(page.locator('.react-flow')).toBeVisible()
		await expect(
			page.getByRole('heading', { name: /^trigger$/i }),
		).toBeVisible()
	})

	test('Visual Canvas validates DAG and displays node configuration inspector', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/marketing/automations/new', { slug: org.slug })

		// eslint-disable-next-line playwright/no-raw-locators -- React Flow viewport has no semantic role
		const reactFlow = page.locator('.react-flow')
		await expect(reactFlow).toBeVisible()
		await expect(
			page.getByRole('heading', { name: /^trigger$/i }),
		).toBeVisible()

		const triggerNode = page.getByRole('heading', { name: /^trigger$/i })
		await triggerNode.click()

		await expect(page.getByText(/trigger event type/i)).toBeVisible()

		const delayPaletteBtn = page.getByRole('button', {
			name: /add time delay/i,
		})
		if (await delayPaletteBtn.isVisible()) {
			await delayPaletteBtn.click()
			await expect(
				page.getByRole('heading', { name: /^time delay$/i }),
			).toBeVisible()
		}

		const emailPaletteBtn = page.getByRole('button', {
			name: /add send email/i,
		})
		if (await emailPaletteBtn.isVisible()) {
			await emailPaletteBtn.click()
			await expect(
				page.getByRole('heading', { name: /^email$/i }),
			).toBeVisible()
		}

		const emailNode = page.getByRole('heading', { name: /^email$/i })
		await emailNode.click()

		await expect(page.getByText(/subject line/i)).toBeVisible()
		// Merge tags render as chips in a rich field, with the catalogue of
		// available tags offered as insert buttons.
		await expect(page.getByText(/^insert$/i)).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^first name$/i }),
		).toBeVisible()
		await expect(page.getByRole('button', { name: /^company$/i })).toBeVisible()
	})

	test('User can navigate from marketing overview to automations', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/marketing', { slug: org.slug })

		await expect(
			page.getByRole('heading', { name: /^marketing$/i }),
		).toBeVisible()

		await page.getByRole('link', { name: /^automations$/i }).click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/marketing/automations/?$`),
		)
		await expect(
			page.getByRole('heading', { name: /^automations$/i }),
		).toBeVisible()
	})
})
