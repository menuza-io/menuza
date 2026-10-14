import { type Page, type Request } from '@playwright/test'
import { and, count, Dashboard, db, eq, OnboardingStep } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { initializeOnboardingSteps } from '../../../../packages/database/setup-onboarding.ts'

const DEFAULT_HOME_BLOCKS = [
	'Stats',
	'Notes chart',
	'Onboarding checklist',
	'Top contributors',
]

async function ensureOnboardingStepsExist() {
	const [result] = await db.select({ count: count() }).from(OnboardingStep)
	if ((result?.count ?? 0) === 0) await initializeOnboardingSteps()
}

function dashboardBlock(page: Page, name: string) {
	return page.getByRole('main').getByRole('region', { name, exact: true })
}

/** Accessible names of the dashboard's blocks in DOM (and so tab) order. */
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

/** Records POSTs to a page's own route, i.e. its dashboard saves. */
function recordPostsTo(page: Page, pathname: string) {
	const posts: string[] = []
	page.on('request', (request) => {
		if (isPostTo(request, pathname)) posts.push(request.postData() ?? '')
	})
	return posts
}

function dashboardsOf(userId: string, organizationId: string) {
	return db
		.select({
			id: Dashboard.id,
			kind: Dashboard.kind,
			name: Dashboard.name,
			config: Dashboard.config,
		})
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
			),
		)
}

async function insertCustomDashboard(input: {
	organizationId: string
	ownerId: string
	name: string
}) {
	const [dashboard] = await db
		.insert(Dashboard)
		.values({
			...input,
			kind: 'custom',
			config: JSON.stringify({
				version: 1,
				blocks: [{ id: 'stats', type: 'stats' }],
				layouts: {
					lg: [{ i: 'stats', x: 0, y: 0, w: 12, h: 2 }],
					md: [{ i: 'stats', x: 0, y: 0, w: 8, h: 2 }],
				},
			}),
		})
		.returning({ id: Dashboard.id })
	if (!dashboard) throw new Error('Failed to create the dashboard')
	return dashboard
}

