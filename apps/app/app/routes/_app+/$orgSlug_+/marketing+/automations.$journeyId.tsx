import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { renderMarketingEmail } from '@repo/marketing/server/email-render'
import {
	WorkflowCanvas,
	type WorkflowGraph,
	type JourneyStatus,
} from '@repo/marketing-workflow'
import {
	useLoaderData,
	useNavigate,
	useFetcher,
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
	redirect,
} from 'react-router'
import { toast } from 'sonner'
import {
	useAIPanel,
	useAIPanelHotkey,
} from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIToggle } from '#app/components/ai/global-ai-panel.tsx'
import {
	resolveEmailBrandingForOrg,
	type OrganizationEmailBranding,
} from '#app/utils/email-branding.server.ts'
import { useMinWidthMediaQuery } from '#app/utils/navigation-guards.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/** Render every designed email node so the send path never needs React. */
async function withRenderedEmails(
	nodes: unknown[],
	branding: OrganizationEmailBranding,
): Promise<unknown[]> {
	return Promise.all(
		nodes.map(async (node) => {
			if (!node || typeof node !== 'object') return node
			const record = node as { type?: string; data?: Record<string, unknown> }
			if (record.type !== 'action_email' || !record.data) return node
			if (!Array.isArray(record.data.blocks)) return node
			const blocks = record.data.blocks
			if (blocks.length === 0) {
				return {
					...record,
					data: {
						...record.data,
						emailFormat: 'designed',
						bodyHtml: '',
						bodyText: '',
					},
				}
			}

			const rendered = await renderMarketingEmail({
				blocks,
				theme: branding,
				socials: branding.socials,
				subject:
					typeof record.data.subject === 'string' ? record.data.subject : '',
			})

			return {
				...record,
				data: {
					...record.data,
					emailFormat: 'designed',
					bodyHtml: rendered.html,
					bodyText: rendered.text,
				},
			}
		}),
	)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const journeyId = params.journeyId || ''
	const { fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	const res = await fetchTenant(`/operator/journeys/${journeyId}`)
	if (!res.ok) {
		throw new Response(i18n._(t`Automation not found`), { status: 404 })
	}

	const data = (await res.json()) as any
	const journey = data.journey

	const nodes = Array.isArray(journey.nodes) ? journey.nodes : []
	const edges = Array.isArray(journey.edges) ? journey.edges : []

	return {
		orgSlug,
		journey: {
			id: String(journey.id),
			name: String(journey.name),
			description: journey.description ? String(journey.description) : null,
			status: (journey.status || 'draft') as JourneyStatus,
			triggerType: String(journey.triggerType || 'phone_verified'),
			graphJson: journey.graphJson ? String(journey.graphJson) : undefined,
			nodes,
			edges,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const journeyId = params.journeyId || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'email_preview') {
		const branding = await resolveEmailBrandingForOrg(orgId)
		const { html } = await renderMarketingEmail({
			blocks: formData.get('blocks'),
			theme: branding,
			socials: branding.socials,
			subject: String(formData.get('subject') || ''),
		})
		return { html }
	}

	if (intent === 'save' || intent === 'publish') {
		const name = formData.get('name')
		const graphJson = formData.get('graphJson')

		if (typeof graphJson !== 'string') {
			return { error: i18n._(t`Graph data missing`) }
		}

		let parsedGraph: WorkflowGraph
		try {
			parsedGraph = JSON.parse(graphJson) as WorkflowGraph
		} catch {
			return { error: i18n._(t`Invalid graph format`) }
		}

		const branding = await resolveEmailBrandingForOrg(orgId)
		const renderedGraph: WorkflowGraph = {
			...parsedGraph,
			nodes: (await withRenderedEmails(
				parsedGraph.nodes,
				branding,
			)) as WorkflowGraph['nodes'],
		}

		const triggerNode = renderedGraph.nodes.find((n) => n.type === 'trigger')
		const triggerType =
			(triggerNode?.data as any)?.triggerType || 'phone_verified'
		const triggerConfig =
			((triggerNode?.data as any)?.config as Record<string, unknown>) || {}
		const serializedGraph = JSON.stringify(renderedGraph)

		const updateRes = await fetchTenant(`/operator/journeys/${journeyId}`, {
			method: 'PUT',
			body: JSON.stringify({
				name: name ? String(name) : undefined,
				triggerType,
				triggerConfig,
				nodes: renderedGraph.nodes,
				edges: renderedGraph.edges,
				graphJson: serializedGraph,
			}),
		})

		if (!updateRes.ok) {
			const err = await updateRes.json().catch(() => ({}))
			return {
				error: (err as any).error || i18n._(t`Failed to save automation`),
			}
		}

		if (intent === 'publish') {
			const publishRes = await fetchTenant(
				`/operator/journeys/${journeyId}/publish`,
				{ method: 'POST' },
			)

			if (!publishRes.ok) {
				const err = await publishRes.json().catch(() => ({}))
				return {
					error: (err as any).error || i18n._(t`Failed to publish automation`),
				}
			}

			return {
				success: true,
				message: i18n._(t`Automation published and activated!`),
			}
		}

		return { success: true, message: i18n._(t`Automation saved successfully`) }
	}

	if (intent === 'pause') {
		const pauseRes = await fetchTenant(
			`/operator/journeys/${journeyId}/pause`,
			{
				method: 'POST',
			},
		)

		if (!pauseRes.ok) {
			const err = await pauseRes.json().catch(() => ({}))
			return {
				error: (err as any).error || i18n._(t`Failed to pause automation`),
			}
		}

		return { success: true, message: i18n._(t`Automation paused`) }
	}

	if (intent === 'delete') {
		const deleteRes = await fetchTenant(`/operator/journeys/${journeyId}`, {
			method: 'DELETE',
		})

		if (!deleteRes.ok) {
			const err = await deleteRes.json().catch(() => ({}))
			return {
				error: (err as any).error || i18n._(t`Failed to delete automation`),
			}
		}

		return redirect(`/${orgSlug}/marketing/automations`)
	}

	if (intent === 'test_run') {
		const customerId = formData.get('customerId')
		if (typeof customerId !== 'string' || !customerId) {
			return { error: i18n._(t`customerId is required`) }
		}

		const testRes = await fetchTenant('/operator/journeys/trigger-test', {
			method: 'POST',
			body: JSON.stringify({
				journeyId,
				customerId,
			}),
		})

		if (!testRes.ok) {
			const err = await testRes.json().catch(() => ({}))
			return {
				error:
					(err as any).error || i18n._(t`Failed to trigger test automation`),
			}
		}

		const data = (await testRes.json()) as any
		const runId = data.runId || 'initiated'
		return {
			success: true,
			message: i18n._(t`Test run triggered successfully (Run ID: ${runId})`),
			runId: data.runId,
		}
	}

	return { error: i18n._(t`Unknown intent`) }
}

export default function JourneyBuilderRoute() {
	const { _ } = useLingui()
	const { orgSlug, journey } = useLoaderData<typeof loader>()
	const navigate = useNavigate()
	const fetcher = useFetcher()

	useAIPanelHotkey()
	const { isOpen: isAIPanelOpen, isExpanded: isAIPanelExpanded } = useAIPanel()
	const isLg = useMinWidthMediaQuery(1024)

	const isSubmitting = fetcher.state !== 'idle'

	// Initial graph from DB or raw json
	const initialGraph = journey.graphJson
		? journey.graphJson
		: {
				nodes: journey.nodes,
				edges: journey.edges,
			}

	const handleSave = (graph: WorkflowGraph, name: string) => {
		void fetcher.submit(
			{
				intent: 'save',
				name,
				graphJson: JSON.stringify(graph),
			},
			{ method: 'POST' },
		)
		toast.success(_(msg`Saving automation draft...`))
	}

	const handlePublish = (graph: WorkflowGraph, name: string) => {
		void fetcher.submit(
			{
				intent: 'publish',
				name,
				graphJson: JSON.stringify(graph),
			},
			{ method: 'POST' },
		)
		toast.success(_(msg`Publishing and activating automation...`))
	}

	const handlePause = () => {
		void fetcher.submit(
			{
				intent: 'pause',
			},
			{ method: 'POST' },
		)
		toast.info(_(msg`Pausing automation...`))
	}

	const handleTestRun = (customerId: string) => {
		void fetcher.submit(
			{
				intent: 'test_run',
				customerId,
			},
			{ method: 'POST' },
		)
		toast.info(_(msg`Triggering test run for customer "${customerId}"...`))
	}

	return (
		<div className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
			<WorkflowCanvas
				initialGraph={initialGraph}
				journeyName={journey.name}
				journeyStatus={journey.status}
				headerExtras={<GlobalAIToggle />}
				onSave={handleSave}
				onPublish={handlePublish}
				onPause={handlePause}
				onTestRun={handleTestRun}
				onBack={() => navigate(`/${orgSlug}/marketing/automations`)}
				onViewRuns={() =>
					navigate(`/${orgSlug}/marketing/automations/${journey.id}/runs`)
				}
				reserveAiPanelWidth={isAIPanelOpen && !isAIPanelExpanded && isLg}
				isSaving={isSubmitting}
				isPublishing={isSubmitting}
			/>
		</div>
	)
}
