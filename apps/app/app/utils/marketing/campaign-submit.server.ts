import { i18n } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type BroadcastProblem } from '@repo/common/broadcast-checks'
import { type EmailBlock } from '@repo/common/email-blocks'
import { requireModuleAgreement } from '#app/utils/legal/agreements.server.ts'
import { auditCampaign } from './campaign-audit.server.ts'
import { prepareCampaignMessage } from './campaign-message.server.ts'
import {
	campaignActionError,
	mayProceed,
	readCampaignIntent,
	readCampaignSchedule,
	runSendChecks,
} from './campaign-send.server.ts'
import {
	sendTestBroadcast,
	type TestSendClientFactory,
	type TestSendResult,
} from './campaign-test-send.server.ts'

type FetchTenant = (path: string, init?: RequestInit) => Promise<Response>

export type SubmitResult =
	| { kind: 'saved'; campaignId: string; intent: 'send' | 'schedule' | 'draft' }
	| { kind: 'error'; error: string }
	/** The pre-send check found something; nothing was saved. */
	| { kind: 'problems'; problems: BroadcastProblem[]; blocks: EmailBlock[] }
	| { kind: 'test'; result: TestSendResult }

const AUDIENCES = ['all', 'verified', 'unverified'] as const

/** tenant-api answers a refused action with a code, or a sentence it wrote itself. */
function tenantError(body: { error?: unknown }, fallback: string) {
	const value = body.error
	if (typeof value === 'string' && value.includes(' ')) return value
	return typeof value === 'string' ? campaignActionError(value) : fallback
}

/**
 * The composer and the edit page post the same form (#101, #232). One flow:
 * prepare the message (dishes frozen, coupon checked), then by intent:
 * - `test`: the operator's own inbox, nothing saved;
 * - `draft`: save without checks, nothing is sent;
 * - `send` / `schedule`: the pre-send checks first. A blocking problem always
 *   stops it; a warning stops it until the operator chose Send anyway
 *   (`acknowledgeWarnings`). tenant-api checks again when the send starts.
 * Every write is audited with ids only.
 */
