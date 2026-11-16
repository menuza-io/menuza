import { i18n } from '@lingui/core'
import { type BroadcastProblem } from '@repo/common/broadcast-checks'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditCampaign } from './campaign-audit.server.ts'
import { prepareCampaignMessage } from './campaign-message.server.ts'
import { runSendChecks } from './campaign-send.server.ts'
import { submitCampaign } from './campaign-submit.server.ts'
import { sendTestBroadcast } from './campaign-test-send.server.ts'

vi.mock('./campaign-audit.server.ts', () => ({ auditCampaign: vi.fn() }))
vi.mock('./campaign-message.server.ts', () => ({
	prepareCampaignMessage: vi.fn(),
}))
vi.mock('./campaign-test-send.server.ts', () => ({
	sendTestBroadcast: vi.fn(),
}))
vi.mock('./campaign-send.server.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	runSendChecks: vi.fn(),
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const message = {
	channel: 'email' as const,
	subject: 'Lunch',
	content: 'Come eat',
	contentHtml: '<p>Come eat</p>',
	contentBlocks: '[]',
	blocks: [],
	discountOffer: null,
}
const warning: BroadcastProblem = {
	code: 'starter_text',
	severity: 'warning',
	blockId: 'b1',
}
const blocking: BroadcastProblem = {
	code: 'audience_zero',
	severity: 'blocking',
}

function form(fields: Record<string, string>) {
	const data = new FormData()
	data.set('name', 'Spring')
	data.set('channel', 'email')
	for (const [key, value] of Object.entries(fields)) data.set(key, value)
	return data
}

const later = () => new Date(Date.now() + 3 * 3_600_000).toISOString()

describe('submitCampaign', () => {
	const fetchTenant = vi.fn()
	const run = (
		fields: Record<string, string>,
		existing?: Parameters<typeof submitCampaign>[0]['existing'],
	) =>
		submitCampaign({
			request: new Request('http://localhost/x'),
			organizationId: 'org',
			userId: 'user',
			fetchTenant,
			formData: form(fields),
			baseUrl: 'http://localhost',
			existing,
		})
	const lastBody = () =>
		JSON.parse(fetchTenant.mock.calls.at(-1)![1].body as string)

	beforeEach(() => {
		fetchTenant
			.mockReset()
			.mockResolvedValue(Response.json({ success: true, campaignId: 'c-new' }))
		vi.mocked(auditCampaign).mockReset().mockResolvedValue(undefined)
		vi.mocked(prepareCampaignMessage)
			.mockReset()
			.mockResolvedValue({ ok: true, message })
		vi.mocked(runSendChecks).mockReset().mockResolvedValue([])
		vi.mocked(sendTestBroadcast).mockReset()
	})

	it('saves a draft without running the checks, and sends nothing', async () => {
		const result = await run({ intent: 'draft' })
		expect(result).toEqual({
			kind: 'saved',
			campaignId: 'c-new',
			intent: 'draft',
		})
		expect(runSendChecks).not.toHaveBeenCalled()
		expect(fetchTenant.mock.calls[0]![0]).toBe('/operator/marketing/campaigns')
		expect(lastBody()).toMatchObject({ saveAsDraft: true, scheduledAt: null })
		expect(vi.mocked(auditCampaign).mock.calls.map(([a]) => a.kind)).toEqual([
			'created',
		])
	})

	it('sends now after the checks pass, and audits the create and the send', async () => {
		const result = await run({ intent: 'send' })
		expect(result).toMatchObject({ kind: 'saved', intent: 'send' })
		expect(runSendChecks).toHaveBeenCalledTimes(1)
		expect(lastBody()).toMatchObject({ saveAsDraft: false, scheduledAt: null })
		expect(vi.mocked(auditCampaign).mock.calls.map(([a]) => a.kind)).toEqual([
			'created',
			'sent',
		])
		// Ids only: no name, subject or message in the audit call.
		const call = vi.mocked(auditCampaign).mock.calls[0]![0]
		expect(JSON.stringify(call)).not.toContain('Lunch')
		expect(JSON.stringify(call)).not.toContain('Spring')
	})

	it('stops at a blocking problem however it was acknowledged, and saves nothing', async () => {
		vi.mocked(runSendChecks).mockResolvedValue([blocking, warning])
		for (const acknowledgeWarnings of ['0', '1']) {
			const result = await run({ intent: 'send', acknowledgeWarnings })
			expect(result).toMatchObject({ kind: 'problems' })
		}
		expect(fetchTenant).not.toHaveBeenCalled()
		expect(auditCampaign).not.toHaveBeenCalled()
	})

	it('stops at a warning until the operator chose Send anyway', async () => {
		vi.mocked(runSendChecks).mockResolvedValue([warning])
		const stopped = await run({ intent: 'send' })
		expect(stopped).toEqual({
			kind: 'problems',
			problems: [warning],
			blocks: [],
		})
		expect(fetchTenant).not.toHaveBeenCalled()

		const through = await run({ intent: 'send', acknowledgeWarnings: '1' })
		expect(through).toMatchObject({ kind: 'saved' })
		expect(fetchTenant).toHaveBeenCalledTimes(1)
	})

	it('schedules with the time and the late window, and checks as of that time', async () => {
		const at = later()
		const result = await run({
			intent: 'schedule',
			scheduledAt: at,
			lateAfterHours: '6',
		})
		expect(result).toMatchObject({ kind: 'saved', intent: 'schedule' })
		expect(lastBody()).toMatchObject({
			scheduledAt: at,
			lateAfterMinutes: 360,
			saveAsDraft: false,
		})
		expect(vi.mocked(runSendChecks).mock.calls[0]![0].sendAtMs).toBe(
			new Date(at).getTime(),
		)
	})

	it('asks for a time to schedule, and refuses a time in the past', async () => {
		expect(await run({ intent: 'schedule' })).toMatchObject({ kind: 'error' })
		expect(
			await run({
				intent: 'schedule',
				scheduledAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		).toMatchObject({ kind: 'error' })
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it('edits through PATCH: send now, schedule, or back to a draft', async () => {
		const existing = {
			id: 'c1',
			retargetOfCampaignId: null,
			discountOffer: null,
		}
		await run({ intent: 'send' }, existing)
		expect(fetchTenant.mock.calls[0]![0]).toBe(
			'/operator/marketing/campaigns/c1',
		)
		expect(fetchTenant.mock.calls[0]![1].method).toBe('PATCH')
		expect(lastBody()).toMatchObject({ sendNow: true, scheduledAt: null })

		const at = later()
		await run({ intent: 'schedule', scheduledAt: at }, existing)
		expect(lastBody()).toMatchObject({ scheduledAt: at })
		expect(lastBody()).not.toHaveProperty('sendNow')

		await run({ intent: 'draft', scheduledAt: at }, existing)
		expect(lastBody()).toMatchObject({ scheduledAt: null })
		expect(lastBody()).not.toHaveProperty('sendNow')
		expect(vi.mocked(auditCampaign).mock.calls.map(([a]) => a.kind)).toContain(
			'updated',
		)
	})

	it('checks a re-send against the original, so the audience is the non-openers', async () => {
		await run(
			{ intent: 'send' },
			{ id: 'c2', retargetOfCampaignId: 'c1', discountOffer: null },
		)
		expect(vi.mocked(runSendChecks).mock.calls[0]![0].retargetOf).toBe('c1')
	})

	it('treats a coupon posted exactly as saved as unchanged, so editing needs no discount permission', async () => {
		const offer = { mode: 'shared', discountId: 'd1', code: 'SAVE10' }
		await run(
			{ intent: 'draft', discountOffer: JSON.stringify(offer) },
			{ id: 'c1', retargetOfCampaignId: null, discountOffer: offer },
		)
		expect(
			vi.mocked(prepareCampaignMessage).mock.calls[0]![0].unchangedOffer,
		).toBe(true)
		await run(
			{
				intent: 'draft',
				discountOffer: JSON.stringify({ ...offer, code: 'NEW' }),
			},
			{ id: 'c1', retargetOfCampaignId: null, discountOffer: offer },
		)
		expect(
			vi.mocked(prepareCampaignMessage).mock.calls[1]![0].unchangedOffer,
		).toBe(false)
	})

	it('a test send saves nothing and is audited only when it was sent', async () => {
		vi.mocked(sendTestBroadcast).mockResolvedValueOnce({
			ok: true,
			message: 'sent',
		})
		expect(await run({ intent: 'test' })).toEqual({
			kind: 'test',
			result: { ok: true, message: 'sent' },
		})
		expect(fetchTenant).not.toHaveBeenCalled()
		expect(runSendChecks).not.toHaveBeenCalled()
		expect(vi.mocked(auditCampaign).mock.calls.map(([a]) => a.kind)).toEqual([
			'test_sent',
		])

		vi.mocked(auditCampaign).mockClear()
		vi.mocked(sendTestBroadcast).mockResolvedValueOnce({
			ok: false,
			message: 'limit',
		})
		await run({ intent: 'test' })
		expect(auditCampaign).not.toHaveBeenCalled()
	})

	it('says why tenant-api refused, in words', async () => {
		fetchTenant.mockResolvedValueOnce(
			Response.json({ error: 'campaign_already_sending' }, { status: 409 }),
		)
		const result = await run(
			{ intent: 'draft' },
			{ id: 'c1', retargetOfCampaignId: null, discountOffer: null },
		)
		expect(result).toMatchObject({ kind: 'error' })
		expect((result as { error: string }).error).toMatch(/already sending/i)
		expect(auditCampaign).not.toHaveBeenCalled()

		fetchTenant.mockResolvedValueOnce(
			Response.json(
				{ error: 'Choose a discount for the {{couponCode}} tag' },
				{ status: 400 },
			),
		)
		expect(((await run({ intent: 'draft' })) as { error: string }).error).toBe(
			'Choose a discount for the {{couponCode}} tag',
		)
	})

	it('keeps texts to verified customers, and shows a refused message', async () => {
		const result = await run({
			intent: 'send',
			channel: 'sms',
			audience: 'unverified',
		})
		expect(result).toMatchObject({ kind: 'error' })
		expect(prepareCampaignMessage).not.toHaveBeenCalled()

		vi.mocked(prepareCampaignMessage).mockResolvedValueOnce({
			ok: false,
			error: 'A dish is gone',
		})
		expect(await run({ intent: 'send' })).toEqual({
			kind: 'error',
			error: 'A dish is gone',
		})
		expect(fetchTenant).not.toHaveBeenCalled()
	})
})
