import { and, Dashboard, DashboardShare, db, eq } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	defaultHomeConfig,
	emptyDashboardConfig,
	parseDashboardConfig,
	serializeDashboardConfig,
	type DashboardConfig,
} from '#app/utils/dashboards/config.ts'
import { appendBlock } from '#app/utils/dashboards/layout.ts'
import {
	insertTestDashboard,
	insertTestMember,
	insertTestShare,
	insertTestUser,
} from '#tests/dashboard-utils.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action, loader } from './$dashboardId.tsx'

const DASHBOARD_NAME = 'Secret sales board'

function statsConfig(): DashboardConfig {
	return appendBlock(emptyDashboardConfig(), { id: 'stats', type: 'stats' })
}

function loadDashboard(slug: string, dashboardId: string, cookie: string) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}/dashboards/${dashboardId}`,
		{},
		cookie,
	)
	return loader({
		request,
		params: { orgSlug: slug, dashboardId },
		context: {},
	} as any)
}

function postDashboard(
	slug: string,
	dashboardId: string,
	cookie: string,
	body: Record<string, string>,
) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}/dashboards/${dashboardId}`,
		{ method: 'POST', body: new URLSearchParams(body) },
		cookie,
	)
	return action({
		request,
		params: { orgSlug: slug, dashboardId },
		context: {},
	} as any)
}

function saveConfig(
	slug: string,
	dashboardId: string,
	cookie: string,
	config: unknown,
) {
	return postDashboard(slug, dashboardId, cookie, {
		intent: 'save-config',
		config: typeof config === 'string' ? config : JSON.stringify(config),
	})
}

function unwrap(result: unknown) {
	const body =
		result && typeof result === 'object' && 'data' in result
			? (result as { data: unknown }).data
			: result
	return { status: getResponseStatus(result), body }
}

function expectRejected(result: unknown, status: number, code: string) {
	const { status: actual, body } = unwrap(result)
	expect(actual).toBe(status)
	expect(body).toEqual({
		ok: false,
		error: { code, message: expect.any(String) },
	})
}

async function expectNotFound(promise: Promise<unknown>, secret?: string) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(Response)
	const response = error as Response
	expect(response.status).toBe(404)
	if (secret) expect(await response.text()).not.toContain(secret)
}

async function storedDashboard(dashboardId: string) {
	const [row] = await db
		.select({ name: Dashboard.name, config: Dashboard.config })
		.from(Dashboard)
		.where(eq(Dashboard.id, dashboardId))
	return row
		? { name: row.name, config: JSON.parse(row.config) as DashboardConfig }
		: null
}

function sharesOf(dashboardId: string) {
	return db
		.select({ userId: DashboardShare.userId })
		.from(DashboardShare)
		.where(eq(DashboardShare.dashboardId, dashboardId))
}

function homeRows(userId: string, organizationId: string) {
	return db
		.select({ id: Dashboard.id })
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'home'),
			),
		)
}

async function setup() {
	const owner = await insertTestUser({ name: 'Olive Owner' })
	const organization = await createTestOrganization(owner.id, 'member')
	const { cookie } = await createTestSession(owner.id)
	const editor = await insertTestMember(organization.id)
	const viewer = await insertTestMember(organization.id)
	const member = await insertTestMember(organization.id)
	const dashboard = await insertTestDashboard({
		organizationId: organization.id,
		ownerId: owner.id,
		name: DASHBOARD_NAME,
		config: statsConfig(),
	})
	await insertTestShare({
		dashboardId: dashboard.id,
		userId: editor.user.id,
		sharedById: owner.id,
		access: 'edit',
	})
	await insertTestShare({
		dashboardId: dashboard.id,
		userId: viewer.user.id,
		sharedById: owner.id,
		access: 'view',
	})
	return {
		owner: { user: owner, cookie },
		editor,
		viewer,
		member,
		organization,
		dashboard,
	}
}

