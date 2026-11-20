import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateTestLingui } from '#app/routes/_app+/$orgSlug_+/marketing+/test-lingui.ts'
import { checkJourneyOffers } from '#app/utils/discounts/marketing-offers.server.ts'
import { renderJourneyEmailNodes } from '#app/utils/email/journey-render.server.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import { loadProgramCards, turnOnProgram } from './programs.server.ts'

vi.mock('#app/utils/marketing/marketing-flags.server.ts', () => ({
	getMarketingFeatures: vi.fn(),
}))
vi.mock('#app/utils/marketing/reservation-triggers.server.ts', () => ({
	reservationTriggersEnabled: vi.fn(async () => true),
}))
vi.mock('#app/utils/marketing/loyalty-triggers.server.ts', () => ({
	loyaltyTriggersEnabled: vi.fn(async () => false),
}))
vi.mock('#app/utils/email/render-context.server.ts', () => ({
	loadEmailRenderContext: vi.fn(async () => ({
		locale: 'en',
		siteOrigin: 'https://olive.example.com',
	})),
}))
vi.mock('#app/utils/email-branding.server.ts', () => ({
	resolveEmailBrandingForOrg: vi.fn(async () => ({
		organizationName: 'Olive & Co',
	})),
}))
vi.mock('#app/utils/email/journey-render.server.ts', () => ({
	renderJourneyEmailNodes: vi.fn(),
}))
vi.mock('#app/utils/discounts/marketing-offers.server.ts', () => ({
	checkJourneyOffers: vi.fn(),
}))

const on = {
	audiences: false,
	orderAutomations: true,
	birthdays: true,
	cartReminders: true,
	aiDrafts: false,
	push: false,
}
const request = new Request('http://localhost/acme')

