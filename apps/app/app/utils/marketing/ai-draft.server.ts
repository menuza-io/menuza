import { z } from 'zod'
import {
	buildAiDraftPrompt,
	type AiDraftContext,
	type AiDraftLanguage,
	type AiDraftRequest,
	SMS_BODY_LIMIT,
} from './ai-draft-context.ts'
import {
	AiDraftError,
	emailDraftOutputSchema,
	rewriteOutputSchema,
	sanitizeText,
	smsDraftOutputSchema,
	toEmailBlocks,
	toSmsMessage,
	toSubjects,
} from './ai-draft-sanitize.ts'

/**
 * The orchestration of one AI draft (#155). The model call is injected, so
 * tests never reach a model; the real one is `generateObject` from `@repo/ai`.
 * Context in, validated and sanitised draft out. Nothing here reads a guest.
 */

export type DraftGenerator = (args: {
	system: string
	prompt: string
	schema: z.ZodType
}) => Promise<unknown>

export type EmailDraft = {
	channel: 'email'
	subjects: string[]
	blocks: ReturnType<typeof toEmailBlocks>
}
export type SmsDraft = { channel: 'sms'; message: string }
export type AiDraft = EmailDraft | SmsDraft

function parseOutput<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value)
	if (!parsed.success) throw new AiDraftError('ai_draft_invalid')
	return parsed.data
}

export async function createAiDraft(input: {
	context: AiDraftContext
	request: AiDraftRequest
	generate: DraftGenerator
}): Promise<AiDraft> {
	const { context, request } = input
	const { system, prompt } = buildAiDraftPrompt(context, request)
	if (request.channel === 'sms') {
		const out = parseOutput(
			smsDraftOutputSchema,
			await input.generate({ system, prompt, schema: smsDraftOutputSchema }),
		)
		return { channel: 'sms', message: toSmsMessage(out.message, context) }
	}
	const out = parseOutput(
		emailDraftOutputSchema,
		await input.generate({ system, prompt, schema: emailDraftOutputSchema }),
	)
	return {
		channel: 'email',
		subjects: toSubjects(out.subjects, context),
		blocks: toEmailBlocks(out.blocks, context, request.language),
	}
}

export const REWRITE_INSTRUCTIONS = [
	'shorter',
	'warmer',
	'arabic',
	'english',
] as const
export type RewriteInstruction = (typeof REWRITE_INSTRUCTIONS)[number]

const INSTRUCTION_TEXT: Record<RewriteInstruction, string> = {
	shorter: 'Make it shorter. Keep the meaning and the tone.',
	warmer: 'Make it warmer and friendlier. Keep the meaning.',
	arabic: 'Translate it into Arabic.',
	english: 'Translate it into English.',
}

/** Rewrites one block's text. Same clean-up as a draft; merge tags are kept as written. */
export async function rewriteText(input: {
	context: AiDraftContext
	text: string
	instruction: RewriteInstruction
	/** Rewrites a text message: it must still fit with the opt-out footer. */
	sms?: boolean
	generate: DraftGenerator
}): Promise<string> {
	const system = [
		'You edit marketing text for a restaurant. You never invent facts.',
		INSTRUCTION_TEXT[input.instruction],
		'Keep any {{merge tag}} exactly as written. Do not add prices, discounts, percentages or links.',
	].join('\n')
	const prompt = `Restaurant: ${input.context.organization.name}\n\nText:\n${input.text}`
	const out = parseOutput(
		rewriteOutputSchema,
		await input.generate({ system, prompt, schema: rewriteOutputSchema }),
	)
	const clean = sanitizeText(out.text, input.context)
	if (!clean) throw new AiDraftError('ai_draft_invalid')
	return input.sms ? toSmsMessage(clean, input.context) : clean
}

export const AI_DRAFT_LANGUAGE_OPTIONS: readonly AiDraftLanguage[] = ['en', 'ar']
export { SMS_BODY_LIMIT }
