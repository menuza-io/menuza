import {
	type Browser,
	type BrowserContext,
	type Page,
	type Request,
} from '@playwright/test'
import { cookieConsentCookie } from '@repo/common/cookie-consent'
import {
	and,
	count,
	Dashboard,
	DashboardShare,
	db,
	eq,
	Notification,
	User,
	UserOrganization,
} from '@repo/database'
import * as setCookieParser from 'set-cookie-parser'
import { expect, test } from '#tests/playwright-utils.ts'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'

const DASHBOARD_NAME = 'Team board'
const NOT_FOUND_TEXT =
	'This dashboard does not exist or you do not have access to it.'

function dashboardBlock(page: Page, name: string) {
	return page.getByRole('main').getByRole('region', { name, exact: true })
}

function blockOrder(page: Page) {
	return page
		.getByRole('main')
		.getByRole('region')
		.evaluateAll((regions) =>
			regions.map((region) => region.getAttribute('aria-label')),
		)
}

function switcher(page: Page, label: string) {
	return page
		.getByRole('main')
		.getByRole('button', { name: label, exact: true })
}

function sharedWithMe(page: Page) {
	return page.getByRole('menu').getByRole('group', { name: 'Shared with me' })
}

function isPostTo(request: Request, pathname: string) {
	return (
		request.method() === 'POST' &&
		new URL(request.url()).pathname.replace(/\.data$/, '') === pathname
	)
}

function nextPostTo(page: Page, pathname: string) {
	return page.waitForResponse((response) =>
		isPostTo(response.request(), pathname),
	)
}

/** Sends a form POST from the page, the way a crafted request would. */
function postIntent(page: Page, path: string, fields: Record<string, string>) {
	return page.evaluate(
		async ({ path, fields }) => {
			const response = await fetch(path, {
				method: 'POST',
				body: new URLSearchParams(fields),
				redirect: 'manual',
			})
			return response.status
		},
		{ path, fields },
	)
}

const BOARD_CONFIG = {
	version: 1,
	blocks: [
		{ id: 'stats', type: 'stats' },
		{ id: 'leaderboard', type: 'leaderboard' },
	],
	layouts: {
		lg: [
			{ i: 'stats', x: 0, y: 0, w: 12, h: 2 },
			{ i: 'leaderboard', x: 0, y: 2, w: 6, h: 10 },
		],
		md: [
			{ i: 'stats', x: 0, y: 0, w: 8, h: 2 },
			{ i: 'leaderboard', x: 0, y: 2, w: 4, h: 10 },
		],
	},
}

async function insertCustomDashboard(input: {
	organizationId: string
	ownerId: string
}) {
	const [dashboard] = await db
		.insert(Dashboard)
		.values({
			...input,
			kind: 'custom',
			name: DASHBOARD_NAME,
			config: JSON.stringify(BOARD_CONFIG),
		})
		.returning({ id: Dashboard.id })
	if (!dashboard) throw new Error('Failed to create the dashboard')
	return dashboard
}

function sharesOf(dashboardId: string) {
	return db
		.select({ userId: DashboardShare.userId, access: DashboardShare.access })
		.from(DashboardShare)
		.where(eq(DashboardShare.dashboardId, dashboardId))
}

async function notificationCount(userId: string) {
	const [result] = await db
		.select({ count: count() })
		.from(Notification)
		.where(eq(Notification.userId, userId))
	return result?.count ?? 0
}

function toBrowserCookie(setCookie: string) {
	const cookie = setCookieParser.parseString(setCookie)
	return {
		name: cookie.name,
		value: cookie.value,
		domain: 'localhost',
		path: cookie.path ?? '/',
		expires: cookie.expires ? cookie.expires.getTime() / 1000 : undefined,
		sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None',
	}
}

/** A second browser, signed in as another member of the organization. */
async function signInElsewhere({
	browser,
	baseURL,
	extraHTTPHeaders,
	userId,
}: {
	browser: Browser
	baseURL: string | undefined
	extraHTTPHeaders: Record<string, string> | undefined
	userId: string
}): Promise<{ context: BrowserContext; page: Page }> {
	const { cookieHeader } = await createTestSession(userId)
	const context = await browser.newContext({
		baseURL,
		extraHTTPHeaders,
		viewport: { width: 1440, height: 900 },
	})
	await context.addCookies([
		toBrowserCookie(cookieHeader),
		toBrowserCookie(
			await cookieConsentCookie.serialize({ hasConsented: true }),
		),
	])
	const page = await context.newPage()
	// The notifications stream never goes idle.
	await page.route('**/api/notifications/stream*', (route) =>
		route.abort().catch(() => {}),
	)
	return { context, page }
}

