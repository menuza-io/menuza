import { db, eq, Organization, OrganizationLocation } from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { hasLocationScopes, loadOrganizationScopes } from './scope.server.ts'

async function location(
	organizationId: string,
	input: {
		name: string
		timezone?: string
		address?: { country: string }
		isActive?: boolean
	},
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: input.name,
			slug: `${input.name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`,
			timezone: input.timezone ?? 'America/Chicago',
			address: input.address ? JSON.stringify(input.address) : null,
			isActive: input.isActive ?? true,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

describe('loadOrganizationScopes', () => {
	it('is the one implicit scope for an organization without locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ staffingTimeZone: 'America/Denver' })
			.where(eq(Organization.id, organization.id))
		const scopes = await loadOrganizationScopes(organization.id)
		expect(scopes).toEqual([
			{
				id: DEFAULT_SCOPE_ID,
				name: organization.name,
				timeZone: 'America/Denver',
				currency: 'USD',
				isActive: true,
			},
		])
		expect(hasLocationScopes(scopes)).toBe(false)
	})

	it('is one scope per location, with its own zone and currency', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await location(organization.id, { name: 'Alpha' })
		const b = await location(organization.id, {
			name: 'Beta',
			timezone: 'Asia/Riyadh',
			address: { country: 'SA' },
		})
		const scopes = await loadOrganizationScopes(organization.id)
		expect(scopes).toEqual([
			{
				id: a,
				name: 'Alpha',
				timeZone: 'America/Chicago',
				currency: 'USD',
				isActive: true,
			},
			{
				id: b,
				name: 'Beta',
				timeZone: 'Asia/Riyadh',
				currency: 'SAR',
				isActive: true,
			},
		])
		expect(hasLocationScopes(scopes)).toBe(true)
	})

	it('hides inactive locations unless asked, and never falls back to the implicit scope', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const closed = await location(organization.id, {
			name: 'Closed',
			isActive: false,
		})
		expect(await loadOrganizationScopes(organization.id)).toEqual([])
		const all = await loadOrganizationScopes(organization.id, {
			includeInactive: true,
		})
		expect(all.map((scope) => [scope.id, scope.isActive])).toEqual([
			[closed, false],
		])
	})

	it('never reads another organization’s locations', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		await location(theirs.organization.id, { name: 'Theirs' })
		const scopes = await loadOrganizationScopes(mine.organization.id)
		expect(scopes.map((scope) => scope.id)).toEqual([DEFAULT_SCOPE_ID])
	})
})
