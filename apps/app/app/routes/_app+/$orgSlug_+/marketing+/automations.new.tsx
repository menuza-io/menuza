import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { renderMarketingEmail } from '@repo/marketing/server/email-render'
import {
	WorkflowCanvas,
	createDefaultJourneyGraph,
	type WorkflowGraph,
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
import { resolveEmailBrandingForOrg } from '#app/utils/email-branding.server.ts'
import { useMinWidthMediaQuery } from '#app/utils/navigation-guards.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

async function withRenderedEmails(
	nodes: WorkflowGraph['nodes'],
	branding: Awaited<ReturnType<typeof resolveEmailBrandingForOrg>>,
) {
	return Promise.all(
		nodes.map(async (node) => {
			if (node.type !== 'action_email' || !Array.isArray(node.data.blocks)) {
				return node
			}
			if (node.data.blocks.length === 0) {
				return {
					...node,
					data: {
						...node.data,
						emailFormat: 'designed' as const,
						bodyHtml: '',
						bodyText: '',
					},
				}
			}
			const rendered = await renderMarketingEmail({
				blocks: node.data.blocks,
				theme: branding,
				socials: branding.socials,
				subject: node.data.subject,
			})
			return {
				...node,
				data: {
					...node.data,
					emailFormat: 'designed' as const,
					bodyHtml: rendered.html,
					bodyText: rendered.text,
				},
			}
		}),
	)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	await getOperatorTenantClient(request, orgSlug)
	return { orgSlug }
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	const formData = await request.formData()
	const intent = formData.get('intent')

	// The email designer on this route renders its preview through the route
	// action, so it must handle the preview intent before the journey create.
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

	const name = formData.get('name') || i18n._(t`New Customer Journey`)
	const graphJson = formData.get('graphJson')
	const shouldPublish = formData.get('publish') === 'true'

	if (typeof graphJson !== 'string' || !graphJson) {
		return { error: i18n._(t`Graph data is required`) }
	}

	let parsedGraph: WorkflowGraph
	try {
		parsedGraph = JSON.parse(graphJson) as WorkflowGraph
	} catch {
		return { error: i18n._(t`Invalid graph format`) }
	}

	const triggerNode = parsedGraph.nodes.find((n: any) => n.type === 'trigger')
	const triggerType =
		(triggerNode?.data as any)?.triggerType || 'phone_verified'
	const triggerConfig =
		((triggerNode?.data as any)?.config as Record<string, unknown>) || {}
	const branding = await resolveEmailBrandingForOrg(orgId)
	const nodes = await withRenderedEmails(parsedGraph.nodes, branding)
	const resolvedGraph = { ...parsedGraph, nodes }

	// Create journey in tenant-api
	const createRes = await fetchTenant('/operator/journeys', {
		method: 'POST',
		body: JSON.stringify({
			name: String(name),
			description: i18n._(
				t`Automated lifecycle journey created via visual builder.`,
			),
			triggerType,
			triggerConfig,
			nodes,
			edges: parsedGraph.edges,
			graphJson: JSON.stringify(resolvedGraph),
		}),
	})

	if (!createRes.ok) {
		const err = await createRes.json().catch(() => ({}))
		return {
			error: (err as any).error || i18n._(t`Failed to create journey`),
		}
	}

	const created = (await createRes.json()) as any
	const journeyId = created.journey?.id

	if (shouldPublish && journeyId) {
		await fetchTenant(`/operator/journeys/${journeyId}/publish`, {
			method: 'POST',
		})
	}

	return redirect(`/${orgSlug}/marketing/automations/${journeyId}`)
}

export default function NewJourneyRoute() {
	const { _ } = useLingui()
	const { orgSlug } = useLoaderData<typeof loader>()
	const navigate = useNavigate()
	const fetcher = useFetcher()

	useAIPanelHotkey()
	const { isOpen: isAIPanelOpen, isExpanded: isAIPanelExpanded } = useAIPanel()
	const isLg = useMinWidthMediaQuery(1024)

	const isSubmitting = fetcher.state !== 'idle'
	const initialGraph = createDefaultJourneyGraph()

	const handleSave = (graph: WorkflowGraph, name: string) => {
		void fetcher.submit(
			{
				name,
				graphJson: JSON.stringify(graph),
				publish: 'false',
			},
			{ method: 'POST' },
		)
		toast.success(_(msg`Saving new journey draft...`))
	}

	const handlePublish = (graph: WorkflowGraph, name: string) => {
		void fetcher.submit(
			{
				name,
				graphJson: JSON.stringify(graph),
				publish: 'true',
			},
			{ method: 'POST' },
		)
		toast.success(_(msg`Publishing new journey...`))
	}

	return (
		<div className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
			<WorkflowCanvas
				initialGraph={initialGraph}
				journeyName={_(msg`New Customer Journey`)}
				journeyStatus="draft"
				headerExtras={<GlobalAIToggle />}
				onSave={handleSave}
				onPublish={handlePublish}
				onTestRun={() => {
					toast.info(
						_(msg`Save the journey first before running test triggers.`),
					)
				}}
				onBack={() => navigate(`/${orgSlug}/marketing/automations`)}
				reserveAiPanelWidth={isAIPanelOpen && !isAIPanelExpanded && isLg}
				isSaving={isSubmitting}
				isPublishing={isSubmitting}
			/>
		</div>
	)
}
