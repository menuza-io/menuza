import { db, eq, Organization } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'
import { collectStaffExportsForUser } from './dsar.server.ts'

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('./regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

const FILE = {
	format: 'staff-export/v1',
	exportedAt: 1,
	orgId: 'o',
	region: 'us',
	includes: { pay: true, private: true },
	staff: [{ id: 's1', firstName: 'Rana' }],
}

beforeEach(() => {
	regional.post.mockReset()
})

async function org(
	userId: string,
	options: { dataRegion?: 'us' | 'ksa'; provisioned?: boolean } = {},
) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	await db
		.update(Organization)
		.set({
			dataRegion: options.dataRegion ?? 'us',
			hasProvisionedDb: options.provisioned ?? true,
		})
		.where(eq(Organization.id, organization.id))
	await addOrganizationMember(userId, organization.id)
	return organization
}

describe('collectStaffExportsForUser', () => {
	it('attaches a US-region record generated in-region', async () => {
		const user = await createTestUser()
		const organization = await org(user.id)
		regional.post.mockResolvedValue(
			new Response(JSON.stringify({ export: FILE }), { status: 200 }),
		)
		const result = await collectStaffExportsForUser(user.id)
		expect(result).toEqual([
			{
				organizationId: organization.id,
				organizationName: organization.name,
				status: 'included',
				record: FILE,
			},
		])
		expect(regional.post).toHaveBeenCalledWith(
			expect.objectContaining({
				dataRegion: 'us',
				path: 'export-user',
				body: { orgId: organization.id, userId: user.id },
			}),
		)
	})

	it('omits organizations where the user has no staff record', async () => {
		const user = await createTestUser()
		await org(user.id)
		regional.post.mockResolvedValue(
			new Response(JSON.stringify({ export: null }), { status: 200 }),
		)
		expect(await collectStaffExportsForUser(user.id)).toEqual([])
	})

	it('never fetches a Saudi-region record through the US servers', async () => {
		const user = await createTestUser()
		const organization = await org(user.id, { dataRegion: 'ksa' })
		const result = await collectStaffExportsForUser(user.id)
		expect(regional.post).not.toHaveBeenCalled()
		expect(result).toEqual([
			expect.objectContaining({
				organizationId: organization.id,
				status: 'regional_delivery_required',
			}),
		])
		expect(JSON.stringify(result)).not.toContain('Rana')
	})

	it('skips organizations without a regional database', async () => {
		const user = await createTestUser()
		await org(user.id, { provisioned: false })
		expect(await collectStaffExportsForUser(user.id)).toEqual([])
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('reports a node that is down or answers badly instead of failing the export', async () => {
		const user = await createTestUser()
		await org(user.id)
		await org(user.id)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		regional.post
			.mockRejectedValueOnce(new Error('ECONNREFUSED'))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ export: { nope: true } }), {
					status: 200,
				}),
			)
		const result = await collectStaffExportsForUser(user.id)
		expect(result.map((entry) => entry.status)).toEqual([
			'unavailable',
			'unavailable',
		])
		errorSpy.mockRestore()
	})
})
