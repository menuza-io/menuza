import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import { parseMarketingOffer } from '@repo/discounts'
import {
	WorkflowCanvas,
	createDefaultJourneyGraph,
	type WorkflowGraph,
} from '@repo/marketing-workflow'
import {
	isLoyaltyJourneyTrigger,
	isReservationJourneyTrigger,
} from '@repo/tenant-db/types/journey'
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
	handleMenuItemIntent,
	previewEmail,
} from '#app/utils/email/designer.server.ts'
import { renderJourneyEmailNodes } from '#app/utils/email/journey-render.server.ts'
import { resolveEmailBrandingForOrg } from '#app/utils/email-branding.server.ts'
import {
	loyaltyTriggerBlocked,
	loyaltyTriggersEnabled,
} from '#app/utils/marketing/loyalty-triggers.server.ts'
import {
	reservationTriggerBlocked,
	reservationTriggersEnabled,
} from '#app/utils/marketing/reservation-triggers.server.ts'
import { useMinWidthMediaQuery } from '#app/utils/navigation-guards.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId } = await getOperatorTenantClient(request, orgSlug)

	// This route is the automation builder, so it requires write access.
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
	)

	return {
		orgSlug,
		reservationTriggers: await reservationTriggersEnabled(orgId),
		loyaltyTriggers: await loyaltyTriggersEnabled(request, orgId),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(
		request,
		orgSlug,
		{ canUpdate: true },
	)

	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

	// The email designer on this route renders its preview through the route
	// action, so it must handle the preview intent before the journey create.
	const baseUrl = getDomainUrl(request)
	const menuIntent = await handleMenuItemIntent({
		intent,
		formData,
		organizationId: orgId,
		baseUrl,
	})
	if (menuIntent) return menuIntent

	if (intent === 'email_preview') {
		const offerField = formData.get('discountOffer')
		return previewEmail({
			organizationId: orgId,
			blocks: formData.get('blocks'),
			subject: String(formData.get('subject') || ''),
			baseUrl,
			offer: parseMarketingOffer(
				typeof offerField === 'string' && offerField ? offerField : null,
			),
		})
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
	if (
		isReservationJourneyTrigger(triggerType) &&
		reservationTriggerBlocked({
			triggerType,
			enabled: await reservationTriggersEnabled(orgId),
		})
	) {
		return { error: i18n._(t`Turn on Reservations to use this trigger`) }
	}
	if (
		isLoyaltyJourneyTrigger(triggerType) &&
		loyaltyTriggerBlocked({
			triggerType,
			enabled: await loyaltyTriggersEnabled(request, orgId),
		})
	) {
		return { error: i18n._(t`Turn on Loyalty to use this trigger`) }
	}
	const branding = await resolveEmailBrandingForOrg(orgId)
	const rendered = await renderJourneyEmailNodes(
		orgId,
		parsedGraph.nodes as Array<Record<string, unknown>>,
		branding,
		baseUrl,
	)
	if (!rendered.ok) {
		return {
			error: i18n._(
				t`A dish in your email is no longer on the live menu. Remove it or choose another one.`,
			),
		}
	}
	const nodes = rendered.nodes as WorkflowGraph['nodes']
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
	const { orgSlug, reservationTriggers, loyaltyTriggers } =
		useLoaderData<typeof loader>()
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
				emailMenuItems
				emailTemplatesEndpoint={`/${orgSlug}/marketing/templates/designer`}
				initialGraph={initialGraph}
				journeyName={_(msg`New Customer Journey`)}
				journeyStatus="draft"
				reservationTriggers={reservationTriggers}
				loyaltyTriggers={loyaltyTriggers}
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
