import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq, Organization } from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Region switch with staff records. The regional tenant-api is not part of this
 * test environment, so the App's summary route (which asks it for counts) cannot
 * reach a node: the guard must fail closed and ask for the slug. That is the
 * real route and the real dialog. The browser-direct export is stubbed, and the
 * wipe itself is never sent: the POST is captured and aborted. Counts, the
 * empty-region path and the server checks are covered by unit tests.
 */

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
}

async function stubExport(page: Page) {
	const exportRequests: string[] = []
	await page.route('**/operator/staff/export**', async (route) => {
		if (route.request().method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		exportRequests.push(route.request().headers()['authorization'] ?? '')
		return route.fulfill({
			status: 200,
			headers: { ...CORS, 'content-type': 'application/json' },
			body: JSON.stringify({
				format: 'staff-export/v1',
				exportedAt: Date.now(),
				orgId: 'org',
				region: 'us',
				includes: { pay: true, private: true },
				staff: [{ id: 'staff-1', firstName: 'Maya' }],
			}),
		})
	})
	return { exportRequests }
}

async function openRegionDialog(page: Page) {
	await page.getByRole('combobox', { name: 'Customer data region' }).click()
	await page.getByRole('option', { name: 'Saudi Arabia (KSA)' }).click()
	const dialog = page.getByRole('alertdialog')
	await expect(
		dialog.getByRole('heading', {
			name: 'Delete customer data and switch region?',
		}),
	).toBeVisible()
	return dialog
}

async function provisionedOrg(userId: string) {
	const org = await createTestOrganization(userId, 'admin')
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, dataRegion: 'us' })
		.where(eq(Organization.id, org.id))
	return org
}

test.describe('Region switch: staff guard', () => {
	test('fails closed, offers a backup, and needs the slug typed', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await provisionedOrg(user.id)
		const [flag] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS.enabled,
				value: true,
				level: 'organization',
				organizationId: org.id,
			})
			.returning({ id: ConfigFlag.id })
		const stub = await stubExport(page)
		const posts: string[] = []
		await page.route('**/website**', (route) => {
			const request = route.request()
			if (request.method() === 'POST') {
				posts.push(request.postData() ?? '')
				return route.abort()
			}
			return route.fallback()
		})

		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/website', { slug: org.slug })
			const dialog = await openRegionDialog(page)

			// No node to ask: the guard assumes there may be staff records.
			await expect(dialog.getByText(/could not check/)).toBeVisible()
			await expect(
				dialog.getByText('Staff records will be deleted too'),
			).toBeVisible()

			// The wipe is locked until the slug is typed.
			const wipe = dialog.getByRole('button', {
				name: 'Delete data and switch',
			})
			await expect(wipe).toBeDisabled()
			await dialog.getByLabel('Organization slug').fill('not-it')
			await expect(wipe).toBeDisabled()

			// The backup goes to the regional node with a bearer token from the App.
			const [download] = await Promise.all([
				page.waitForEvent('download'),
				dialog.getByRole('button', { name: 'Download staff backup' }).click(),
			])
			expect(download.suggestedFilename()).toMatch(
				new RegExp(
					`^staff-backup-${org.slug.toLowerCase()}-\\d{4}-\\d{2}-\\d{2}\\.json$`,
				),
			)
			await expect(dialog.getByText('Backup downloaded.')).toBeVisible()
			expect(stub.exportRequests).toHaveLength(1)
			expect(stub.exportRequests[0]).toMatch(/^Bearer .+/)
			await page.screenshot({ path: 'test-results/staff/region-guard.png' })

			await dialog.getByLabel('Organization slug').fill(org.slug)
			await expect(wipe).toBeEnabled()
			await wipe.click()
			await expect.poll(() => posts.length).toBeGreaterThan(0)
			const body = decodeURIComponent(posts[0]!)
			expect(body).toContain('confirmWipe')
			expect(body).toContain('confirmText')
			expect(body).toContain(org.slug)
		} finally {
			await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flag!.id))
		}
	})

	test('says plainly when a backup cannot be made (Staff is off)', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await provisionedOrg(user.id)
		await navigate('/:slug/website', { slug: org.slug })
		const dialog = await openRegionDialog(page)
		await dialog.getByRole('button', { name: 'Download staff backup' }).click()
		await expect(dialog.getByRole('alert')).toContainText(
			'The backup could not be created',
		)
		// The typed confirmation is still the gate.
		await expect(
			dialog.getByRole('button', { name: 'Delete data and switch' }),
		).toBeDisabled()
	})
})
