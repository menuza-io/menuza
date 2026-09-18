import type * as DatabaseModule from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	mockDb,
	mockSelectResults,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import {
	ensureDefaultOrganizationLocation,
	getDefaultOrganizationLocationId,
} from './locations.server.ts'

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		OrganizationLocation: drizzleTable,
		and: drizzleOperator,
		eq: drizzleOperator,
		sql: drizzleOperator,
	}
})

describe('ensureDefaultOrganizationLocation', () => {
	beforeEach(() => {
		resetMockDb()
	})

	it('returns existing default location without inserting', async () => {
		mockSelectResults([{ id: 'loc-existing' }])

		const id = await ensureDefaultOrganizationLocation({
			organizationId: 'org-1',
			name: 'Ignored',
		})

		expect(id).toBe('loc-existing')
	})

	it('creates a default location when none exists', async () => {
		mockSelectResults([])
		mockSelectResults([{ id: 'loc-new' }])

		const id = await ensureDefaultOrganizationLocation({
			organizationId: 'org-1',
			name: 'Downtown',
		})

		expect(id).toBe('loc-new')
	})
})

describe('getDefaultOrganizationLocationId', () => {
	beforeEach(() => {
		resetMockDb()
	})

	it('returns null when no default location', async () => {
		mockSelectResults([])
		const id = await getDefaultOrganizationLocationId('org-1')
		expect(id).toBeNull()
	})
})
