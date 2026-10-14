import { and, Dashboard, db, eq } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	emptyDashboardConfig,
	MAX_CUSTOM_DASHBOARDS,
} from '#app/utils/dashboards/config.ts'
import {
	insertTestDashboard,
	insertTestMember,
	insertTestShare,
	insertTestUser,
} from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './index.ts'

function postCreate(
	slug: string,
	cookie: string,
	body: Record<string, string>,
) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}/dashboards`,
		{ method: 'POST', body: new URLSearchParams(body) },
		cookie,
	)
	return action({ request, params: { orgSlug: slug }, context: {} } as any)
}

function customDashboards(ownerId: string, organizationId: string) {
	return db
		.select({
			id: Dashboard.id,
			name: Dashboard.name,
			config: Dashboard.config,
		})
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, ownerId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'custom'),
			),
		)
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

async function insertCustomDashboards(input: {
	organizationId: string
	ownerId: string
	count: number
}) {
	for (let index = 0; index < input.count; index++) {
		await insertTestDashboard({
			organizationId: input.organizationId,
			ownerId: input.ownerId,
			name: `Dashboard ${index + 1}`,
		})
	}
}

describe('create dashboard action', () => {
	it('creates an empty dashboard with the trimmed name and opens it', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		const response = await postCreate(organization.slug, cookie, {
			intent: 'create',
			name: '  Sales overview  ',
		})

		const [created, ...others] = await customDashboards(
			user.id,
			organization.id,
		)
		expect(others).toEqual([])
		expect(created?.name).toBe('Sales overview')
		expect(JSON.parse(created!.config)).toEqual(emptyDashboardConfig())
		expect(response).toBeInstanceOf(Response)
		expect((response as Response).status).toBe(302)
		expect((response as Response).headers.get('Location')).toBe(
			`/${organization.slug}/dashboards/${created!.id}`,
		)
	})

	it('treats a POST without an intent as a create', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		const response = await postCreate(organization.slug, cookie, {
			name: 'a'.repeat(60),
		})

		expect(getResponseStatus(response)).toBe(302)
		const [created] = await customDashboards(user.id, organization.id)
		expect(created?.name).toBe('a'.repeat(60))
	})

	it('rejects missing, blank and too long names with a 400', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		expectRejected(
			await postCreate(organization.slug, cookie, { intent: 'create' }),
			400,
			'name-required',
		)
		expectRejected(
			await postCreate(organization.slug, cookie, {
				intent: 'create',
				name: '',
			}),
			400,
			'name-required',
		)
		expectRejected(
			await postCreate(organization.slug, cookie, {
				intent: 'create',
				name: '    ',
			}),
			400,
			'name-required',
		)
		expectRejected(
			await postCreate(organization.slug, cookie, {
				intent: 'create',
				name: 'a'.repeat(61),
			}),
			400,
			'name-too-long',
		)
		expect(await customDashboards(user.id, organization.id)).toEqual([])
	})

	it('rejects other intents', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		expectRejected(
			await postCreate(organization.slug, cookie, {
				intent: 'rename',
				name: 'Renamed',
			}),
			400,
			'invalid-request',
		)
		expect(await customDashboards(user.id, organization.id)).toEqual([])
	})

	it('caps custom dashboards at 25 per user and organization', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')
		const otherOrganization = await createTestOrganization(user.id, 'member')
		const colleague = await insertTestMember(organization.id)
		await insertCustomDashboards({
			organizationId: organization.id,
			ownerId: user.id,
			count: MAX_CUSTOM_DASHBOARDS,
		})
		// Dashboards shared with the user are not theirs and do not count.
		const shared = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: colleague.user.id,
		})
		await insertTestShare({
			dashboardId: shared.id,
			userId: user.id,
			sharedById: colleague.user.id,
		})

		expectRejected(
			await postCreate(organization.slug, cookie, {
				intent: 'create',
				name: 'One too many',
			}),
			400,
			'limit-reached',
		)
		expect(await customDashboards(user.id, organization.id)).toHaveLength(
			MAX_CUSTOM_DASHBOARDS,
		)

		// The cap is per organization and per user.
		expect(
			getResponseStatus(
				await postCreate(otherOrganization.slug, cookie, {
					intent: 'create',
					name: 'Elsewhere',
				}),
			),
		).toBe(302)
		expect(
			getResponseStatus(
				await postCreate(organization.slug, colleague.cookie, {
					intent: 'create',
					name: 'Mine',
				}),
			),
		).toBe(302)
	})

	it('returns 404 for an organization the user is not a member of', async () => {
		const { cookie } = await setupTestOrgWithUser('member')
		const outsider = await insertTestUser()
		const organization = await createTestOrganization(outsider.id, 'admin')

		const error = await postCreate(organization.slug, cookie, {
			intent: 'create',
			name: 'Intruder',
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(Response)
		expect((error as Response).status).toBe(404)
		expect(
			await db
				.select({ id: Dashboard.id })
				.from(Dashboard)
				.where(eq(Dashboard.organizationId, organization.id)),
		).toEqual([])
	})
})

describe('dashboards index loader', () => {
	it('redirects to Home', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		const request = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/dashboards`,
			{},
			cookie,
		)

		const response = await loader({
			request,
			params: { orgSlug: organization.slug },
			context: {},
		} as any)

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(`/${organization.slug}`)
	})
})
