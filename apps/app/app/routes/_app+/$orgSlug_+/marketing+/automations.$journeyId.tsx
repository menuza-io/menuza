import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import { parseMarketingOffer } from '@repo/discounts'
import {
	WorkflowCanvas,
	type WorkflowGraph,
	type JourneyStatus,
} from '@repo/marketing-workflow'
import {
	isLoyaltyJourneyTrigger,
	isReservationJourneyTrigger,
} from '@repo/tenant-db/types/journey'
import { useEffect } from 'react'
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
import { type BreadcrumbHandle } from '#app/utils/breadcrumb.ts'
import { MARKETING_OFFER_ERROR_MESSAGES } from '#app/utils/discounts/marketing-offer-labels.ts'
import {
	checkJourneyOffers,
	loadCouponDiscountOptions,
} from '#app/utils/discounts/marketing-offers.server.ts'
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
import {
	goalFromTriggerConfig,
	loadAutomationTriggerAccess,
	marketingTriggerError,
} from '#app/utils/marketing/automation-triggers.server.ts'
import { loadAudienceOptions } from '#app/utils/marketing/audiences.server.ts'
import { useMinWidthMediaQuery } from '#app/utils/navigation-guards.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { AiDraftProvider } from '@repo/marketing'
import { loadAiDraftConfig } from '#app/utils/marketing/ai-draft-config.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export const handle: BreadcrumbHandle<Awaited<ReturnType<typeof loader>>> = {
	breadcrumb: (data) => data.journey.name,
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const journeyId = params.journeyId || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	// This route is the automation editor, so it requires write access.
	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
	)

	const res = await fetchTenant(`/operator/journeys/${journeyId}`)
	if (!res.ok) {
		throw new Response(i18n._(t`Automation not found`), { status: 404 })
	}

	const data = (await res.json()) as any
	const journey = data.journey

	const nodes = Array.isArray(journey.nodes) ? journey.nodes : []
	const edges = Array.isArray(journey.edges) ? journey.edges : []

	const access = await loadAutomationTriggerAccess(orgId)
	return {
		orgSlug,
		aiDraft: await loadAiDraftConfig(orgId, orgSlug),
		reservationTriggers: await reservationTriggersEnabled(orgId),
		loyaltyTriggers: await loyaltyTriggersEnabled(request, orgId),
		orderTriggers: access.orderTriggers,
		birthdayTriggers: access.birthdayTriggers,
		cartTriggers: access.cartTriggers,
		audienceOptions: access.features.audiences
			? await loadAudienceOptions(fetchTenant)
			: undefined,
		couponOptions: await loadCouponDiscountOptions(userId, orgId),
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

/** The saved nodes, so an unchanged coupon is not re-checked against the editor. */
async function storedJourneyNodes(
	fetchTenant: Awaited<
		ReturnType<typeof getOperatorTenantClient>
	>['fetchTenant'],
	journeyId: string,
): Promise<unknown[]> {
	const res = await fetchTenant(`/operator/journeys/${journeyId}`)
	if (!res.ok) return []
	const data = (await res.json().catch(() => null)) as {
		journey?: { nodes?: unknown }
	} | null
	return Array.isArray(data?.journey?.nodes) ? data.journey.nodes : []
}

async function currentTriggerType(
	fetchTenant: Awaited<
		ReturnType<typeof getOperatorTenantClient>
	>['fetchTenant'],
	journeyId: string,
) {
	const res = await fetchTenant(`/operator/journeys/${journeyId}`)
	if (!res.ok) return null
	const data = (await res.json().catch(() => null)) as {
		journey?: { triggerType?: unknown }
	} | null
	return typeof data?.journey?.triggerType === 'string'
		? data.journey.triggerType
		: null
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const journeyId = params.journeyId || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(
		request,
		orgSlug,
		{ canUpdate: true, canDelete: true },
	)

	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

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
		const renderedNodes = rendered.nodes
		const offers = await checkJourneyOffers({
			userId,
			organizationId: orgId,
			nodes: renderedNodes,
			// Only a step with a coupon needs the saved version to compare with.
			storedNodes: renderedNodes.some(
				(node) =>
					(node as { data?: { discountOffer?: unknown } } | null)?.data
						?.discountOffer,
			)
				? await storedJourneyNodes(fetchTenant, journeyId)
				: [],
		})
		if (!offers.ok) {
			return { error: i18n._(MARKETING_OFFER_ERROR_MESSAGES[offers.error]) }
		}
		const renderedGraph: WorkflowGraph = {
			...parsedGraph,
			nodes: offers.nodes as WorkflowGraph['nodes'],
		}

		const triggerNode = renderedGraph.nodes.find((n) => n.type === 'trigger')
		const triggerType =
			(triggerNode?.data as any)?.triggerType || 'phone_verified'
		const triggerConfig =
			((triggerNode?.data as any)?.config as Record<string, unknown>) || {}
		const serializedGraph = JSON.stringify(renderedGraph)

		const marketingError = marketingTriggerError({
			triggerType,
			features: (await loadAutomationTriggerAccess(orgId)).features,
			currentTriggerType: await currentTriggerType(fetchTenant, journeyId),
		})
		if (marketingError) return { error: marketingError }

		if (isReservationJourneyTrigger(triggerType)) {
			const enabled = await reservationTriggersEnabled(orgId)
			if (
				reservationTriggerBlocked({
					triggerType,
					enabled,
					currentTriggerType: enabled
						? null
						: await currentTriggerType(fetchTenant, journeyId),
				})
			) {
				return { error: i18n._(t`Turn on Reservations to use this trigger`) }
			}
		}
		if (isLoyaltyJourneyTrigger(triggerType)) {
			const enabled = await loyaltyTriggersEnabled(request, orgId)
			if (
				loyaltyTriggerBlocked({
					triggerType,
					enabled,
					currentTriggerType: enabled
						? null
						: await currentTriggerType(fetchTenant, journeyId),
				})
			) {
				return { error: i18n._(t`Turn on Loyalty to use this trigger`) }
			}
		}

		const updateRes = await fetchTenant(`/operator/journeys/${journeyId}`, {
			method: 'PUT',
			body: JSON.stringify({
				name: name ? String(name) : undefined,
				triggerType,
				triggerConfig,
				goal: goalFromTriggerConfig(triggerConfig),
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
	const {
		orgSlug,
		journey,
		reservationTriggers,
		loyaltyTriggers,
		orderTriggers,
		birthdayTriggers,
		cartTriggers,
		audienceOptions,
		couponOptions,
		aiDraft,
	} = useLoaderData<typeof loader>()
	const navigate = useNavigate()
	const fetcher = useFetcher<typeof action>()

	const actionError =
		fetcher.state === 'idle' &&
		fetcher.data &&
		'error' in fetcher.data &&
		typeof fetcher.data.error === 'string'
			? fetcher.data.error
			: null
	useEffect(() => {
		if (actionError) toast.error(actionError)
	}, [actionError, fetcher.data])

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
		<AiDraftProvider config={aiDraft}>
			<div className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
				<WorkflowCanvas
					initialGraph={initialGraph}
					journeyName={journey.name}
					journeyStatus={journey.status}
					reservationTriggers={reservationTriggers}
					loyaltyTriggers={loyaltyTriggers}
					orderTriggers={orderTriggers}
					birthdayTriggers={birthdayTriggers}
					cartTriggers={cartTriggers}
					audienceOptions={audienceOptions}
					couponOptions={couponOptions ?? undefined}
					emailMenuItems
					emailTemplatesEndpoint={`/${orgSlug}/marketing/templates/designer`}
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
		</AiDraftProvider>
	)
}
