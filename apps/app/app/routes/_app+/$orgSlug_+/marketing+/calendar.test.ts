import { db, eq, MarketingOccasionChoice, Organization } from '@repo/database'
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action, loader } from './calendar.tsx'
import { activateTestLingui } from './test-lingui.ts'

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return { ...actual, requireUserWithOrganizationPermission: vi.fn() }
	},
)
vi.mock('#app/utils/marketing/marketing-flags.server.ts', () => ({
	getMarketingFeatures: vi.fn(),
}))

const features = (calendar: boolean) =>
	({ calendar }) as Awaited<ReturnType<typeof getMarketingFeatures>>

function post(fields: Record<string, string>) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	return new Request('http://localhost/acme/marketing/calendar', {
		method: 'POST',
		body: form,
	})
}

describe('Marketing calendar route (#152)', () => {
	let orgId: string
	let fetchTenant: ReturnType<typeof vi.fn>
	const args = (request: Request) =>
		({ request, params: { orgSlug: 'acme' }, context: {} }) as never

	beforeAll(async () => {
		const user = await createTestUser()
		orgId = (await createTestOrganization(user.id)).id
		await db
			.update(Organization)
			.set({ dataRegion: 'us', name: 'Casa Verde' })
			.where(eq(Organization.id, orgId))
	})
	beforeEach(() => {
		activateTestLingui()
		fetchTenant = vi.fn(async () => Response.json({ campaigns: [] }))
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue('user_1')
		vi.mocked(getMarketingFeatures).mockResolvedValue(features(true))
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockImplementation(
			async () =>
				({
					orgId,
					orgSlug: 'acme',
					dataRegion: 'us',
					jwt: 'jwt',
					tenantApiUrl: 'http://localhost:3007',
					fetchTenant: fetchTenant as never,
				}) as never,
		)
	})
	afterEach(() => vi.restoreAllMocks())

	it('the loader needs read:campaign and is a 404 while the flag is off', async () => {
		const result = (await loader(
			args(new Request('http://localhost/x?month=2026-05')),
		)) as { market: string; month: string; occasions: Array<{ key: string }> }
		expect(requireUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.anything(),
			orgId,
			ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		)
		expect(result.market).toBe('us')
		expect(result.month).toBe('2026-05')
		expect(result.occasions.some((o) => o.key === 'us_mothers_day')).toBe(true)

		vi.mocked(getMarketingFeatures).mockResolvedValue(features(false))
		await expect(
			loader(args(new Request('http://localhost/x'))),
		).rejects.toMatchObject({
			status: 404,
		})
	})

	it('the action needs update:campaign and is a 404 with the flag off', async () => {
		await action(
			args(post({ intent: 'auto', key: 'us_mothers_day', on: 'true' })),
		)
		expect(requireUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.anything(),
			orgId,
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
		)
		vi.mocked(getMarketingFeatures).mockResolvedValue(features(false))
		await expect(
			action(
				args(post({ intent: 'dismiss', key: 'us_mothers_day', year: '2026' })),
			),
		).rejects.toMatchObject({ status: 404 })
	})

	it('Auto-schedule, Dismiss and restore change the choice; nonsense changes nothing', async () => {
		const choice = async () =>
			(
				await db
					.select()
					.from(MarketingOccasionChoice)
					.where(eq(MarketingOccasionChoice.organizationId, orgId))
			).find((row) => row.occasionKey === 'us_mothers_day')

		expect(
			await action(
				args(
					post({
						intent: 'auto',
						key: 'us_mothers_day',
						on: 'true',
						channel: 'sms',
					}),
				),
			),
		).toEqual({ ok: true })
		expect(await choice()).toMatchObject({ autoSchedule: true, channel: 'sms' })

		await action(
			args(post({ intent: 'dismiss', key: 'us_mothers_day', year: '2026' })),
		)
		expect((await choice())?.dismissedYear).toBe(2026)
		await action(
			args(post({ intent: 'restore', key: 'us_mothers_day', year: '2026' })),
		)
		expect((await choice())?.dismissedYear).toBeNull()

		const bad = (await action(
			args(post({ intent: 'dismiss', key: 'not_an_occasion', year: '2026' })),
		)) as { error?: string }
		expect(bad.error).toBeTruthy()
		const worse = (await action(args(post({ intent: 'steal' })))) as {
			error?: string
		}
		expect(worse.error).toBeTruthy()
	})
})
