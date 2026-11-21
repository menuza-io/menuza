import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import { parseEmailBlocks, type EmailBlock } from '@repo/common/email-blocks'
import { parseMarketingOffer } from '@repo/discounts'
import {
	CampaignForm,
	CouponOfferField,
	type CouponOfferValue,
	AiDraftProvider,
} from '@repo/marketing'
import { getSmsAllowanceForBroadcast } from '@repo/marketing/server/sms-allowance'
import { PageHeader } from '@repo/ui/page-header'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { CampaignEmailDesigner } from '#app/components/marketing/campaign-email-designer.tsx'
import { SavedAudienceField } from '#app/components/marketing/saved-audience-field.tsx'
import { loadCouponDiscountOptions } from '#app/utils/discounts/marketing-offers.server.ts'
import {
	handleMenuItemIntent,
	previewEmail,
} from '#app/utils/email/designer.server.ts'
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

/**
 * Edit a Draft or Scheduled broadcast (#101). It reads the message and its
 * settings from tenant-api (never a recipient) and saves through the same flow
 * as the composer. A broadcast that is already sending, finished or cancelled
 * goes back to its page.
 */

type StoredMessage = {
	id: string
	name: string
	status: string
	channel: 'email' | 'sms' | 'push'
	subject: string | null
	pushImageUrl?: string | null
	pushLink?: string | null
	content: string
	contentBlocks: string | null
	discountOffer: unknown
	audience: string
	audienceId?: string | null
	scheduledAt: string | null
	lateAfterMinutes: number
	retargetOfCampaignId: string | null
}

async function readMessage(
	fetchTenant: (path: string) => Promise<Response>,
	campaignId: string,
) {
	const res = await fetchTenant(
		`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/message`,
	).catch(() => null)
	if (!res) throw new Response('Broadcast unavailable', { status: 502 })
	if (res.status === 404)
		throw new Response('Broadcast not found', { status: 404 })
	if (!res.ok) throw new Response('Broadcast unavailable', { status: 502 })
	return ((await res.json()) as { campaign: StoredMessage }).campaign
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const campaignId = params.campaignId || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)

	const campaign = await readMessage(fetchTenant, campaignId)
	if (campaign.status !== 'Draft' && campaign.status !== 'Scheduled') {
		return redirect(`/${orgSlug}/marketing/campaigns/${campaignId}`)
	}

	const features = await getMarketingFeatures(orgId)
	return {
		orgSlug,
		audienceOptions: features.audiences
			? ((await loadAudienceOptions(fetchTenant)) ?? null)
			: null,
		campaign: {
			id: campaign.id,
			name: campaign.name,
			status: campaign.status,
			channel: campaign.channel,
			subject: campaign.subject,
			content: campaign.content,
			pushImageUrl: campaign.pushImageUrl ?? null,
			pushLink: campaign.pushLink ?? null,
			audience: campaign.audience,
			audienceId: campaign.audienceId ?? null,
			scheduledAt: campaign.scheduledAt
				? new Date(campaign.scheduledAt).toISOString()
				: null,
			lateAfterMinutes: campaign.lateAfterMinutes,
			retargetOfCampaignId: campaign.retargetOfCampaignId,
		},
		blocks: parseEmailBlocks(campaign.contentBlocks),
		offer: parseMarketingOffer(campaign.discountOffer),
		couponOptions: await loadCouponDiscountOptions(userId, orgId),
		aiDraft: await loadAiDraftConfig(orgId, orgSlug),
		// What is left of this month's text sends (#247); the send this
		// broadcast already holds is still available to it.
		smsAllowance: await getSmsAllowanceForBroadcast(orgId, campaignId),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const campaignId = params.campaignId || ''
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

	const stored = await readMessage(fetchTenant, campaignId)
	const result = await submitCampaign({
		request,
		organizationId: orgId,
		userId,
		fetchTenant,
		makeTestFetchTenant: testSendClientFor(request, orgSlug),
		formData,
		baseUrl,
		existing: {
			id: campaignId,
			retargetOfCampaignId: stored.retargetOfCampaignId,
			discountOffer: stored.discountOffer,
		},
	})
	switch (result.kind) {
		case 'saved':
			return redirect(`/${orgSlug}/marketing/campaigns/${campaignId}`)
		case 'problems':
			return { problems: result.problems, blocks: result.blocks }
		case 'test':
			return { testResult: result.result }
		case 'error':
			return { error: result.error }
	}
}

export default function EditCampaignRoute() {
	const { _ } = useLingui()
	const {
		orgSlug,
		audienceOptions,
		campaign,
		blocks: storedBlocks,
		offer: storedOffer,
		couponOptions,
		aiDraft,
		smsAllowance,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'
	const [offer, setOffer] = useState<CouponOfferValue | null>(
		storedOffer as CouponOfferValue | null,
	)
	const [blocks, setBlocks] = useState<EmailBlock[]>(storedBlocks)
	const [focusBlock, setFocusBlock] = useState<{
		id: string
		nonce: number
	} | null>(null)

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(msg`Edit broadcast`)}
				description={
					campaign.status === 'Scheduled'
						? _(msg`This broadcast is scheduled. Saving keeps it scheduled.`)
						: _(
								msg`This broadcast is a draft. Nothing is sent until you send or schedule it.`,
							)
				}
			/>

			<AiDraftProvider config={aiDraft ? { ...aiDraft, offer } : null}>
				<Form method="post">
					<CampaignForm
						onAiDraftBlocks={aiDraft ? setBlocks : undefined}
						hasEmailBlocks={blocks.length > 0}
						scheduling
						canTestSend
						smsAllowance={smsAllowance}
						audienceField={
							audienceOptions ? (
								<SavedAudienceField
									options={audienceOptions}
									defaultValue={campaign.audienceId}
									orgSlug={orgSlug}
								/>
							) : null
						}
						lockChannel
						defaults={{
							name: campaign.name,
							channel: campaign.channel,
							subject: campaign.subject,
							content: campaign.content,
							pushImageUrl: campaign.pushImageUrl,
							pushLink: campaign.pushLink,
							audience: campaign.audience,
							scheduledAt: campaign.scheduledAt,
							lateAfterMinutes: campaign.lateAfterMinutes,
						}}
						notice={
							campaign.retargetOfCampaignId ? (
								<div
									role="note"
									className="bg-muted/50 space-y-1 rounded-lg border p-4 text-sm"
								>
									<p className="font-medium">
										{_(msg`A re-send to people who did not open it`)}
									</p>
									<p className="text-muted-foreground">
										{_(
											msg`It goes to people who got the first broadcast, did not open or click it, and are still subscribed when this is sent. Opens are not always counted: some mail apps open messages automatically or hide the open from senders (Apple Mail Privacy Protection, for example), so a few people who read the first one may get this too.`,
										)}
									</p>
									<Link
										className="text-sm underline"
										to={`/${orgSlug}/marketing/campaigns/${campaign.retargetOfCampaignId}`}
									>
										{_(msg`See the original broadcast`)}
									</Link>
								</div>
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
						cancelTo={`/${orgSlug}/marketing/campaigns/${campaign.id}`}
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
							couponOptions || offer ? (
								<CouponOfferField
									name="discountOffer"
									options={couponOptions ?? []}
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
