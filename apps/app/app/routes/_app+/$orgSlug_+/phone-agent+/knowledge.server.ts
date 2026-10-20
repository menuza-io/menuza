import { FAQ_QUESTION_MAX } from '@repo/phone-agent'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { requirePhoneAgentAccess } from '#app/utils/phone-agent/access.server.ts'
import { generateFaqDrafts } from '#app/utils/phone-agent/faq-generate.server.ts'
import { listTrainingRules } from '#app/utils/phone-agent/phone-agent.server.ts'
import { buildRuntimeConfig } from '#app/utils/phone-agent/runtime-config.server.ts'
import { settingsError } from '#app/utils/phone-agent/settings-errors.ts'
import {
	loadSettingsPage,
	saveSettingsPage,
	settingsPageData,
} from '#app/utils/phone-agent/settings-page.server.ts'
import {
	handleTrainingAction,
	isTrainingIntent,
} from '#app/utils/phone-agent/training-actions.server.ts'
import { phoneAgentServerVertical } from '#app/utils/phone-agent/vertical.server.ts'

export type KnowledgeActionResult =
	| { ok: true; drafts?: Array<{ id: string; answer: string }> }
	| { ok: false; error?: string; fieldErrors?: Record<string, string> }

const draftSchema = z.object({
	intent: z.literal('draft-faq'),
	scopeId: z.string().min(1).max(64).nullable(),
	questions: z
		.array(
			z.object({
				id: z.string().regex(/^[a-z0-9_]{1,60}$/u),
				question: z.string().trim().min(1).max(FAQ_QUESTION_MAX),
			}),
		)
		.min(1)
		.max(60),
})

async function verticalPageData(orgId: string, scopeId: string | null) {
	const pageData = phoneAgentServerVertical.advancedPageData
	if (!pageData) return null
	const config = await buildRuntimeConfig({
		kind: 'test',
		orgId,
		scopeId,
		flow: 'published',
	})
	return pageData(config.ok ? config.config : null) ?? null
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const page = await loadSettingsPage(request, params.orgSlug)
	const scopes = await phoneAgentServerVertical.listScopes(page.orgId)
	const [rules, verticalData] = await Promise.all([
		listTrainingRules(page.orgId),
		verticalPageData(page.orgId, scopes[0]?.id ?? null),
	])
	return settingsPageData({
		faq: page.settings.faq,
		pronunciations: page.settings.pronunciations,
		keyterms: page.settings.keyterms,
		business: page.settings.business,
		vertical: page.settings.vertical,
		providesBusinessProfile: phoneAgentServerVertical.providesBusinessProfile,
		verticalData,
		rules,
		scopes: scopes.map(({ id, name }) => ({ id, name })),
		versions: page.versions,
		canUpdate: page.canUpdate,
	})
}

export async function action({
	request,
	params,
}: ActionFunctionArgs): Promise<KnowledgeActionResult> {
	const body: unknown = await request.json().catch(() => null)
	if (isTrainingIntent(body)) {
		const { orgId, userId } = await requirePhoneAgentAccess(
			request,
			params.orgSlug,
			ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
		)
		return handleTrainingAction({
			organizationId: orgId,
			userId,
			request,
			body,
		})
	}
	const draft = draftSchema.safeParse(body)
	if (draft.success) {
		const { orgId, userId } = await requirePhoneAgentAccess(
			request,
			params.orgSlug,
			ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
		)
		const scopes = await phoneAgentServerVertical.listScopes(orgId)
		const { scopeId } = draft.data
		// Verticals with scopes draft from one scope's facts; others have none.
		if (
			scopes.length
				? !scopes.some((scope) => scope.id === scopeId)
				: scopeId !== null
		) {
			return { ok: false, error: settingsError('choose_scope') }
		}
		return generateFaqDrafts({
			organizationId: orgId,
			userId,
			scopeId,
			questions: draft.data.questions,
		})
	}
	const result = await saveSettingsPage(request, params.orgSlug, body)
	return result.ok ? { ok: true } : result
}
