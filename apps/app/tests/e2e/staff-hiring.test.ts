import { ConfigFlag, db, eq, inArray, Organization } from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Hiring: a manager writes a job, publishes it, and the public careers JSON
 * serves it. Job postings are control-plane content, so no regional stub is
 * needed: the flag check, permission, editor, save and publish are all real.
 */

const SCREENSHOTS = 'test-results/staff'

async function enableHiring(organizationId: string) {
	const rows = await db
		.insert(ConfigFlag)
		.values(
			(['enabled', 'hiring'] as const).map((feature) => ({
				key: STAFFING_FLAG_KEYS[feature],
				value: true,
				level: 'organization' as const,
				organizationId,
			})),
		)
		.returning({ id: ConfigFlag.id })
	return rows.map((row) => row.id)
}

test.describe('Staff hiring', () => {
	test('is not found while hiring is off', async ({ login, navigate }) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/hiring', { slug: org.slug })
		expect(response?.status()).toBe(404)
	})

	test('a manager writes a job, publishes it, shares it and closes it', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const slug = org.slug.toLowerCase()
		await db
			.update(Organization)
			.set({ slug, sitePublished: true })
			.where(eq(Organization.id, org.id))
		const flagIds = await enableHiring(org.id)

		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/hiring', { slug })
			await expect(
				page.getByRole('heading', { name: 'Hiring', exact: true }),
			).toBeVisible()
			await expect(page.getByText('No jobs yet')).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/hiring-empty.png` })

			// A design-system Button that renders a link announces itself as a button.
			await page.getByRole('button', { name: 'Post a job' }).first().click()
			await expect(
				page.getByRole('heading', { name: 'What is the job?' }),
			).toBeVisible()

			// Step one will not move on without the basics.
			await page.getByRole('button', { name: 'Next' }).click()
			await expect(page.getByText('Give the job a title.')).toBeVisible()

			await page.getByLabel('Job title').fill('Evening line cook')
			await page.getByLabel('Position').fill('Line cook')
			await page.getByRole('textbox', { name: 'Description' }).click()
			await page.keyboard.type(
				'Cook on the line during busy dinner service, three nights a week.',
			)
			await page.getByRole('button', { name: 'Next' }).click()

			// Pay: shown as a range, checked before moving on.
			await expect(
				page.getByRole('heading', { name: 'What does it pay?' }),
			).toBeVisible()
			await page.getByLabel('Pay', { exact: true }).click()
			await page.getByRole('option', { name: 'Per hour' }).click()
			await page.getByLabel('From', { exact: true }).fill('18')
			await page.getByLabel('To', { exact: true }).fill('22')
			await page.getByRole('button', { name: 'Next' }).click()

			// Questions.
			await page.getByRole('button', { name: 'Yes or no question' }).click()
			await page
				.getByLabel('Yes or no question', { exact: true })
				.last()
				.fill('Can you work weekends?')
			await page.getByRole('button', { name: 'Next' }).click()

			// Review, then publish.
			await expect(
				page.getByRole('heading', { name: 'Check it over' }),
			).toBeVisible()
			await expect(page.getByText('$18.00 – $22.00 per hour')).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/hiring-review.png` })
			await page.getByRole('button', { name: 'Publish' }).click()
			await expect(page.getByText('Share this job')).toBeVisible()
			await expect(
				page.getByRole('img', { name: 'QR code that opens this job' }),
			).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/hiring-live.png` })

			// The public JSON route serves it, without the dealbreaker data.
			const response = await page.request.get(
				`/resources/sites/careers?slug=${slug}&posting=evening-line-cook`,
			)
			expect(response.status()).toBe(200)
			const body = await response.json()
			expect(body.posting.title).toBe('Evening line cook')
			expect(JSON.stringify(body)).not.toMatch(/dealbreaker|requiredAnswer/)

			// Close it: it leaves the public route.
			await page.getByRole('button', { name: 'Close this job' }).click()
			await page
				.getByRole('alertdialog')
				.getByRole('button', { name: 'Close', exact: true })
				.click()
			await expect(page.getByText('The job is closed.')).toBeVisible()
			const gone = await page.request.get(
				`/resources/sites/careers?slug=${slug}&posting=evening-line-cook`,
			)
			expect(gone.status()).toBe(404)
		} finally {
			await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		}
	})

	test('fits a phone without sideways scrolling', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const flagIds = await enableHiring(org.id)
		try {
			await page.setViewportSize({ width: 360, height: 740 })
			await navigate('/:slug/staff/hiring/new', { slug: org.slug })
			await expect(
				page.getByRole('heading', { name: 'What is the job?' }),
			).toBeVisible()
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth >
					document.documentElement.clientWidth,
			)
			expect(overflow).toBe(false)
			await page.screenshot({ path: `${SCREENSHOTS}/hiring-phone.png` })
		} finally {
			await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		}
	})

	test.describe('in Arabic', () => {
		test.use({ locale: 'ar-SA' })

		test('mirrors the editor for right-to-left reading', async ({
			page,
			login,
			navigate,
		}) => {
			const user = await login()
			const org = await createTestOrganization(user.id, 'admin')
			const flagIds = await enableHiring(org.id)
			try {
				await page.setViewportSize({ width: 1280, height: 800 })
				await navigate('/:slug/staff/hiring/new', { slug: org.slug })
				await expect(
					page.getByRole('heading', { name: 'ما هي الوظيفة؟' }),
				).toBeVisible()
				// eslint-disable-next-line playwright/no-raw-locators -- the document element has no role
				await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
				await page.screenshot({ path: `${SCREENSHOTS}/hiring-arabic.png` })
			} finally {
				await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
			}
		})
	})
})