test.describe('Multiple dashboards', () => {
	test('creates a dashboard from the switcher, adds a block and keeps Home separate', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const homePosts = recordPostsTo(page, `/${org.slug}`)

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')
		await expect(dashboardBlock(page, 'Top contributors')).toBeVisible()

		await switcher(page, 'Home').click()
		const menu = page.getByRole('menu')
		await expect(
			menu
				.getByRole('group', { name: 'Home' })
				.getByRole('menuitem', { name: 'Home' }),
		).toHaveAttribute('aria-current', 'page')
		await expect(
			menu.getByRole('group', { name: 'My dashboards' }),
		).toHaveCount(0)
		await menu.getByRole('menuitem', { name: 'New dashboard' }).click()

		const dialog = page.getByRole('dialog', { name: 'New dashboard' })
		const nameInput = dialog.getByRole('textbox', { name: 'Name' })
		const create = dialog.getByRole('button', { name: 'Create dashboard' })
		await nameInput.fill('   ')
		await create.click()
		await expect(dialog.getByText('Enter a dashboard name.')).toBeVisible()
		await expect(nameInput).toHaveAttribute('aria-invalid', 'true')
		await nameInput.fill('x'.repeat(61))
		await create.click()
		await expect(dialog.getByText('Use 60 characters or fewer.')).toBeVisible()
		expect(await dashboardsOf(user.id, org.id)).toEqual([])

		await nameInput.fill('  Sales overview  ')
		const created = nextPostTo(page, `/${org.slug}/dashboards`)
		await create.click()
		expect((await created).status()).toBe(202)
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/dashboards/[a-z0-9]+$`),
		)
		const dashboardPath = new URL(page.url()).pathname

		await expect(
			page.getByRole('heading', { level: 1, name: 'Sales overview' }),
		).toBeVisible()
		await expect(switcher(page, 'Sales overview')).toBeVisible()
		await expect(
			page.getByText('This dashboard has no blocks yet'),
		).toBeVisible()
		expect(await blockOrder(page)).toEqual([])

		// The empty state's call to action adds the first block and opens the
		// layout for arranging it.
		await page.getByRole('button', { name: 'Add block' }).click()
		const addDialog = page.getByRole('dialog', { name: 'Add block' })
		const builtIns = addDialog.getByRole('group', { name: 'Built-in blocks' })
		const added = nextPostTo(page, dashboardPath)
		await builtIns.getByRole('button', { name: /^Stats/ }).click()
		await expect(addDialog).toHaveCount(0)
		const addResponse = await added
		expect(addResponse.status()).toBe(200)
		expect(addResponse.request().postData()).toContain('intent=save-config')
		await expect(dashboardBlock(page, 'Stats')).toBeVisible()
		await expect(page.getByText('Saved', { exact: true })).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Reset to default' }),
		).toHaveCount(0)
		await page.getByRole('button', { name: 'Done', exact: true }).click()

		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(dashboardBlock(page, 'Stats')).toBeVisible()
		expect(await blockOrder(page)).toEqual(['Stats'])
		await expect(
			page.getByText('This dashboard has no blocks yet'),
		).toHaveCount(0)

		const [stored] = await dashboardsOf(user.id, org.id)
		expect(stored).toMatchObject({ kind: 'custom', name: 'Sales overview' })
		expect(JSON.parse(stored?.config ?? '{}')).toMatchObject({
			blocks: [{ id: 'stats', type: 'stats' }],
		})

		// Back on Home through the switcher, Home still has its default blocks.
		await switcher(page, 'Sales overview').click()
		await expect(
			menu
				.getByRole('group', { name: 'My dashboards' })
				.getByRole('menuitem', { name: 'Sales overview' }),
		).toHaveAttribute('aria-current', 'page')
		await menu.getByRole('menuitem', { name: 'Home' }).click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}$`))
		await expect(switcher(page, 'Home')).toBeVisible()
		await expect(dashboardBlock(page, 'Top contributors')).toBeVisible()
		expect(await blockOrder(page)).toEqual(DEFAULT_HOME_BLOCKS)
		expect(homePosts).toEqual([])
		expect(
			(await dashboardsOf(user.id, org.id)).map((row) => row.kind),
		).toEqual(['custom'])
	})

	test('the owner renames a dashboard and deletes it only after confirming', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const dashboard = await insertCustomDashboard({
			organizationId: org.id,
			ownerId: user.id,
			name: 'Team board',
		})
		const dashboardPath = `/${org.slug}/dashboards/${dashboard.id}`

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate(dashboardPath)
		await page.waitForLoadState('networkidle')
		await expect(dashboardBlock(page, 'Stats')).toBeVisible()

		const options = page.getByRole('button', { name: 'Dashboard options' })
		await options.click()
		await page.getByRole('menuitem', { name: 'Rename' }).click()
		const dialog = page.getByRole('dialog', { name: 'Rename dashboard' })
		const nameInput = dialog.getByRole('textbox', { name: 'Name' })
		await expect(nameInput).toHaveValue('Team board')
		await nameInput.fill('')
		await dialog.getByRole('button', { name: 'Save' }).click()
		await expect(dialog.getByText('Enter a dashboard name.')).toBeVisible()

		await nameInput.fill(' Q3 metrics ')
		const renamed = nextPostTo(page, dashboardPath)
		await dialog.getByRole('button', { name: 'Save' }).click()
		const renameResponse = await renamed
		expect(renameResponse.status()).toBe(200)
		expect(renameResponse.request().postData()).toContain('intent=rename')
		await expect(dialog).toHaveCount(0)

		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByRole('heading', { level: 1, name: 'Q3 metrics' }),
		).toBeVisible()
		await switcher(page, 'Q3 metrics').click()
		await expect(
			page
				.getByRole('menu')
				.getByRole('group', { name: 'My dashboards' })
				.getByRole('menuitem'),
		).toHaveText(['Q3 metrics'])
		await page.keyboard.press('Escape')

		// Cancelling the confirmation keeps the dashboard.
		await options.click()
		await page.getByRole('menuitem', { name: 'Delete' }).click()
		const confirm = page.getByRole('alertdialog', {
			name: 'Delete “Q3 metrics”?',
		})
		await confirm.getByRole('button', { name: 'Cancel' }).click()
		await expect(confirm).toHaveCount(0)
		await expect(page).toHaveURL(new RegExp(`${dashboardPath}$`))
		expect(await dashboardsOf(user.id, org.id)).toHaveLength(1)

		await options.click()
		await page.getByRole('menuitem', { name: 'Delete' }).click()
		const deleted = nextPostTo(page, dashboardPath)
		await confirm.getByRole('button', { name: 'Delete dashboard' }).click()
		expect((await deleted).request().postData()).toContain('intent=delete')
		await expect(page).toHaveURL(new RegExp(`/${org.slug}$`))
		await expect(switcher(page, 'Home')).toBeVisible()
		expect(await dashboardsOf(user.id, org.id)).toEqual([])

		await switcher(page, 'Home').click()
		await expect(
			page.getByRole('menu').getByRole('group', { name: 'My dashboards' }),
		).toHaveCount(0)
		await page.keyboard.press('Escape')

		const response = await navigate(dashboardPath)
		expect(response?.status()).toBe(404)
		await expect(
			page.getByText(
				'This dashboard does not exist or you do not have access to it.',
			),
		).toBeVisible()
	})
})