describe('custom dashboard loader', () => {
	it('gives the owner the dashboard, data for its blocks and the switcher', async () => {
		const { owner, organization, dashboard } = await setup()

		const data = await loadDashboard(
			organization.slug,
			dashboard.id,
			owner.cookie,
		)

		expect(data.organization).toEqual({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
		})
		expect(data.dashboard).toEqual({
			id: dashboard.id,
			kind: 'custom',
			name: DASHBOARD_NAME,
			access: 'owner',
			ownerName: 'Olive Owner',
			config: statsConfig(),
		})
		expect(data.blockData.notes).not.toBeNull()
		expect(data.blockData.onboarding).toBeNull()
		expect(data.blockData.leaderboard).toBeNull()
		expect(data.reports).toBeNull()
		expect(data.picker.templateGroups.length).toBeGreaterThan(0)
		expect(data.switcher).toEqual({
			mine: [{ id: dashboard.id, name: DASHBOARD_NAME }],
			sharedWithMe: [],
		})
	})

	it('gives share recipients their access and lists the dashboard as shared', async () => {
		const { editor, viewer, organization, dashboard } = await setup()

		const asEditor = await loadDashboard(
			organization.slug,
			dashboard.id,
			editor.cookie,
		)
		expect(asEditor.dashboard).toMatchObject({
			access: 'edit',
			ownerName: 'Olive Owner',
		})

		const asViewer = await loadDashboard(
			organization.slug,
			dashboard.id,
			viewer.cookie,
		)
		expect(asViewer.dashboard.access).toBe('view')
		expect(asViewer.switcher).toEqual({
			mine: [],
			sharedWithMe: [
				{
					id: dashboard.id,
					name: DASHBOARD_NAME,
					ownerName: 'Olive Owner',
					access: 'view',
				},
			],
		})
	})

	it('returns 404 without the name for dashboards the user cannot open', async () => {
		const { owner, member, organization, dashboard } = await setup()
		const otherOrganization = await createTestOrganization(
			owner.user.id,
			'member',
		)
		const elsewhere = await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: owner.user.id,
			name: 'Board of another organization',
		})
		const outsider = await insertTestUser()
		const { cookie: outsiderCookie } = await createTestSession(outsider.id)

		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, member.cookie),
			DASHBOARD_NAME,
		)
		await expectNotFound(
			loadDashboard(organization.slug, 'missing-dashboard', owner.cookie),
		)
		await expectNotFound(
			loadDashboard(organization.slug, elsewhere.id, owner.cookie),
			'Board of another organization',
		)
		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, outsiderCookie),
			DASHBOARD_NAME,
		)
	})

	it('does not open a Home dashboard, not even for its owner', async () => {
		const { owner, organization } = await setup()
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.user.id,
			kind: 'home',
		})

		await expectNotFound(
			loadDashboard(organization.slug, home.id, owner.cookie),
		)
	})
})

