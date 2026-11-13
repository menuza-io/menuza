import { type LoaderFunctionArgs, RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as historyLoader } from './history.tsx'

const mocks = vi.hoisted(() => ({
	requireUserId: vi.fn(),
	requireUserOrganization: vi.fn(),
	requireMenuHistoryAccess: vi.fn(),
	select: vi.fn(),
}))

vi.mock('@repo/auth', () => ({ requireUserId: mocks.requireUserId }))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.requireUserOrganization,
}))
vi.mock('#app/utils/menu/menu-feature-access.server.ts', () => ({
	requireMenuHistoryAccess: mocks.requireMenuHistoryAccess,
}))
vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return {
		...actual,
		db: {
			...actual.db,
			select: mocks.select,
		},
	}
})

const request = new Request('https://app.example/cafe/menu/history')

describe('menu history access', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.requireUserId.mockResolvedValue('user-1')
		mocks.requireUserOrganization.mockResolvedValue({
			id: 'org-1',
			slug: 'cafe',
		})
		mocks.select.mockReturnValue({
			from: vi.fn().mockReturnValue({
				leftJoin: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						orderBy: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			}),
		})
	})

	it('rejects the history loader without menu history access', async () => {
		mocks.requireMenuHistoryAccess.mockRejectedValue(
			new Response('Not Found', { status: 404 }),
		)
		const args: LoaderFunctionArgs = {
			request,
			params: { orgSlug: 'cafe' },
			context: new RouterContextProvider(),
		}
		await expect(historyLoader(args)).rejects.toMatchObject({ status: 404 })
		expect(mocks.select).not.toHaveBeenCalled()
	})
})
