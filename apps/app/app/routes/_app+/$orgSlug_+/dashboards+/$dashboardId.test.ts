import {
	and,
	asc,
	Dashboard,
	DashboardShare,
	db,
	eq,
	Notification,
	UserOrganization,
} from '@repo/database'
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

function shareRows(dashboardId: string) {
	return db
		.select({
			userId: DashboardShare.userId,
			access: DashboardShare.access,
			sharedById: DashboardShare.sharedById,
		})
		.from(DashboardShare)
		.where(eq(DashboardShare.dashboardId, dashboardId))
		.orderBy(asc(DashboardShare.userId))
}

function setMembershipActive(
	userId: string,
	organizationId: string,
	active: boolean,
) {
	return db
		.update(UserOrganization)
		.set({ active })
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
}

async function setupSharing() {
	const base = await setup()
	const inactive = await insertTestMember(base.organization.id)
	await setMembershipActive(inactive.user.id, base.organization.id, false)
	const outsider = await insertTestUser()
	await createTestOrganization(outsider.id, 'admin')
	const { cookie: outsiderCookie } = await createTestSession(outsider.id)
	return {
		...base,
		inactive,
		outsider: { user: outsider, cookie: outsiderCookie },
	}
}

describe('sharing a custom dashboard', () => {
	it('gives only the owner the share list and the members to share with', async () => {
		const { owner, editor, viewer, member, organization, dashboard } =
			await setupSharing()

		const data = await loadDashboard(
			organization.slug,
			dashboard.id,
			owner.cookie,
		)

		expect(data.sharing).not.toBeNull()
		const byUserId = (a: { userId: string }, b: { userId: string }) =>
			a.userId.localeCompare(b.userId)
		expect([...(data.sharing?.shares ?? [])].sort(byUserId)).toEqual(
			[
				{
					userId: editor.user.id,
					name: editor.user.name,
					username: editor.user.username,
					image: null,
					access: 'edit',
					isActiveMember: true,
				},
				{
					userId: viewer.user.id,
					name: viewer.user.name,
					username: viewer.user.username,
					image: null,
					access: 'view',
					isActiveMember: true,
				},
			].sort(byUserId),
		)
		// Active members other than the owner: no inactive member, no outsider.
		expect(data.sharing?.members.map((person) => person.id).sort()).toEqual(
			[editor.user.id, viewer.user.id, member.user.id].sort(),
		)
		expect(data.sharing?.members).toContainEqual({
			id: member.user.id,
			name: member.user.name,
			username: member.user.username,
			image: null,
		})

		for (const recipient of [editor, viewer]) {
			const asRecipient = await loadDashboard(
				organization.slug,
				dashboard.id,
				recipient.cookie,
			)
			expect(asRecipient.sharing).toBeNull()
		}
	})

	it('lets the owner share with view or edit access and change it', async () => {
		const { owner, member, organization, dashboard } = await setupSharing()
		const share = (access: string) =>
			postDashboard(organization.slug, dashboard.id, owner.cookie, {
				intent: 'share',
				userId: member.user.id,
				access,
			})
		const memberShare = async () =>
			(await shareRows(dashboard.id)).find(
				(row) => row.userId === member.user.id,
			)

		expect(unwrap(await share('view'))).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect(await memberShare()).toEqual({
			userId: member.user.id,
			access: 'view',
			sharedById: owner.user.id,
		})
		const asViewer = await loadDashboard(
			organization.slug,
			dashboard.id,
			member.cookie,
		)
		expect(asViewer.dashboard).toMatchObject({
			access: 'view',
			ownerName: 'Olive Owner',
		})
		expect(asViewer.switcher.sharedWithMe).toEqual([
			{
				id: dashboard.id,
				name: DASHBOARD_NAME,
				ownerName: 'Olive Owner',
				access: 'view',
			},
		])
		expectRejected(
			await saveConfig(
				organization.slug,
				dashboard.id,
				member.cookie,
				emptyDashboardConfig(),
			),
			403,
			'forbidden',
		)

		expect(unwrap(await share('edit'))).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect((await memberShare())?.access).toBe('edit')
		expect(await shareRows(dashboard.id)).toHaveLength(3)
		const asEditor = await loadDashboard(
			organization.slug,
			dashboard.id,
			member.cookie,
		)
		expect(asEditor.dashboard.access).toBe('edit')
		expect(asEditor.switcher.sharedWithMe[0]?.access).toBe('edit')
		expect(
			unwrap(
				await saveConfig(
					organization.slug,
					dashboard.id,
					member.cookie,
					emptyDashboardConfig(),
				),
			),
		).toEqual({ status: 200, body: { ok: true } })

		expect(unwrap(await share('view'))).toEqual({
			status: 200,
			body: { ok: true },
		})
		expectRejected(
			await saveConfig(
				organization.slug,
				dashboard.id,
				member.cookie,
				statsConfig(),
			),
			403,
			'forbidden',
		)
		expect((await storedDashboard(dashboard.id))?.config).toEqual(
			emptyDashboardConfig(),
		)
	})

	it('takes access away at once when the owner removes it', async () => {
		const { owner, viewer, editor, organization, dashboard } =
			await setupSharing()
		const unshare = () =>
			postDashboard(organization.slug, dashboard.id, owner.cookie, {
				intent: 'unshare',
				userId: viewer.user.id,
			})

		expect(unwrap(await unshare())).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect((await shareRows(dashboard.id)).map((row) => row.userId)).toEqual([
			editor.user.id,
		])
		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, viewer.cookie),
			DASHBOARD_NAME,
		)
		await expectNotFound(
			saveConfig(organization.slug, dashboard.id, viewer.cookie, statsConfig()),
			DASHBOARD_NAME,
		)
		// Removing access that is already gone changes nothing.
		expect(unwrap(await unshare())).toEqual({
			status: 200,
			body: { ok: true },
		})
	})

	it('rejects people who cannot be given access and unknown access levels with a 400', async () => {
		const {
			owner,
			viewer,
			member,
			inactive,
			outsider,
			organization,
			dashboard,
		} = await setupSharing()
		const before = await shareRows(dashboard.id)
		const rejected: Array<[Record<string, string>, string]> = [
			[
				{ intent: 'share', userId: outsider.user.id, access: 'view' },
				'invalid-share-target',
			],
			[
				{ intent: 'share', userId: 'no-such-user', access: 'view' },
				'invalid-share-target',
			],
			[
				{ intent: 'share', userId: inactive.user.id, access: 'view' },
				'invalid-share-target',
			],
			[
				{ intent: 'share', userId: owner.user.id, access: 'edit' },
				'invalid-share-target',
			],
			[{ intent: 'share', access: 'view' }, 'invalid-share-target'],
			[
				{ intent: 'share', userId: viewer.user.id, access: 'admin' },
				'invalid-access',
			],
			[
				{ intent: 'share', userId: member.user.id, access: 'owner' },
				'invalid-access',
			],
			[{ intent: 'share', userId: member.user.id }, 'invalid-access'],
			[{ intent: 'unshare' }, 'invalid-request'],
		]

		for (const [body, code] of rejected) {
			expectRejected(
				await postDashboard(
					organization.slug,
					dashboard.id,
					owner.cookie,
					body,
				),
				400,
				code,
			)
		}
		expect(await shareRows(dashboard.id)).toEqual(before)
		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, outsider.cookie),
			DASHBOARD_NAME,
		)
	})

	it('does not let recipients share, unshare or change their own access', async () => {
		const { editor, viewer, member, organization, dashboard } =
			await setupSharing()
		const before = await shareRows(dashboard.id)

		for (const recipient of [editor, viewer]) {
			const bodies: Array<Record<string, string>> = [
				{ intent: 'share', userId: member.user.id, access: 'view' },
				{ intent: 'share', userId: recipient.user.id, access: 'edit' },
				{ intent: 'share', userId: member.user.id, access: 'admin' },
				{ intent: 'unshare', userId: editor.user.id },
				{ intent: 'unshare', userId: viewer.user.id },
			]
			for (const body of bodies) {
				expectRejected(
					await postDashboard(
						organization.slug,
						dashboard.id,
						recipient.cookie,
						body,
					),
					403,
					'forbidden',
				)
			}
		}
		expect(await shareRows(dashboard.id)).toEqual(before)
	})

	it('takes access away from recipients whose membership is deactivated', async () => {
		const { owner, editor, organization, dashboard } = await setupSharing()
		await setMembershipActive(editor.user.id, organization.id, false)

		await expectNotFound(
			loadDashboard(organization.slug, dashboard.id, editor.cookie),
			DASHBOARD_NAME,
		)
		await expectNotFound(
			saveConfig(organization.slug, dashboard.id, editor.cookie, statsConfig()),
			DASHBOARD_NAME,
		)
		const data = await loadDashboard(
			organization.slug,
			dashboard.id,
			owner.cookie,
		)
		expect(data.sharing?.members.map((person) => person.id)).not.toContain(
			editor.user.id,
		)
		expect(
			data.sharing?.shares.find((share) => share.userId === editor.user.id),
		).toMatchObject({ access: 'edit', isActiveMember: false })
		expectRejected(
			await postDashboard(organization.slug, dashboard.id, owner.cookie, {
				intent: 'share',
				userId: editor.user.id,
				access: 'view',
			}),
			400,
			'invalid-share-target',
		)
	})

	it('sends the recipient no notification', async () => {
		const { owner, member, organization, dashboard } = await setupSharing()

		await postDashboard(organization.slug, dashboard.id, owner.cookie, {
			intent: 'share',
			userId: member.user.id,
			access: 'edit',
		})

		expect(await shareRows(dashboard.id)).toContainEqual(
			expect.objectContaining({ userId: member.user.id, access: 'edit' }),
		)
		expect(
			await db
				.select({ id: Notification.id })
				.from(Notification)
				.where(eq(Notification.userId, member.user.id)),
		).toEqual([])
	})
})
