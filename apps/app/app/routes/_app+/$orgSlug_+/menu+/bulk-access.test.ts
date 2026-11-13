import { type ActionFunctionArgs, RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action as bulkAction } from './bulk.ts'

const mocks = vi.hoisted(() => ({
	requireUserId: vi.fn(),
	requireUserOrganization: vi.fn(),
	requireMenuBulkEditAccess: vi.fn(),
}))

vi.mock('@repo/auth', () => ({ requireUserId: mocks.requireUserId }))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.requireUserOrganization,
}))
vi.mock('#app/utils/menu/menu-feature-access.server.ts', () => ({
	requireMenuBulkEditAccess: mocks.requireMenuBulkEditAccess,
}))
vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return {
		...actual,
		db: {
			...actual.db,
			query: {
				...actual.db.query,
				Organization: {
					findFirst: vi.fn().mockResolvedValue({ currency: 'USD' }),
				},
			},
		},
	}
})

describe('menu bulk access', () => {
	const prevSwitch = process.env.MENU_BULK_EDIT_ENABLED

	afterEach(() => {
		process.env.MENU_BULK_EDIT_ENABLED = prevSwitch
	})

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.requireUserId.mockResolvedValue('user-1')
		mocks.requireUserOrganization.mockResolvedValue({
			id: 'org-1',
			slug: 'cafe',
		})
	})

	it('answers 503 when the kill switch is off', async () => {
		process.env.MENU_BULK_EDIT_ENABLED = 'false'
		const response = await bulkAction({
			request: new Request('https://app.example/cafe/menu/bulk', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ intent: 'preview', targetType: 'item', ids: ['a'], operation: { type: 'price', change: { kind: 'set', value: 1 } } }),
			}),
			params: { orgSlug: 'cafe' },
			context: new RouterContextProvider(),
		} as unknown as ActionFunctionArgs)
		expect(response.status).toBe(503)
		expect(mocks.requireMenuBulkEditAccess).not.toHaveBeenCalled()
	})
})
