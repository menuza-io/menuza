import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import {
	buildEmailTemplateBlocks,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { db, eq, Organization } from '@repo/database'
import { parseMarketingOffer } from '@repo/discounts'
import {
	CampaignForm,
	CouponOfferField,
	type CouponOfferValue,
	AiDraftProvider,
} from '@repo/marketing'
import { getSmsAllowance } from '@repo/marketing/server/sms-allowance'
import { PageHeader } from '@repo/ui/page-header'
import { useState } from 'react'
import {
	Form,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { CampaignEmailDesigner } from '#app/components/marketing/campaign-email-designer.tsx'
import { SavedAudienceField } from '#app/components/marketing/saved-audience-field.tsx'
import {
	loadCouponDiscountOptions,
	readOfferField,
} from '#app/utils/discounts/marketing-offers.server.ts'
import {
	handleMenuItemIntent,
	previewEmail,
} from '#app/utils/email/designer.server.ts'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { loadAiDraftConfig } from '#app/utils/marketing/ai-draft-config.server.ts'
import { loadAudienceOptions } from '#app/utils/marketing/audiences.server.ts'
import { submitCampaign } from '#app/utils/marketing/campaign-submit.server.ts'
import { testSendClientFor } from '#app/utils/marketing/campaign-test-send.server.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)

	// "Tell your guests" on the launch checklist opens the "We're open"
	// template with the site link. It is only a draft: nothing is sent until
	// the operator presses Send, to subscribed customers only.
	const launch = new URL(request.url).searchParams.get('template') === 'launch'
	const [site] = launch
		? await db
				.select({
					slug: Organization.slug,
					customDomain: Organization.customDomain,
				})
				.from(Organization)
				.where(eq(Organization.id, orgId))
				.limit(1)
		: []

	const features = await getMarketingFeatures(orgId)
	return {
		orgSlug,
		audienceOptions: features.audiences
			? ((await loadAudienceOptions(fetchTenant)) ?? null)
			: null,
		pushEnabled: features.push,
		// What is left of this month's text sends (#247).
		smsAllowance: await getSmsAllowance(orgId),
		couponOptions: await loadCouponDiscountOptions(userId, orgId),
		aiDraft: await loadAiDraftConfig(orgId, orgSlug),
		template: launch ? ('launch' as const) : null,
		siteUrl: site ? orgSiteUrl(site) : null,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(
		request,
		orgSlug,
		{ canUpdate: true },
	)

	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')
	const baseUrl = getDomainUrl(request)

	const offerField = readOfferField(formData.get('discountOffer'))
	const previewOffer = parseMarketingOffer(offerField)

	const menuIntent = await handleMenuItemIntent({
		intent,
		formData,
		organizationId: orgId,
		baseUrl,
	})
	if (menuIntent) return menuIntent

	if (intent === 'email_preview') {
		return previewEmail({
			organizationId: orgId,
			blocks: formData.get('blocks'),
			subject: String(formData.get('subject') || ''),
			baseUrl,
			offer: previewOffer,
		})
	}

	const result = await submitCampaign({
		request,
		organizationId: orgId,
		userId,
		fetchTenant,
		makeTestFetchTenant: testSendClientFor(request, orgSlug),
		formData,
		baseUrl,
	})
	switch (result.kind) {
		case 'saved':
			return redirect(
				result.intent === 'draft'
					? `/${orgSlug}/marketing/campaigns/${result.campaignId}`
					: `/${orgSlug}/marketing/campaigns`,
			)
		case 'problems':
			return { problems: result.problems, blocks: result.blocks }
		case 'test':
			return { testResult: result.result }
		case 'error':
			return { error: result.error }
	}
}

export default function NewCampaignRoute() {
	const { _ } = useLingui()
	const {
		orgSlug,
		audienceOptions,
		couponOptions,
		template,
		siteUrl,
		aiDraft,
		pushEnabled,
		smsAllowance,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'
	const [offer, setOffer] = useState<CouponOfferValue | null>(null)
	const [blocks, setBlocks] = useState<EmailBlock[]>(() =>
		buildEmailTemplateBlocks(template ?? 'welcome', {
			buttonUrl: siteUrl ?? undefined,
		}),
	)
	const [focusBlock, setFocusBlock] = useState<{
		id: string
		nonce: number
	} | null>(null)

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(msg`New broadcast`)}
				description={_(
					msg`Send a one-time email or SMS to your audience, now or later.`,
				)}
			/>

			<AiDraftProvider config={aiDraft ? { ...aiDraft, offer } : null}>
				<Form method="post">
					<CampaignForm
						onAiDraftBlocks={aiDraft ? setBlocks : undefined}
						hasEmailBlocks={blocks.length > 0}
						scheduling
						canTestSend
						pushEnabled={pushEnabled}
						smsAllowance={smsAllowance}
						audienceField={
							audienceOptions ? (
								<SavedAudienceField
									options={audienceOptions}
									orgSlug={orgSlug}
								/>
							) : null
						}
						error={
							actionData && 'error' in actionData ? actionData.error : null
						}
						problems={
							actionData && 'problems' in actionData
								? actionData.problems
								: null
						}
						blocks={
							actionData && 'blocks' in actionData ? actionData.blocks : blocks
						}
						testResult={
							actionData && 'testResult' in actionData
								? actionData.testResult
								: null
						}
						onEditBlock={(id) =>
							setFocusBlock({ id, nonce: (focusBlock?.nonce ?? 0) + 1 })
						}
						isSubmitting={isSubmitting}
						cancelTo=".."
						emailDesigner={
							<CampaignEmailDesigner
								orgSlug={orgSlug}
								blocks={blocks}
								onChange={setBlocks}
								offer={offer}
								focusBlock={focusBlock}
							/>
						}
						couponField={
							couponOptions ? (
								<CouponOfferField
									name="discountOffer"
									options={couponOptions}
									value={offer}
									onChange={setOffer}
								/>
							) : null
						}
					/>
				</Form>
			</AiDraftProvider>
		</div>
	)
}
