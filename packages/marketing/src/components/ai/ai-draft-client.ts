import { type EmailBlock } from '@repo/common/email-blocks'
import { type AiDraftConfig } from './ai-draft-config.tsx'

export type AiDraftResult =
	| { channel: 'email'; subjects: string[]; blocks: EmailBlock[] }
	| { channel: 'sms'; message: string }

export type AiDraftErrorCode =
	| 'ai_draft_invalid'
	| 'ai_draft_limit'
	| 'ai_not_configured'
	| 'not_found'
	| 'ai_draft_failed'

export type AiDraftOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; error: AiDraftErrorCode }

async function post<T>(
	config: AiDraftConfig,
	body: Record<string, unknown>,
	pick: (json: unknown) => T | null,
): Promise<AiDraftOutcome<T>> {
	try {
		const response = await fetch(config.endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ orgSlug: config.orgSlug, ...body }),
		})
		const json = (await response.json().catch(() => null)) as unknown
		if (response.ok) {
			const value = pick(json)
			return value === null
				? { ok: false, error: 'ai_draft_invalid' }
				: { ok: true, value }
		}
		const code = (json as { error?: string } | null)?.error
		const known: AiDraftErrorCode[] = [
			'ai_draft_invalid',
			'ai_draft_limit',
			'ai_not_configured',
			'not_found',
		]
		return {
			ok: false,
			error: known.includes(code as AiDraftErrorCode)
				? (code as AiDraftErrorCode)
				: 'ai_draft_failed',
		}
	} catch {
		return { ok: false, error: 'ai_draft_failed' }
	}
}

export type AiDraftInput = {
	channel: 'email' | 'sms'
	goal: string
	tone: 'friendly' | 'formal' | 'playful' | 'urgent'
	language: 'en' | 'ar'
	itemIds: string[]
}

export function requestAiDraft(config: AiDraftConfig, input: AiDraftInput) {
	return post<AiDraftResult>(
		config,
		{
			action: 'draft',
			...input,
			...(config.offer ? { offer: config.offer } : {}),
			...(config.bestSellers?.length ? { bestSellers: config.bestSellers } : {}),
		},
		(json) => {
			const draft = (json as { draft?: AiDraftResult } | null)?.draft
			return draft && (draft.channel === 'email' || draft.channel === 'sms')
				? draft
				: null
		},
	)
}

export type RewriteInstruction = 'shorter' | 'warmer' | 'arabic' | 'english'

export function requestAiRewrite(
	config: AiDraftConfig,
	input: { text: string; instruction: RewriteInstruction; sms?: boolean },
) {
	return post<string>(
		config,
		{
			action: 'rewrite',
			language: config.defaultLanguage,
			...input,
			...(config.offer ? { offer: config.offer } : {}),
		},
		(json) => {
			const text = (json as { text?: unknown } | null)?.text
			return typeof text === 'string' && text.length > 0 ? text : null
		},
	)
}