test.describe('Dashboard sharing', () => {
	test('the owner shares a dashboard for viewing, then editing, then takes access away', async ({
		page,
		browser,
		baseURL,
		extraHTTPHeaders,
		login,
		insertNewUser,
		navigate,
	}) => {
		const owner = await login()
		const recipient = await insertNewUser()
		const org = await createTestOrganization(owner.id, 'admin')
		await addOrganizationMember(recipient.id, org.id)
		const dashboard = await insertCustomDashboard({
			organizationId: org.id,
			ownerId: owner.id,
		})
		const dashboardPath = `/${org.slug}/dashboards/${dashboard.id}`
		const recipientName = recipient.name ?? recipient.username

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate(dashboardPath)
		await page.waitForLoadState('networkidle')
		await expect(dashboardBlock(page, 'Stats')).toBeVisible()

		await page.getByRole('button', { name: 'Share', exact: true }).click()
		const dialog = page.getByRole('dialog', {
			name: `Share “${DASHBOARD_NAME}”`,
		})
		await expect(dialog.getByText('Not shared with anyone yet.')).toBeVisible()
		await expect(dialog.getByRole('combobox', { name: 'Access' })).toHaveText(
			'View',
		)
		const shareButton = dialog.getByRole('button', {
			name: 'Share',
			exact: true,
		})
		await expect(shareButton).toBeDisabled()

		await dialog.getByRole('combobox', { name: 'Person' }).click()
		// The owner is not offered; the only other member is.
		await expect(page.getByRole('option')).toHaveText([
			`${recipientName}@${recipient.username}`,
		])
		await page
			.getByRole('option')
			.filter({ hasText: `@${recipient.username}` })
			.click()
		const shared = nextPostTo(page, dashboardPath)
		await shareButton.click()
		const shareResponse = await shared
		expect(shareResponse.status()).toBe(200)
		expect(shareResponse.request().postData()).toContain('intent=share')
		expect(shareResponse.request().postData()).toContain('access=view')
		const recipientAccess = dialog.getByRole('combobox', {
			name: `Access for ${recipientName}`,
		})
		await expect(recipientAccess).toHaveText('View')
		expect(await sharesOf(dashboard.id)).toEqual([
			{ userId: recipient.id, access: 'view' },
		])

		const other = await signInElsewhere({
			browser,
			baseURL,
			extraHTTPHeaders,
			userId: recipient.id,
		})
		try {
			const viewer = other.page
			await viewer.goto(`/${org.slug}`)
			await viewer.waitForLoadState('networkidle')
			await switcher(viewer, 'Home').click()
			const entry = sharedWithMe(viewer).getByRole('menuitem')
			await expect(entry).toHaveCount(1)
			await expect(entry).toContainText(DASHBOARD_NAME)
			await expect(entry).toContainText(`${owner.name} · View only`)
			await entry.click()
			await expect(viewer).toHaveURL(new RegExp(`${dashboardPath}$`))
			await expect(
				viewer.getByText(`Shared by ${owner.name} · View only`),
			).toBeVisible()
			await expect(dashboardBlock(viewer, 'Stats')).toBeVisible()
			await expect(dashboardBlock(viewer, 'Top contributors')).toBeVisible()
			for (const control of ['Edit layout', 'Share', 'Dashboard options']) {
				await expect(
					viewer.getByRole('button', { name: control, exact: true }),
				).toHaveCount(0)
			}
			const statsOnly = JSON.stringify({
				...BOARD_CONFIG,
				blocks: BOARD_CONFIG.blocks.slice(0, 1),
				layouts: {
					lg: BOARD_CONFIG.layouts.lg.slice(0, 1),
					md: BOARD_CONFIG.layouts.md.slice(0, 1),
				},
			})
			expect(
				await postIntent(viewer, dashboardPath, {
					intent: 'save-config',
					config: statsOnly,
				}),
			).toBe(403)

			// Edit access lets the recipient change the blocks for everyone.
			await recipientAccess.click()
			const changed = nextPostTo(page, dashboardPath)
			await page.getByRole('option', { name: 'Edit', exact: true }).click()
			const changeResponse = await changed
			expect(changeResponse.status()).toBe(200)
			expect(changeResponse.request().postData()).toContain('access=edit')
			await expect(recipientAccess).toHaveText('Edit')

			await viewer.reload()
			await viewer.waitForLoadState('networkidle')
			await expect(
				viewer.getByText(`Shared by ${owner.name} · Can edit`),
			).toBeVisible()
			for (const control of ['Share', 'Dashboard options']) {
				await expect(
					viewer.getByRole('button', { name: control, exact: true }),
				).toHaveCount(0)
			}
			await viewer.getByRole('button', { name: 'Edit layout' }).click()
			const removed = nextPostTo(viewer, dashboardPath)
			await dashboardBlock(viewer, 'Top contributors')
				.getByRole('button', { name: 'Remove block' })
				.click()
			expect((await removed).status()).toBe(200)
			await expect(viewer.getByText('Saved', { exact: true })).toBeVisible()
			await viewer.getByRole('button', { name: 'Done', exact: true }).click()

			const ownerOnlyIntents: Array<Record<string, string>> = [
				{ intent: 'rename', name: 'Taken over' },
				{ intent: 'delete' },
				{ intent: 'share', userId: owner.id, access: 'view' },
				{ intent: 'unshare', userId: recipient.id },
			]
			for (const fields of ownerOnlyIntents) {
				expect(await postIntent(viewer, dashboardPath, fields)).toBe(403)
			}

			await page.keyboard.press('Escape')
			await expect(dialog).toHaveCount(0)
			await page.reload()
			await page.waitForLoadState('networkidle')
			await expect(
				page.getByRole('heading', { level: 1, name: DASHBOARD_NAME }),
			).toBeVisible()
			expect(await blockOrder(page)).toEqual(['Stats'])

			await page.getByRole('button', { name: 'Share', exact: true }).click()
			const unshared = nextPostTo(page, dashboardPath)
			await dialog
				.getByRole('button', { name: `Remove access for ${recipientName}` })
				.click()
			const unshareResponse = await unshared
			expect(unshareResponse.status()).toBe(200)
			expect(unshareResponse.request().postData()).toContain('intent=unshare')
			await expect(
				dialog.getByText('Not shared with anyone yet.'),
			).toBeVisible()
			expect(await sharesOf(dashboard.id)).toEqual([])

			const revoked = await viewer.goto(dashboardPath)
			expect(revoked?.status()).toBe(404)
			await expect(viewer.getByText(NOT_FOUND_TEXT)).toBeVisible()
			await expect(viewer.getByText(DASHBOARD_NAME)).toHaveCount(0)
			await viewer.goto(`/${org.slug}`)
			await viewer.waitForLoadState('networkidle')
			await switcher(viewer, 'Home').click()
			await expect(sharedWithMe(viewer)).toHaveCount(0)
		} finally {
			await other.context.close()
		}

		expect(await notificationCount(recipient.id)).toBe(0)
	})

	test('only active members can be picked, and deleting a dashboard removes it for its recipients', async ({
		page,
		browser,
		baseURL,
		extraHTTPHeaders,
		login,
		insertNewUser,
		navigate,
	}) => {
		const owner = await login()
		const recipient = await insertNewUser()
		const org = await createTestOrganization(owner.id, 'admin')
		await addOrganizationMember(recipient.id, org.id)
		const former = await createTestUser()
		const outsider = await createTestUser()
		try {
			await addOrganizationMember(former.id, org.id)
			await db
				.update(UserOrganization)
				.set({ active: false })
				.where(
					and(
						eq(UserOrganization.userId, former.id),
						eq(UserOrganization.organizationId, org.id),
					),
				)
			await createTestOrganization(outsider.id, 'admin')

			const dashboard = await insertCustomDashboard({
				organizationId: org.id,
				ownerId: owner.id,
			})
			await db.insert(DashboardShare).values({
				dashboardId: dashboard.id,
				userId: recipient.id,
				access: 'view',
				sharedById: owner.id,
			})
			const dashboardPath = `/${org.slug}/dashboards/${dashboard.id}`
			const recipientName = recipient.name ?? recipient.username

			await page.setViewportSize({ width: 1440, height: 900 })
			await navigate(dashboardPath)
			await page.waitForLoadState('networkidle')
			await page.getByRole('button', { name: 'Share', exact: true }).click()
			const dialog = page.getByRole('dialog', {
				name: `Share “${DASHBOARD_NAME}”`,
			})
			await expect(
				dialog.getByRole('combobox', { name: `Access for ${recipientName}` }),
			).toHaveText('View')
			await dialog.getByRole('combobox', { name: 'Person' }).click()
			// Inactive members and people from other organizations are not offered.
			await expect(page.getByRole('option')).toHaveText([
				`${recipientName}Has access`,
			])
			await expect(page.getByRole('option')).toBeDisabled()
			await page.keyboard.press('Escape')
			await page.keyboard.press('Escape')
			await expect(dialog).toHaveCount(0)

			const other = await signInElsewhere({
				browser,
				baseURL,
				extraHTTPHeaders,
				userId: recipient.id,
			})
			try {
				const viewer = other.page
				await viewer.goto(`/${org.slug}`)
				await viewer.waitForLoadState('networkidle')
				await switcher(viewer, 'Home').click()
				await expect(sharedWithMe(viewer).getByRole('menuitem')).toHaveCount(1)
				await viewer.keyboard.press('Escape')

				await page.getByRole('button', { name: 'Dashboard options' }).click()
				await page.getByRole('menuitem', { name: 'Delete' }).click()
				const deleted = nextPostTo(page, dashboardPath)
				await page
					.getByRole('alertdialog', { name: `Delete “${DASHBOARD_NAME}”?` })
					.getByRole('button', { name: 'Delete dashboard' })
					.click()
				expect((await deleted).request().postData()).toContain('intent=delete')
				await expect(page).toHaveURL(new RegExp(`/${org.slug}$`))
				expect(await sharesOf(dashboard.id)).toEqual([])

				await viewer.reload()
				await viewer.waitForLoadState('networkidle')
				await switcher(viewer, 'Home').click()
				await expect(sharedWithMe(viewer)).toHaveCount(0)
				await viewer.keyboard.press('Escape')
				const gone = await viewer.goto(dashboardPath)
				expect(gone?.status()).toBe(404)
				await expect(viewer.getByText(NOT_FOUND_TEXT)).toBeVisible()
			} finally {
				await other.context.close()
			}
		} finally {
			await db.delete(User).where(eq(User.id, former.id))
			await db.delete(User).where(eq(User.id, outsider.id))
		}
	})
})
