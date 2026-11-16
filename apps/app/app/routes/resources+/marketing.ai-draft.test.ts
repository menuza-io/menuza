import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
})

const mocks = vi.hoisted(() => ({
	requireUserId: vi.fn(async () => 'user_1'),
	requireUserOrganization: vi.fn(async () => ({
		id: 'org_1',
		name: 'Olive',
		description: 'Kitchen',
	})),
	requirePermission: vi.fn(async () => 'user_1'),
	features: vi.fn(async () => ({ aiDrafts: true })),
	checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5 })),
	generate: vi.fn(),
}))

vi.mock('@repo/auth', () => ({ requireUserId: mocks.requireUserId }))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.requireUserOrganization,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		UPDATE_CAMPAIGN_ANY: 'update:campaign:any',
		UPDATE_AUTOMATION_ANY: 'update:automation:any',
	},
	requireAnyUserWithOrganizationPermission: mocks.requirePermission,
}))
vi.mock('#app/utils/marketing/marketing-flags.server.ts', () => ({
	getMarketingFeatures: mocks.features,
}))
vi.mock('#app/utils/rate-limit.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#app/utils/rate-limit.server.ts')>()),
	checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('#app/utils/email/menu-items.server.ts', () => ({
	listPickableMenuItems: vi.fn(async () => ({
		items: [
			{ itemId: 'i1', name: 'Falafel', description: 'Crisp', priceMinor: 1250, currency: 'SAR', imageUrl: '', path: '/menu?item=i1' },
		],
		locations: [],
		currency: 'SAR',
	})),
}))
vi.mock('#app/utils/email/render-context.server.ts', () => ({
	loadEmailRenderContext: vi.fn(async () => ({
		siteOrigin: 'https://olive.example.com',
		coupon: null,
	})),
}))

import { action } from './marketing.ai-draft.ts'

function call(body: unknown, method = 'POST') {
	return action(
		{
			request: new Request('http://localhost:3001/resources/marketing/ai-draft', {
				method,
				headers: { 'content-type': 'application/json' },
				body: method === 'GET' ? undefined : JSON.stringify(body),
			}),
			params: {},
			context: {} as never,
		} as never,
		{ generate: mocks.generate },
	)
}

const draftBody = {
	orgSlug: 'olive',
	action: 'draft',
	channel: 'email',
	goal: 'announce_dish',
	itemIds: ['i1'],
}

describe('POST /resources/marketing/ai-draft (#155)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.features.mockResolvedValue({ aiDrafts: true })
		mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 5 })
		mocks.requirePermission.mockResolvedValue('user_1')
		mocks.generate.mockResolvedValue({
			subjects: ['Falafel night'],
			blocks: [
				{ type: 'heading', text: 'Falafel night' },
				{ type: 'menu_item', itemIds: ['i1'] },
			],
		})
	})

	it('drafts an email and sends the model no guest data', async () => {
		const res = await call(draftBody)
		expect(res.status).toBe(200)
		const { draft } = (await res.json()) as { draft: { subjects: string[]; blocks: Array<{ type: string }> } }
		expect(draft.subjects).toEqual(['Falafel night'])
		expect(draft.blocks.map((b) => b.type)).toEqual(['heading', 'menu_item'])
		const args = mocks.generate.mock.calls[0]![0] as { system: string; prompt: string }
		expect(args.prompt).toContain('Olive')
		expect(args.prompt).toContain('Falafel')
	})

	it('rewrites one block', async () => {
		mocks.generate.mockResolvedValue({ text: 'Shorter.' })
		const res = await call({ orgSlug: 'olive', action: 'rewrite', text: 'A long text', instruction: 'shorter' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ text: 'Shorter.' })
	})

	it('is a 404 while the flag is off, before any model call or rate-limit use', async () => {
		mocks.features.mockResolvedValue({ aiDrafts: false })
		const res = await call(draftBody)
		expect(res.status).toBe(404)
		expect(mocks.generate).not.toHaveBeenCalled()
		expect(mocks.checkRateLimit).not.toHaveBeenCalled()
	})

	it('refuses a member without a campaign or automation update permission', async () => {
		mocks.requirePermission.mockRejectedValue(new Response('Forbidden', { status: 403 }))
		await expect(call(draftBody)).rejects.toMatchObject({ status: 403 })
		expect(mocks.generate).not.toHaveBeenCalled()
	})

	it('answers ai_draft_limit (429) when the operator or the organization is over the limit', async () => {
		mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 })
		let res = await call(draftBody)
		expect(res.status).toBe(429)
		expect(await res.json()).toEqual({ error: 'ai_draft_limit' })
		mocks.checkRateLimit
			.mockResolvedValueOnce({ allowed: true, remaining: 1 })
			.mockResolvedValueOnce({ allowed: false, remaining: 0 })
		res = await call(draftBody)
		expect(res.status).toBe(429)
		expect(mocks.generate).not.toHaveBeenCalled()
	})

	it('checks the operator per hour and the organization per day', async () => {
		await call(draftBody)
		const [operator, org] = mocks.checkRateLimit.mock.calls as unknown as [
			[{ type: string; value: string }, { maxRequests: number; windowMs: number }],
			[{ type: string; value: string }, { maxRequests: number; windowMs: number }],
		]
		expect(operator[0]).toEqual({ type: 'user', value: 'user_1' })
		expect(operator[1]).toMatchObject({ maxRequests: 20, windowMs: 3_600_000 })
		expect(org[0]).toEqual({ type: 'org', value: 'org_1' })
		expect(org[1]).toMatchObject({ maxRequests: 200, windowMs: 86_400_000 })
	})

	it('invalid model output is ai_draft_invalid (422), and a bad body is 400', async () => {
		mocks.generate.mockResolvedValue({ subjects: ['x'], blocks: [] })
		const res = await call(draftBody)
		expect(res.status).toBe(422)
		expect(await res.json()).toEqual({ error: 'ai_draft_invalid' })
		expect((await call({ orgSlug: 'olive', channel: 'push', goal: 'x' })).status).toBe(400)
		expect((await call({ ...draftBody, bestSellers: [{ itemId: 'i1', count: 2, name: 'Rana' }] })).status).toBe(400)
		expect((await call(draftBody, 'GET')).status).toBe(405)
	})

	it('a provider failure never echoes the prompt', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		mocks.generate.mockRejectedValue(new Error('prompt was: Olive Falafel'))
		const res = await call(draftBody)
		expect(res.status).toBe(502)
		expect(JSON.stringify(await res.json())).not.toContain('Falafel')
		expect(JSON.stringify(spy.mock.calls)).not.toContain('Falafel')
		spy.mockRestore()
	})

	it('is 503 when no model is configured', async () => {
		delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
		const res = await action({
			request: new Request('http://localhost:3001/x', {
				method: 'POST',
				body: JSON.stringify(draftBody),
			}),
		} as never)
		expect(res.status).toBe(503)
	})
})