describe('ready-made programs on the server (#100)', () => {
	let fetchTenant: ReturnType<typeof vi.fn>

	beforeEach(() => {
		activateTestLingui()
		fetchTenant = vi.fn(async (path: string, init?: RequestInit) => {
			if (path === '/operator/marketing/settings' && !init) {
				return Response.json({
					frequencyCapConfigured: false,
					defaultFrequencyCap: { limit: 3, days: 7 },
				})
			}
			if (path === '/operator/marketing/settings') return Response.json({})
			if (path === '/operator/journeys' && init?.method === 'POST') {
				return Response.json({ journey: { id: 'j_new' } })
			}
			if (path.endsWith('/publish')) return Response.json({ success: true })
			return Response.json({})
		})
		vi.mocked(getMarketingFeatures).mockResolvedValue(on)
		// Stand-in for rendering: every email gets some HTML.
		vi.mocked(renderJourneyEmailNodes).mockImplementation(
			async (_org, nodes) =>
				({
					ok: true,
					nodes: (nodes as Array<{ type: string; data: object }>).map((node) =>
						node.type === 'action_email'
							? { ...node, data: { ...node.data, bodyHtml: '<p>x</p>' } }
							: node,
					),
				}) as never,
		)
		vi.mocked(checkJourneyOffers).mockImplementation(
			async ({ nodes }) => ({ ok: true, nodes: [...nodes] }) as never,
		)
	})
	afterEach(() => vi.clearAllMocks())

	const turnOn = (over: Partial<Parameters<typeof turnOnProgram>[0]> = {}) =>
		turnOnProgram({
			fetchTenant: fetchTenant as never,
			request,
			organizationId: 'org_1',
			userId: 'user_1',
			baseUrl: 'https://app.example.com',
			programId: 'cart_reminder',
			channel: 'email',
			discountOffer: null,
			reviewUrl: null,
			publish: true,
			...over,
		})

	type CreatedJourney = {
		programId?: string
		programVersion?: number
		triggerType?: string
		goal?: string
		nodes: Array<{ type: string; data: { discountOffer?: unknown } }>
	}

	const created = (): CreatedJourney =>
		JSON.parse(
			(
				fetchTenant.mock.calls.find(
					([path, init]) =>
						path === '/operator/journeys' && init?.method === 'POST',
				)![1] as RequestInit
			).body as string,
		) as CreatedJourney

	it('shows a card only when its trigger is available, with status and 30-day results', async () => {
		const cards = await loadProgramCards({
			fetchTenant: fetchTenant as never,
			request,
			organizationId: 'org_1',
			features: { ...on, cartReminders: false },
			language: 'en',
			journeys: [
				{
					id: 'j1',
					status: 'active',
					version: 1,
					programId: 'win_back',
					programVersion: 1,
				},
				{
					id: 'j2',
					status: 'active',
					version: 4,
					programId: 'welcome_series',
					programVersion: 1,
				},
				{ id: 'j3', status: 'archived', programId: 'second_order' },
			],
		})
		const ids = cards.map((card) => card.id)
		expect(ids).not.toContain('cart_reminder')
		expect(ids).toContain('win_back')
		const byId = Object.fromEntries(cards.map((card) => [card.id, card]))
		expect(byId.win_back!.status).toBe('on')
		expect(byId.welcome_series!.status).toBe('customized')
		// An archived journey does not count: the program is off again.
		expect(byId.second_order!.status).toBe('off')
		expect(byId.second_order!.journeyId).toBeNull()
	})

	it('turns a program on: branding, goal, program id, version and trigger carried; published; default limit set once', async () => {
		const result = await turnOn()
		expect(result).toEqual({ ok: true, journeyId: 'j_new' })
		const body = created()
		expect(body).toMatchObject({
			programId: 'cart_reminder',
			programVersion: 1,
			triggerType: 'cart_left_behind',
			goal: 'order',
		})
		expect(JSON.stringify(body.nodes)).toContain('<p>x</p>')
		expect(
			fetchTenant.mock.calls.some(([path]) =>
				String(path).endsWith('/publish'),
			),
		).toBe(true)
		const settingsPut = fetchTenant.mock.calls.find(
			([path, init]) =>
				path === '/operator/marketing/settings' && init?.method === 'PUT',
		)
		expect(JSON.parse(settingsPut![1].body)).toEqual({
			frequencyCap: { limit: 3, days: 7 },
		})
	})

	it('Customize creates a draft (nothing published)', async () => {
		await turnOn({ publish: false })
		expect(
			fetchTenant.mock.calls.some(([path]) =>
				String(path).endsWith('/publish'),
			),
		).toBe(false)
	})

	it('an organization that chose no limit keeps it', async () => {
		fetchTenant.mockImplementation(async (path: string, init?: RequestInit) =>
			path === '/operator/marketing/settings' && !init
				? Response.json({ frequencyCapConfigured: true })
				: path === '/operator/journeys' && init?.method === 'POST'
					? Response.json({ journey: { id: 'j_new' } })
					: Response.json({ success: true }),
		)
		await turnOn()
		expect(
			fetchTenant.mock.calls.some(
				([path, init]) =>
					path === '/operator/marketing/settings' && init?.method === 'PUT',
			),
		).toBe(false)
	})

	it('puts the coupon on the steps that take one, and refuses one the checks refuse', async () => {
		const offer = {
			mode: 'unique',
			discountId: 'd1',
			prefix: '',
			validDays: 14,
		}
		await turnOn({ discountOffer: offer })
		const withOffer = created().nodes.filter(
			(node: { data: { discountOffer?: unknown } }) => node.data.discountOffer,
		)
		expect(withOffer).toHaveLength(1)

		fetchTenant.mockClear()
		vi.mocked(checkJourneyOffers).mockResolvedValueOnce({
			ok: false,
			error: 'discount_inactive',
		} as never)
		const refused = await turnOn({ discountOffer: offer })
		expect(refused).toMatchObject({ ok: false, error: 'offer_invalid' })
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it('refuses a program that is off for the organization, an unknown one, and a second turn-on', async () => {
		vi.mocked(getMarketingFeatures).mockResolvedValue({
			...on,
			cartReminders: false,
		})
		expect(await turnOn()).toMatchObject({
			ok: false,
			error: 'program_unavailable',
		})
		expect(await turnOn({ programId: 'nope' })).toMatchObject({
			ok: false,
			error: 'program_unknown',
		})
		vi.mocked(getMarketingFeatures).mockResolvedValue(on)
		fetchTenant.mockImplementation(async (path: string, init?: RequestInit) =>
			path === '/operator/journeys' && init?.method === 'POST'
				? Response.json({ error: 'program_already_active' }, { status: 409 })
				: Response.json({}),
		)
		expect(await turnOn()).toMatchObject({
			ok: false,
			error: 'program_already_active',
		})
	})

	it('the review request needs an https link', async () => {
		expect(
			await turnOn({
				programId: 'after_visit',
				reviewUrl: 'javascript:alert(1)',
			}),
		).toMatchObject({ ok: false, error: 'review_link_required' })
		expect(
			await turnOn({
				programId: 'after_visit',
				reviewUrl: 'https://g.page/r/olive/review',
			}),
		).toMatchObject({ ok: true })
		expect(JSON.stringify(created().nodes)).toContain(
			'https://g.page/r/olive/review',
		)
	})
})