describe('custom dashboard action', () => {
	it('saves the normalized config for the owner and editors but not viewers', async () => {
		const { owner, editor, viewer, organization, dashboard } = await setup()
		const withChart = appendBlock(statsConfig(), {
			id: 'notes-chart',
			type: 'notes-chart',
		})
		const submitted = {
			...withChart,
			layouts: {
				...withChart.layouts,
				lg: withChart.layouts.lg.map((item) => ({ ...item, moved: false })),
			},
		}

		expect(
			unwrap(
				await saveConfig(
					organization.slug,
					dashboard.id,
					owner.cookie,
					submitted,
				),
			),
		).toEqual({ status: 200, body: { ok: true } })
		const normalized = parseDashboardConfig(JSON.stringify(submitted))
		expect(normalized.success && normalized.config).toEqual(
			(await storedDashboard(dashboard.id))?.config,
		)

		const editorConfig = appendBlock(withChart, {
			id: 'leaderboard',
			type: 'leaderboard',
		})
		expect(
			unwrap(
				await saveConfig(
					organization.slug,
					dashboard.id,
					editor.cookie,
					editorConfig,
				),
			),
		).toEqual({ status: 200, body: { ok: true } })
		expect((await storedDashboard(dashboard.id))?.config).toEqual(editorConfig)

		expectRejected(
			await saveConfig(
				organization.slug,
				dashboard.id,
				viewer.cookie,
				statsConfig(),
			),
			403,
			'forbidden',
		)
		expect((await storedDashboard(dashboard.id))?.config).toEqual(editorConfig)
		// Saving a custom dashboard never touches Home.
		expect(await homeRows(owner.user.id, organization.id)).toEqual([])
	})

	it('rejects invalid configs and reports from elsewhere with a 400', async () => {
		const { owner, organization, dashboard } = await setup()

		expectRejected(
			await saveConfig(organization.slug, dashboard.id, owner.cookie, '{oops'),
			400,
			'invalid-json',
		)
		expectRejected(
			await saveConfig(
				organization.slug,
				dashboard.id,
				owner.cookie,
				appendBlock(statsConfig(), {
					id: 'report-1',
					type: 'report',
					config: { source: 'saved', reportId: 'not-in-this-org' },
				}),
			),
			400,
			'unknown-report',
		)
		expectRejected(
			await postDashboard(organization.slug, dashboard.id, owner.cookie, {
				intent: 'save-config',
			}),
			400,
			'invalid-request',
		)
		expect((await storedDashboard(dashboard.id))?.config).toEqual(statsConfig())
	})

	it('lets the owner rename the dashboard to a valid trimmed name', async () => {
		const { owner, organization, dashboard } = await setup()

		expect(
			unwrap(
				await postDashboard(organization.slug, dashboard.id, owner.cookie, {
					intent: 'rename',
					name: '  Q3 metrics ',
				}),
			),
		).toEqual({ status: 200, body: { ok: true } })
		expect((await storedDashboard(dashboard.id))?.name).toBe('Q3 metrics')

		for (const [name, code] of [
			['', 'name-required'],
			['   ', 'name-required'],
			['a'.repeat(61), 'name-too-long'],
		] as const) {
			expectRejected(
				await postDashboard(organization.slug, dashboard.id, owner.cookie, {
					intent: 'rename',
					name,
				}),
				400,
				code,
			)
		}
		expect((await storedDashboard(dashboard.id))?.name).toBe('Q3 metrics')

		const data = await loadDashboard(
			organization.slug,
			dashboard.id,
			owner.cookie,
		)
		expect(data.dashboard.name).toBe('Q3 metrics')
		expect(data.switcher.mine).toEqual([
			{ id: dashboard.id, name: 'Q3 metrics' },
		])
	})

	it('only lets the owner rename or delete', async () => {
		const { editor, viewer, organization, dashboard } = await setup()

		for (const { cookie } of [editor, viewer]) {
			expectRejected(
				await postDashboard(organization.slug, dashboard.id, cookie, {
					intent: 'rename',
					name: 'Taken over',
				}),
				403,
				'forbidden',
			)
			expectRejected(
				await postDashboard(organization.slug, dashboard.id, cookie, {
					intent: 'delete',
				}),
				403,
				'forbidden',
			)
		}
		expect((await storedDashboard(dashboard.id))?.name).toBe(DASHBOARD_NAME)
		expect(await sharesOf(dashboard.id)).toHaveLength(2)
	})

	it('deletes the dashboard with its shares and returns to Home', async () => {
		const { owner, viewer, organization, dashboard } = await setup()

		const response = await postDashboard(
			organization.slug,
			dashboard.id,
			owner.cookie,
			{ intent: 'delete' },
		)

		expect(response).toBeInstanceOf(Response)
		expect((response as Response).status).toBe(302)
		expect((response as Response).headers.get('Location')).toBe(
			`/${organization.slug}`,
		)
		expect(await storedDashboard(dashboard.id)).toBeNull()
		expect(await sharesOf(dashboard.id)).toEqual([])
		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, owner.cookie),
		)
		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, viewer.cookie),
		)
	})

	it('has no reset to default', async () => {
		const { owner, organization, dashboard } = await setup()

		expectRejected(
			await postDashboard(organization.slug, dashboard.id, owner.cookie, {
				intent: 'reset',
			}),
			400,
			'invalid-request',
		)
		expect(await storedDashboard(dashboard.id)).toEqual({
			name: DASHBOARD_NAME,
			config: statsConfig(),
		})
	})

	it('returns 404 for every intent on a dashboard the user cannot open', async () => {
		const { owner, member, organization, dashboard } = await setup()
		const otherOrganization = await createTestOrganization(
			owner.user.id,
			'member',
		)
		await addOrganizationMember(member.user.id, otherOrganization.id)
		const elsewhere = await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: owner.user.id,
			name: 'Board of another organization',
			config: statsConfig(),
		})
		const bodies: Array<Record<string, string>> = [
			{
				intent: 'save-config',
				config: serializeDashboardConfig(statsConfig()),
			},
			{ intent: 'rename', name: 'Renamed' },
			{ intent: 'delete' },
			{ intent: 'share', userId: member.user.id, access: 'edit' },
			{ intent: 'unshare', userId: member.user.id },
			{ intent: 'reset' },
		]

		for (const body of bodies) {
			await expectNotFound(
				postDashboard(organization.slug, elsewhere.id, owner.cookie, body),
				'Board of another organization',
			)
			await expectNotFound(
				postDashboard(organization.slug, dashboard.id, member.cookie, body),
				DASHBOARD_NAME,
			)
		}
		expect(await storedDashboard(elsewhere.id)).toEqual({
			name: 'Board of another organization',
			config: statsConfig(),
		})
		expect((await storedDashboard(dashboard.id))?.name).toBe(DASHBOARD_NAME)
		expect(await sharesOf(elsewhere.id)).toEqual([])
		expect(await sharesOf(dashboard.id)).toHaveLength(2)
	})

	it('returns 404 for intents on a Home dashboard', async () => {
		const { owner, member, organization } = await setup()
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.user.id,
			kind: 'home',
		})

		const bodies: Array<Record<string, string>> = [
			{ intent: 'rename', name: 'Not Home' },
			{ intent: 'delete' },
			{ intent: 'share', userId: member.user.id, access: 'view' },
			{
				intent: 'save-config',
				config: serializeDashboardConfig(statsConfig()),
			},
		]
		for (const body of bodies) {
			await expectNotFound(
				postDashboard(organization.slug, home.id, owner.cookie, body),
			)
		}
		expect(await storedDashboard(home.id)).toEqual({
			name: 'Home',
			config: defaultHomeConfig(),
		})
		expect(await sharesOf(home.id)).toEqual([])
	})
})
