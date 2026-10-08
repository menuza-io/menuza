import { generateContent } from '@repo/ai/server'
import { FAQ_ANSWER_MAX, type FaqEntry } from '@repo/phone-agent'
import { z } from 'zod'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import { buildRuntimeConfig } from './runtime-config.server.ts'
import { settingsError } from './settings-errors.ts'
import { phoneAgentServerVertical } from './vertical.server.ts'

export const FAQ_GENERATE_RATE_LIMIT: RateLimitConfig = {
	scope: 'phone-agent-faq-generate',
	maxRequests: process.env.NODE_ENV === 'development' ? 100 : 10,
	windowMs: 60 * 60 * 1000,
}

const MAX_QUESTIONS = 60

/** Long enough for 60 short answers; the owner is waiting on the page. */
export const FAQ_GENERATE_TIMEOUT_MS = 45_000

/**
 * Rejects once `ms` pass. `generateContent` takes no abort signal, so the
 * model call keeps running in the background; we only stop waiting for it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((ignoredResolve, reject) => {
		timer = setTimeout(() => reject(new Error('timed out')), ms)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const DraftsSchema = z.array(
	z.object({
		id: z.string().min(1).max(60),
		answer: z.string().max(FAQ_ANSWER_MAX * 2),
	}),
)

export type FaqDraftResult =
	| { ok: true; drafts: Array<{ id: string; answer: string }> }
	| { ok: false; error: string }

/** Pulls the first JSON array out of a model reply that may use code fences. */
export function parseDraftReply(text: string) {
	const start = text.indexOf('[')
	const end = text.lastIndexOf(']')
	if (start === -1 || end <= start) return []
	try {
		const parsed = DraftsSchema.safeParse(
			JSON.parse(text.slice(start, end + 1)),
		)
		if (!parsed.success) return []
		return parsed.data.map((draft) => ({
			id: draft.id,
			answer: draft.answer.trim().slice(0, FAQ_ANSWER_MAX),
		}))
	} catch {
		return []
	}
}

/**
 * Drafts answers from what the app already knows about the business: the
 * vertical's facts (hours, address, and the like) and training rules. Questions the facts don't cover
 * come back empty so owners never publish a guess.
 */
export async function generateFaqDrafts(input: {
	organizationId: string
	userId: string
	scopeId: string | null
	questions: Array<Pick<FaqEntry, 'id' | 'question'>>
}): Promise<FaqDraftResult> {
	const limit = await checkRateLimit(
		{ type: 'user', value: `${input.userId}:${input.organizationId}` },
		FAQ_GENERATE_RATE_LIMIT,
	)
	if (!limit.allowed) {
		return {
			ok: false,
			error: settingsError('faq_rate_limited'),
		}
	}
	const questions = input.questions.slice(0, MAX_QUESTIONS)
	if (!questions.length) return { ok: true, drafts: [] }

	const config = await buildRuntimeConfig({
		kind: 'test',
		orgId: input.organizationId,
		scopeId: input.scopeId,
		flow: 'published',
	})
	if (!config.ok) return { ok: false, error: config.error }
	const { organization, rules } = config.config
	const facts = phoneAgentServerVertical.faqFacts(config.config, new Date())

	const ruleText = rules
		.filter((rule) => rule.isActive)
		.slice(0, 40)
		.map((rule) => `- ${rule.title}: ${rule.description}`)
		.join('\n')

	const prompt = [
		`You help ${organization.name}, ${facts.businessKind}, prepare answers for its phone assistant.`,
		'Answer each question using ONLY the facts below. Write one or two short, friendly sentences a phone assistant can say out loud.',
		'If the facts do not answer a question, return an empty string for it. Never guess prices, policies, or amenities.',
		...facts.sections
			.filter((section) => section.body.trim())
			.map((section) => `\n${section.heading}:\n${section.body}`),
		ruleText ? `\nOwner instructions:\n${ruleText}` : '',
		'',
		'Questions (JSON):',
		JSON.stringify(questions.map(({ id, question }) => ({ id, question }))),
		'',
		'Reply with only a JSON array like [{"id":"parking","answer":"..."}], one entry per question id.',
	].join('\n')

	let text: string
	try {
		text = await withTimeout(
			generateContent({ prompt }),
			FAQ_GENERATE_TIMEOUT_MS,
		)
	} catch {
		return {
			ok: false,
			error: settingsError('faq_unavailable'),
		}
	}
	const known = new Set(questions.map((question) => question.id))
	const drafts = parseDraftReply(text).filter(
		(draft) => known.has(draft.id) && draft.answer,
	)
	return { ok: true, drafts }
}
