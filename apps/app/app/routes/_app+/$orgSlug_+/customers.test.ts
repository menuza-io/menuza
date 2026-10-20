import { userHasOrganizationPermission } from '@repo/auth'
import { type FilterCondition } from '@repo/ui/filters'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { isActiveCustomerCondition, loader } from './customers.tsx'

vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<typeof import('@repo/auth')>()),
	userHasOrganizationPermission: vi.fn(),
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(),
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		READ_SETTINGS_ANY: 'read:settings:any',
		UPDATE_SETTINGS_ANY: 'update:settings:any',
	},
	requireUserWithOrganizationPermission: vi.fn().mockResolvedValue('user-1'),
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: vi.fn(),
}))

function condition(
	overrides: Partial<FilterCondition> & Pick<FilterCondition, 'field'>,
): FilterCondition {
	return {
		path: [overrides.field],
		operator: 'is_any_of',
		values: [],
		negated: false,
		...overrides,
	}
}

describe('isActiveCustomerCondition', () => {
	it('ignores a status chip with no value picked', () => {
		expect(isActiveCustomerCondition(condition({ field: 'status' }))).toBe(
			false,
		)
	})

	it('ignores a text chip with a blank value', () => {
		expect(
			isActiveCustomerCondition(
				condition({ field: 'name', operator: 'contains', values: ['  '] }),
			),
		).toBe(false)
	})

	it('counts a chip with a value', () => {
		expect(
			isActiveCustomerCondition(
				condition({ field: 'status', values: ['verified'] }),
			),
		).toBe(true)
		expect(
			isActiveCustomerCondition(
				condition({ field: 'name', operator: 'contains', values: ['ali'] }),
			),
		).toBe(true)
	})

	it('counts operators that take no value', () => {
		expect(
			isActiveCustomerCondition(
				condition({ field: 'email', operator: 'empty' }),
			),
		).toBe(true)
		expect(
			isActiveCustomerCondition(
				condition({ field: 'email', operator: 'not_empty' }),
			),
		).toBe(true)
	})
})

describe('customers loader', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(requireUserOrganization).mockResolvedValue({
			id: 'org-1',
		} as never)
		vi.mocked(getOperatorTenantClient).mockResolvedValue({
			jwt: 'jwt',
			tenantApiUrl: 'https://tenant.example.test',
		} as never)
	})

	async function load() {
		return loader({
			request: new Request('http://localhost:3001/acme/customers'),
			params: { orgSlug: 'acme' },
			context: {},
		} as never)
	}

	it('mints an erase-capable token only for people who can update settings', async () => {
		vi.mocked(userHasOrganizationPermission).mockResolvedValue(true)
		expect(await load()).toMatchObject({ canErase: true })
		expect(getOperatorTenantClient).toHaveBeenCalledWith(
			expect.any(Request),
			'acme',
			{ canDelete: true },
		)
	})

	it('withholds the erase token from read-only people', async () => {
		vi.mocked(userHasOrganizationPermission).mockResolvedValue(false)
		expect(await load()).toMatchObject({ canErase: false })
		expect(getOperatorTenantClient).toHaveBeenCalledWith(
			expect.any(Request),
			'acme',
			{ canDelete: false },
		)
	})
})