export async function submitCampaign(input: {
	request: Request
	organizationId: string
	userId: string
	fetchTenant: FetchTenant
	/** Mints the server-only token a test send needs (see `testSendClientFor`). */
	makeTestFetchTenant: TestSendClientFactory
	formData: FormData
	baseUrl: string
	/** Present when editing a Draft or Scheduled broadcast. */
	existing?: {
		id: string
		retargetOfCampaignId: string | null
		/** The coupon as saved, compared with the posted one. */
		discountOffer: unknown
	}
}): Promise<SubmitResult> {
	const { formData, existing } = input
	const intent = readCampaignIntent(formData.get('intent')) ?? 'send'
	const channel = formData.get('channel') === 'sms' ? 'sms' : 'email'
	const rawAudience = String(formData.get('audience') ?? 'all')
	const audience = (AUDIENCES as readonly string[]).includes(rawAudience)
		? rawAudience
		: 'all'
	if (channel === 'sms' && audience === 'unverified') {
		return {
			kind: 'error',
			error: i18n._(msg`Texts can only go to customers with a verified phone.`),
		}
	}
	// A saved audience (#98): "Send to" is everyone subscribed, or one of them.
	// Empty clears it. Membership is worked out when the send starts.
	const audienceId =
		typeof formData.get('audienceId') === 'string'
			? String(formData.get('audienceId')).trim().slice(0, 100)
			: ''

	const posted = formData.get('discountOffer')
	const unchangedOffer = Boolean(
		existing?.discountOffer &&
		typeof posted === 'string' &&
		posted &&
		safeJson(posted) === JSON.stringify(existing.discountOffer),
	)
	const prepared = await prepareCampaignMessage({
		formData,
		organizationId: input.organizationId,
		userId: input.userId,
		baseUrl: input.baseUrl,
		unchangedOffer,
	})
	if (!prepared.ok) return { kind: 'error', error: prepared.error }
	const { message } = prepared

	if (intent === 'test') {
		const result = await sendTestBroadcast({
			makeFetchTenant: input.makeTestFetchTenant,
			userId: input.userId,
			message,
		})
		if (result.ok) {
			await auditCampaign({
				kind: 'test_sent',
				userId: input.userId,
				organizationId: input.organizationId,
				campaignId: existing?.id,
				channel: message.channel,
				request: input.request,
			})
		}
		return { kind: 'test', result }
	}

	// Sending texts asks for the Text marketing terms first (#194); a draft
	// and email are not affected.
	if (channel === 'sms' && intent !== 'draft') {
		const textTerms = await requireModuleAgreement(
			input.organizationId,
			'text_marketing',
		)
		if (textTerms) {
			return {
				kind: 'error',
				error: i18n._(
					msg`Texts need the Text marketing terms. An owner can accept them in Settings, Legal.`,
				),
			}
		}
	}

	const read = readCampaignSchedule(formData)
	if (!read.ok) return { kind: 'error', error: read.error }
	const { schedule } = read
	const later = intent === 'schedule'
	if (later && !schedule.scheduledAt) {
		return { kind: 'error', error: i18n._(msg`Choose when to send it.`) }
	}

	if (intent !== 'draft') {
		const problems = await runSendChecks({
			organizationId: input.organizationId,
			message,
			audience,
			audienceId: audienceId || null,
			sendAtMs: later ? schedule.scheduledAt!.getTime() : Date.now(),
			fetchTenant: input.fetchTenant,
			retargetOf: existing?.retargetOfCampaignId,
		})
		if (!mayProceed(problems, formData.get('acknowledgeWarnings') === '1')) {
			return { kind: 'problems', problems, blocks: message.blocks }
		}
	}

	const scheduledAt =
		later && schedule.scheduledAt ? schedule.scheduledAt.toISOString() : null
	const shared = {
		name: formData.get('name'),
		audience,
		// null clears a saved audience on an edit; a new broadcast ignores it.
		audienceId: audienceId || null,
		subject: message.subject || null,
		content: message.content,
		contentHtml: message.contentHtml,
		contentBlocks: message.contentBlocks,
		discountOffer: message.discountOffer,
		lateAfterMinutes: schedule.lateAfterMinutes,
	}
	const res = existing
		? await input.fetchTenant(
				`/operator/marketing/campaigns/${encodeURIComponent(existing.id)}`,
				{
					method: 'PATCH',
					body: JSON.stringify({
						...shared,
						// A draft is un-scheduled; a send starts now; a schedule keeps its time.
						scheduledAt: intent === 'schedule' ? scheduledAt : null,
						...(intent === 'send' ? { sendNow: true } : {}),
					}),
				},
			)
		: await input.fetchTenant('/operator/marketing/campaigns', {
				method: 'POST',
				body: JSON.stringify({
					...shared,
					channel: message.channel,
					scheduledAt,
					saveAsDraft: intent === 'draft',
				}),
			})

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: unknown }
		return {
			kind: 'error',
			error: tenantError(body, i18n._(msg`The broadcast could not be saved.`)),
		}
	}
	const saved = (await res.json().catch(() => ({}))) as { campaignId?: string }
	const campaignId = saved.campaignId ?? existing?.id ?? ''

	await auditCampaign({
		kind: existing ? 'updated' : 'created',
		userId: input.userId,
		organizationId: input.organizationId,
		campaignId,
		channel: message.channel,
		request: input.request,
	})
	if (intent !== 'draft') {
		await auditCampaign({
			kind: 'sent',
			userId: input.userId,
			organizationId: input.organizationId,
			campaignId,
			channel: message.channel,
			request: input.request,
		})
	}
	return { kind: 'saved', campaignId, intent }
}

function safeJson(value: string) {
	try {
		return JSON.stringify(JSON.parse(value))
	} catch {
		return null
	}
}
