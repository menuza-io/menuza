import {
	defaultFlowFor,
	FlowGraphSchema,
	type FlowGraph,
	type FlowValidationIssue,
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
	getDraftFlow,
	getPublishedFlow,
	listPublishedFlowVersions,
	publishFlow,
	saveDraftFlow,
} from '#app/utils/phone-agent/phone-agent.server.ts'
import { recordFlowPublished } from '#app/utils/phone-agent/settings-history.server.ts'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'

export type FlowActionResult =
	| { ok: true; intent: 'save' }
	| { ok: true; intent: 'publish'; version: number }
	| { ok: true; intent: 'reset'; graph: FlowGraph }
	| {
			ok: false
			intent: 'save' | 'publish' | 'reset' | 'unknown'
			error: string
			issues?: FlowValidationIssue[]
	  }

const FlowActionSchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('save'), graph: FlowGraphSchema }),
	z.object({ intent: z.literal('publish'), graph: FlowGraphSchema }),
	z.object({ intent: z.literal('reset') }),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { orgId } = await requirePhoneAgentAccess(request, params.orgSlug)
	// Sequential on purpose: both helpers lazily create rows on first access.
	const draft = await getDraftFlow(orgId)
	const published = await getPublishedFlow(orgId)
	const [versions, canUpdate] = await Promise.all([
		listPublishedFlowVersions(orgId),
		canUpdatePhoneAgent(request, orgId),
	])

	return {
		draftGraph: draft.graph,
		published: published
			? { version: published.version, publishedAt: published.publishedAt }
			: null,
		versions,
		canUpdate,
		draftDiffersFromPublished: published
			? JSON.stringify(draft.graph) !== JSON.stringify(published.graph)
			: true,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { orgId, userId } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
	)

	const body: unknown = await request.json().catch(() => null)
	const parsed = FlowActionSchema.safeParse(body)
	if (!parsed.success) {
		const intent =
			body && typeof body === 'object' && 'intent' in body
				? String((body as { intent: unknown }).intent)
				: 'unknown'
		return data<FlowActionResult>(
			{
				ok: false,
				intent:
					intent === 'save' || intent === 'publish' || intent === 'reset'
						? intent
						: 'unknown',
				error: parsed.error.issues[0]?.message ?? 'Invalid request',
			},
			{ status: 400 },
		)
	}

	const input = parsed.data
	switch (input.intent) {
		case 'save': {
			await saveDraftFlow(orgId, input.graph, userId)
			return data<FlowActionResult>({ ok: true, intent: 'save' })
		}
		case 'publish': {
			const result = await publishFlow(orgId, input.graph, userId)
			if (!result.ok) {
				return data<FlowActionResult>(
					{
						ok: false,
						intent: 'publish',
						error: 'Fix the issues in the flow before publishing.',
						issues: result.issues,
					},
					{ status: 400 },
				)
			}
			await recordFlowPublished({
				organizationId: orgId,
				userId,
				request,
				versionId: result.id,
				version: result.version,
			})
			return data<FlowActionResult>({
				ok: true,
				intent: 'publish',
				version: result.version,
			})
		}
		case 'reset': {
			const published = await getPublishedFlow(orgId)
			const graph = published?.graph ?? defaultFlowFor(phoneAgentVertical)
			await saveDraftFlow(orgId, graph, userId)
			return data<FlowActionResult>({ ok: true, intent: 'reset', graph })
		}
	}
}
