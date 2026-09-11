import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import { renderMarketingEmail } from '@repo/marketing/server/email-render'
import { createPlatformJourney } from '@repo/marketing/server/platform-journeys'
import {
	WorkflowCanvas,
	PLATFORM_WORKFLOW_CONFIG,
	type WorkflowGraph,
} from '@repo/marketing-workflow'
import {
	redirect,
	useFetcher,
	useNavigate,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { toast } from 'sonner'
import { resolvePlatformEmailBranding } from '#app/utils/email-branding.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	return {}
}

export async function action({ request }: ActionFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const formData = await request.formData()
	const intent = formData.get('intent')

	// The email designer on this route renders its preview through the route
	// action, so it must handle the preview intent before the journey create.
	if (intent === 'email_preview') {
		const branding = resolvePlatformEmailBranding()
		const { html } = await renderMarketingEmail({
			blocks: formData.get('blocks'),
			theme: branding,
			subject: String(formData.get('subject') || ''),
		})
		return { html }
	}

	const name = formData.get('name') || i18n._(t`New Platform Automation`)
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

	const triggerNode = parsedGraph.nodes.find((n) => n.type === 'trigger')
	const triggerType =
		(triggerNode?.data as { triggerType?: string })?.triggerType ||
		'org_created'
	const triggerConfig =
		(triggerNode?.data as { config?: Record<string, unknown> })?.config || {}

	const created = await createPlatformJourney({
		name: String(name),
		description: i18n._(t`Platform automation created via visual builder.`),
		triggerType,
		triggerConfig,
		nodes: parsedGraph.nodes,
		edges: parsedGraph.edges,
		graphJson,
	})

	if (!created?.id) {
		return { error: i18n._(t`Failed to create automation`) }
	}

	if (shouldPublish) {
		const { publishPlatformJourney } =
			await import('@repo/marketing/server/platform-journeys')
		try {
			await publishPlatformJourney(created.id)
		} catch (error) {
			return {
				error:
					error instanceof Error
						? error.message
						: i18n._(t`Failed to publish automation`),
			}
		}
	}

	return redirect(`/marketing/automations/${created.id}`)
}

export default function AdminNewAutomationRoute() {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const fetcher = useFetcher()
	const isSubmitting = fetcher.state !== 'idle'
	const initialGraph = PLATFORM_WORKFLOW_CONFIG.defaultGraph()

	const handleSave = (graph: WorkflowGraph, name: string) => {
		void fetcher.submit(
			{ name, graphJson: JSON.stringify(graph), publish: 'false' },
			{ method: 'POST' },
		)
		toast.success(_(msg`Saving new automation draft...`))
	}

	const handlePublish = (graph: WorkflowGraph, name: string) => {
		void fetcher.submit(
			{ name, graphJson: JSON.stringify(graph), publish: 'true' },
			{ method: 'POST' },
		)
		toast.success(_(msg`Publishing new automation...`))
	}

	return (
		<div className="bg-background fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
			<WorkflowCanvas
				workflowConfig={PLATFORM_WORKFLOW_CONFIG}
				initialGraph={initialGraph}
				journeyName={_(msg`New Platform Automation`)}
				journeyStatus="draft"
				onSave={handleSave}
				onPublish={handlePublish}
				onTestRun={() => {
					toast.info(
						_(msg`Save the automation first before running test triggers.`),
					)
				}}
				onBack={() => navigate('/marketing/automations')}
				isSaving={isSubmitting}
				isPublishing={isSubmitting}
			/>
		</div>
	)
}
