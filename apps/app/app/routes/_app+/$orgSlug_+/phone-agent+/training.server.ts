import {
	TRAINING_RULE_LIMIT_ERROR,
	trainingRuleCategorySchema,
	TrainingRuleInputSchema,
} from '@repo/phone-agent'
import {
	data,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	canUpdatePhoneAgent,
	requirePhoneAgentAccess,
} from '#app/utils/phone-agent/access.server.ts'
import {
	deleteTrainingRule,
	getPhoneAgent,
	listTrainingRules,
	saveTrainingRule,
	setTrainingRuleActive,
} from '#app/utils/phone-agent/phone-agent.server.ts'
import { recordTrainingChange } from '#app/utils/phone-agent/settings-history.server.ts'
import { canAddTrainingRule } from '#app/utils/phone-agent/training-rules.server.ts'
import { phoneAgentServerVertical } from '#app/utils/phone-agent/vertical.server.ts'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'

export type TrainingActionResult =
	| { ok: true }
	| { ok: false; error?: string; fieldErrors?: Record<string, string> }

const RuleId = z.string().min(1).max(64)

const intentSchema = z.discriminatedUnion('intent', [
	TrainingRuleInputSchema.extend({
		intent: z.literal('save'),
		id: RuleId.optional(),
		category: trainingRuleCategorySchema(phoneAgentVertical),
	}),
	z.object({ intent: z.literal('toggle'), id: RuleId, isActive: z.boolean() }),
	z.object({ intent: z.literal('delete'), id: RuleId }),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { orgId } = await requirePhoneAgentAccess(request, params.orgSlug)
	const [agent, rules, scopes, canUpdate] = await Promise.all([
		getPhoneAgent(orgId),
		listTrainingRules(orgId),
		phoneAgentServerVertical.listScopes(orgId),
		canUpdatePhoneAgent(request, orgId),
	])
	return data(
		{
			rules,
			scopes: scopes.map(({ id, name }) => ({ id, name })),
			canUpdate,
			verticalSettings: agent.settings.vertical,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function action({
	request,
	params,
}: ActionFunctionArgs): Promise<TrainingActionResult> {
	const { orgId, userId } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
	)
	const history = { organizationId: orgId, userId, request }
	const body: unknown = await request.json().catch(() => null)
	const parsed = intentSchema.safeParse(body)
	if (!parsed.success) {
		const fieldErrors: Record<string, string> = {}
		for (const issue of parsed.error.issues) {
			const key = issue.path.join('.')
			if (key && !fieldErrors[key]) fieldErrors[key] = issue.message
		}
		return { ok: false, error: 'Check the highlighted fields.', fieldErrors }
	}
	const input = parsed.data

	if (input.intent === 'toggle') {
		await setTrainingRuleActive(orgId, input.id, input.isActive)
		await recordTrainingChange({
			...history,
			change: input.isActive ? 'activated' : 'deactivated',
			ruleId: input.id,
		})
		return { ok: true }
	}
	if (input.intent === 'delete') {
		await deleteTrainingRule(orgId, input.id)
		await recordTrainingChange({
			...history,
			change: 'deleted',
			ruleId: input.id,
		})
		return { ok: true }
	}

	const { intent: ignoredIntent, id, ...rule } = input
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
