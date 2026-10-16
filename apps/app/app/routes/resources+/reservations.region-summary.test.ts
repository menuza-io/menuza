import { db, eq, Organization } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { loader } from './reservations.region-summary.ts'

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/reservations/regional-internal.server.ts', () => ({
	postRegionalReservationsInternal: regional.post,
}))

const SUMMARY = {
	reservations: 12,
	upcomingReservations: 4,
	byStatus: {
		pending: 0,
		booked: 3,
		confirmed: 1,
		arrived: 0,
		seated: 2,
		finished: 5,
		cancelled: 1,
		no_show: 0,
		declined: 0,
		expired: 0,
	},
	guests: 8,
	waitlistEntries: 2,
	tables: 16,
	experiences: 1,
	payments: 0,
	auditEntries: 20,
}

beforeEach(() => {
	regional.post
		.mockReset()
		.mockResolvedValue(new Response(JSON.stringify(SUMMARY), { status: 200 }))
})

async function call(cookie: string, query: string) {
	const url = new URL(
		`http://localhost:3001/resources/reservations/region-summary${query}`,
	)
	try {
		const result = (await loader({
			request: createAuthenticatedRequest(url.toString(), {}, cookie),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/reservations/region-summary',
		} as any)) as Response
		return {
			status: result.status,
			body: (await result.json()) as any,
			cacheControl: result.headers.get('cache-control'),
		}
	} catch (error: any) {
		if (error instanceof Response) return { status: error.status, body: null }
		if (error?.init?.status) return { status: error.init.status, body: null }
		throw error
	}
}

async function orgWithAdmin(hasProvisionedDb = true) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({ hasProvisionedDb, dataRegion: 'ksa' })
		.where(eq(Organization.id, organization.id))
	const { cookie } = await createTestSession(user.id)
	return { organization, cookie }
}

describe('GET /resources/reservations/region-summary', () => {
	it('returns counts for an admin, from the organization’s current region', async () => {
		const { organization, cookie } = await orgWithAdmin()
		const result = await call(cookie, `?orgSlug=${organization.slug}`)
		expect(result.status).toBe(200)
		expect(result.cacheControl).toBe('private, no-store')
		expect(result.body).toMatchObject({
			summary: SUMMARY,
			known: true,
			requiresConfirmation: true,
		})
		expect(regional.post).toHaveBeenCalledWith(
			expect.objectContaining({
				dataRegion: 'ksa',
				path: 'summary',
				body: { orgId: organization.id },
			}),
		)
	})

	it('says no confirmation is needed for an empty region', async () => {
		const { organization, cookie } = await orgWithAdmin()
		regional.post.mockResolvedValue(
			new Response(
				JSON.stringify({
					...SUMMARY,
					reservations: 0,
					upcomingReservations: 0,
					guests: 0,
					waitlistEntries: 0,
					tables: 0,
					experiences: 0,
					payments: 0,
					auditEntries: 0,
				}),
				{ status: 200 },
			),
		)
		const result = await call(cookie, `?orgSlug=${organization.slug}`)
		expect(result.body.requiresConfirmation).toBe(false)
	})

	it('reports an unknown summary as needing confirmation', async () => {
		const { organization, cookie } = await orgWithAdmin()
		regional.post.mockResolvedValue(new Response('{}', { status: 500 }))
		const result = await call(cookie, `?orgSlug=${organization.slug}`)
		expect(result.body).toMatchObject({
			summary: null,
			known: false,
			requiresConfirmation: true,
		})
	})

	it('asks no region for an organization without a database', async () => {
		const { organization, cookie } = await orgWithAdmin(false)
		const result = await call(cookie, `?orgSlug=${organization.slug}`)
		expect(result.body).toMatchObject({
			summary: null,
			requiresConfirmation: false,
		})
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('refuses outsiders, members without settings access, and bad input', async () => {
		const { organization } = await orgWithAdmin()
		const outsider = await createTestUser()
		const outsiderSession = await createTestSession(outsider.id)
		expect(
			(await call(outsiderSession.cookie, `?orgSlug=${organization.slug}`))
				.status,
		).toBe(404)

		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const memberSession = await createTestSession(member.id)
		expect(
			(await call(memberSession.cookie, `?orgSlug=${organization.slug}`))
				.status,
		).toBe(403)

		expect((await call(memberSession.cookie, '')).status).toBe(400)
		expect(regional.post).not.toHaveBeenCalled()
	})
})
