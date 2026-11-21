import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import { action as detailAction } from './automations.$journeyId.tsx'
import { action as newAction } from './automations.new.tsx'
import { activateTestLingui } from './test-lingui.ts'

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return {
			...actual,
			requireUserWithOrganizationPermission: vi.fn(),
			requireAnyUserWithOrganizationPermission: vi.fn(),
		}
	},
)
vi.mock('#app/utils/marketing/marketing-flags.server.ts', () => ({
	getMarketingFeatures: vi.fn(),
}))

const flags = (
	over: Partial<Awaited<ReturnType<typeof getMarketingFeatures>>>,
) => ({
	audiences: false,
	orderAutomations: false,
	birthdays: false,
	cartReminders: false,
	aiDrafts: false,
	push: false,
	...over,
})

function graph(triggerType: string, config: Record<string, unknown> = {}) {
	return JSON.stringify({
		nodes: [
			{ id: 'trigger', type: 'trigger', data: { triggerType, config } },
			{ id: 'sms', type: 'action_sms', data: { messageText: 'Hi {{name}}' } },
		],
		edges: [{ id: 'e1', source: 'trigger', target: 'sms' }],
	})
}

function post(fields: Record<string, string>) {
	const form = new FormData()
	for (const [k, v] of Object.entries(fields)) form.set(k, v)
	return new Request('http://localhost/acme/marketing/automations/new', {
		method: 'POST',
		body: form,
	})
}

describe('order, birthday and cart triggers in the automation editor (#99 #151 #150)', () => {
	let fetchTenant: ReturnType<typeof vi.fn>
	const args = (request: Request, params: Record<string, string> = {}) =>
		({ request, params: { orgSlug: 'acme', ...params }, context: {} }) as never

	beforeEach(() => {
		activateTestLingui()
		fetchTenant = vi.fn()
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue('user_1')
		vi.mocked(getMarketingFeatures).mockResolvedValue(flags({}))
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockResolvedValue({
			orgId: 'org_1',
			orgSlug: 'acme',
			dataRegion: 'us',
			jwt: 'jwt',
			tenantApiUrl: 'http://localhost:3007',
			fetchTenant: fetchTenant as never,
		})
	})
	afterEach(() => vi.restoreAllMocks())

	it.each([
		['order_first_placed', {}, 'order'],
		['order_completed', {}, 'order'],
		['guest_lapsed', {}, 'order'],
		['birthday_coming_up', {}, 'birthday'],
		['cart_left_behind', {}, 'cart'],
	] as const)(
		'refuses %s while its flag is off',
		async (trigger, _config, _kind) => {
			void _config
			void _kind
			const result = (await newAction(
				args(post({ name: 'X', graphJson: graph(trigger) })),
			)) as { error?: string }
			expect(result.error).toMatch(/Turn on/)
			expect(fetchTenant).not.toHaveBeenCalled()
		},
	)

	it('cart reminders need order automations too', async () => {
		// The helper folds this: cartReminders is only true with orderAutomations.
		vi.mocked(getMarketingFeatures).mockResolvedValue(
			flags({ cartReminders: false, orderAutomations: true }),
		)
		const result = (await newAction(
			args(post({ name: 'X', graphJson: graph('cart_left_behind') })),
		)) as { error?: string }
		expect(result.error).toMatch(/cart reminders/)
	})

	it('saves with the flag on and sends the goal from the trigger settings', async () => {
		vi.mocked(getMarketingFeatures).mockResolvedValue(
			flags({ orderAutomations: true }),
		)
		fetchTenant.mockResolvedValueOnce(Response.json({ journey: { id: 'j1' } }))
		await newAction(
			args(
				post({
					name: 'Win back',
					graphJson: graph('guest_lapsed', { days: 60, goal: 'order' }),
				}),
			),
		)
		const sent = JSON.parse(fetchTenant.mock.calls[0]![1].body as string)
		expect(sent).toMatchObject({
			triggerType: 'guest_lapsed',
			goal: 'order',
			triggerConfig: { days: 60, goal: 'order' },
		})
		// Without the toggle there is no goal.
		fetchTenant.mockResolvedValueOnce(Response.json({ journey: { id: 'j2' } }))
		await newAction(
			args(
				post({ name: 'Plain', graphJson: graph('guest_lapsed', { days: 30 }) }),
			),
		)
		const secondBody = JSON.parse(
			(fetchTenant.mock.calls[1]![1] as RequestInit).body as string,
		) as { goal: string | null }
		expect(secondBody.goal).toBeNull()
	})

	it('a journey that already uses a trigger keeps saving with its flag off', async () => {
		fetchTenant
			// currentTriggerType lookup
			.mockResolvedValueOnce(
				Response.json({ journey: { triggerType: 'order_first_placed' } }),
			)
			// the PUT
			.mockResolvedValueOnce(Response.json({ success: true }))
		const result = (await detailAction(
			args(
				post({
					intent: 'save',
					name: 'Existing',
					graphJson: graph('order_first_placed'),
				}),
				{ journeyId: 'j9' },
			),
		)) as { error?: string; success?: boolean }
		expect(result.error).toBeUndefined()
		expect(result.success).toBe(true)
	})
})
