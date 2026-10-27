import { type Page } from '@playwright/test'
import { PRINT_SHOP_FLAG_KEYS } from '@repo/common/print-shop'
import { and, ConfigFlag, db, eq, UserOrganization } from '@repo/database'
import { expect } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/** Shared steps of the Print shop specs (the core's and a vertical's). */

export type Role = 'admin' | 'member' | 'viewer' | 'guest'

export async function setFlags(organizationId: string, keys: string[]) {
	if (keys.length === 0) return
	await db.insert(ConfigFlag).values(
		keys.map((key) => ({
			key,
			value: true,
			level: 'organization' as const,
			organizationId,
		})),
	)
}

export async function setRole(
	userId: string,
	organizationId: string,
	role: Role,
) {
	await db
		.update(UserOrganization)
		.set({ organizationRoleId: `org_role_${role}` })
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
}

export async function setup(
	login: (options?: any) => Promise<{ id: string }>,
	options: { role?: Role; flags?: string[] } = {},
) {
	const user = await login()
	const org = await createTestOrganization(user.id, options.role ?? 'admin')
	await setFlags(org.id, options.flags ?? [PRINT_SHOP_FLAG_KEYS.enabled])
	return { user, org }
}

export const designUrl = (slug: string, id: string) =>
	`/${slug}/marketing/print/${id}`
export const downloadUrl = (
	slug: string,
	id: string,
	query = 'format=home&sheet=letter',
) => `${designUrl(slug, id)}/download?${query}`

/** A Base UI `Button` rendered as a link exposes the button role. */
export const linkOrButton = (page: Page, name: string | RegExp) =>
	page.getByRole('link', { name }).or(page.getByRole('button', { name }))

export async function createDesign(
	page: Page,
	slug: string,
	options: { product?: string; name?: string } = {},
) {
	await page.goto(`/${slug}/marketing/print/new`)
	await expect(
		page.getByRole('heading', { name: 'New print', level: 1 }),
	).toBeVisible()
	// Choices made before hydration are reset by the form state.
	await page.waitForLoadState('networkidle')
	if (options.product) {
		await page
			.getByRole('radio', { name: new RegExp(`^${options.product}`) })
			.click()
	}
	if (options.name) await page.getByLabel('Name').fill(options.name)
	await page.getByRole('button', { name: 'Continue' }).click()
	// `/print/new` matches the editor pattern too: wait for the redirect.
	await page.waitForURL(
		(url) =>
			/\/marketing\/print\/[^/]+$/.test(url.pathname) &&
			!url.pathname.endsWith('/new'),
	)
	return new URL(page.url()).pathname.split('/').at(-1)!
}

export async function saveAndApprove(page: Page, headline: string) {
	await page.getByLabel('Headline').first().fill(headline)
	await page.getByRole('button', { name: 'Save and update proof' }).click()
	await expect(
		page.frameLocator('iframe[title="Print proof"]').getByText(headline),
	).toBeVisible()
	await page.getByRole('button', { name: 'Approve proof' }).click()
	await expect(page.getByText('Free PDFs of the approved proof.')).toBeVisible()
}
