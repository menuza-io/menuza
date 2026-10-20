import {
	TRAINING_RULE_LIMIT_ERROR,
	trainingRuleCategorySchema,
	TrainingRuleInputSchema,
} from '@repo/phone-agent'
import { z } from 'zod'
import {
	deleteTrainingRule,
	saveTrainingRule,
	setTrainingRuleActive,
} from './phone-agent.server.ts'
import { settingsError } from './settings-errors.ts'
import { recordTrainingChange } from './settings-history.server.ts'
import { canAddTrainingRule } from './training-rules.server.ts'
import { phoneAgentVertical } from './vertical.ts'

export type TrainingActionResult =
	| { ok: true }
	| { ok: false; error?: string; fieldErrors?: Record<string, string> }

const RuleId = z.string().min(1).max(64)

const intentSchema = z.discriminatedUnion('intent', [
	TrainingRuleInputSchema.extend({
		intent: z.literal('save-rule'),
		id: RuleId.optional(),
		category: trainingRuleCategorySchema(phoneAgentVertical),
	}),
	z.object({
		intent: z.literal('toggle-rule'),
		id: RuleId,
		isActive: z.boolean(),
	}),
	z.object({ intent: z.literal('delete-rule'), id: RuleId }),
])

const TRAINING_INTENTS = new Set(['save-rule', 'toggle-rule', 'delete-rule'])

/** Whether a JSON body posted to a settings page is a training rule change. */
export function isTrainingIntent(body: unknown) {
	return (
		Boolean(body) &&
		typeof body === 'object' &&
		TRAINING_INTENTS.has(String((body as { intent?: unknown }).intent))
	)
}

/** Saves, turns on or off, or deletes a training rule. */
export async function handleTrainingAction(input: {
	organizationId: string
	userId: string
	request: Request
	body: unknown
}): Promise<TrainingActionResult> {
	const { organizationId: orgId } = input
	const history = {
		organizationId: orgId,
		userId: input.userId,
		request: input.request,
	}
	const parsed = intentSchema.safeParse(input.body)
	if (!parsed.success) {
		const fieldErrors: Record<string, string> = {}
		for (const issue of parsed.error.issues) {
			const key = issue.path.join('.')
			if (key && !fieldErrors[key]) fieldErrors[key] = issue.message
		}
		return { ok: false, error: 'Check the highlighted fields.', fieldErrors }
	}
	const body = parsed.data

	if (body.intent === 'toggle-rule') {
		const updated = await setTrainingRuleActive(orgId, body.id, body.isActive)
		if (!updated) return { ok: false, error: settingsError('conflict') }
		await recordTrainingChange({
			...history,
			change: body.isActive ? 'activated' : 'deactivated',
			ruleId: body.id,
		})
		return { ok: true }
	}
	if (body.intent === 'delete-rule') {
		const deleted = await deleteTrainingRule(orgId, body.id)
		if (!deleted) return { ok: false, error: settingsError('conflict') }
		await recordTrainingChange({
			...history,
			change: 'deleted',
			ruleId: body.id,
		})
		return { ok: true }
	}

	const { intent: ignoredIntent, id, ...rule } = body
	if (!id && !(await canAddTrainingRule(orgId))) {
		return { ok: false, error: TRAINING_RULE_LIMIT_ERROR }
	}
	const result = await saveTrainingRule(orgId, rule, id)
	if (!result.ok) return { ok: false, error: result.error }
	await recordTrainingChange({
		...history,
		change: 'saved',
		ruleId: result.id,
		title: rule.title,
	})
	return { ok: true }
}
