import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import {
	buildEmailTemplateBlocks,
	type EmailBlock,
	type EmailBlockTemplateId,
} from '@repo/common/email-blocks'
import { db, eq, Organization } from '@repo/database'
import { parseMarketingOffer } from '@repo/discounts'
import {
	CampaignForm,
	CouponOfferField,
	type CouponOfferValue,
	EmailBlockEditor,
} from '@repo/marketing'
import { PageHeader } from '@repo/ui/page-header'
import { useCallback, useRef, useState } from 'react'
import {
	Form,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'
import {
	loadCouponDiscountOptions,
	readOfferField,
} from '#app/utils/discounts/marketing-offers.server.ts'
import {
	handleMenuItemIntent,
	previewEmail,
} from '#app/utils/email/designer.server.ts'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { prepareCampaignMessage } from '#app/utils/marketing/campaign-message.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

function EmailDesignerField({
	orgSlug,
	template = 'welcome',
	buttonUrl,
	offer,
}: {
	orgSlug: string
	template?: EmailBlockTemplateId
	buttonUrl?: string
	/** The message's coupon: the Coupon block needs it and the preview shows it. */
	offer: CouponOfferValue | null
}) {
	const [blocks, setBlocks] = useState<EmailBlock[]>(() =>
		buildEmailTemplateBlocks(template, { buttonUrl }),
	)
	const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
	const onSelectCallbackRef = useRef<
		((url: string, alt: string) => void) | null
	>(null)

	const handleChooseImage = useCallback(
		(onSelect: (url: string, alt: string) => void) => {
			onSelectCallbackRef.current = onSelect
			setLibraryPickerOpen(true)
		},
		[],
	)

	const handleAssetSelected = useCallback((asset: MediaLibraryAsset) => {
		if (onSelectCallbackRef.current) {
			const baseUrl =
				typeof window !== 'undefined' ? window.location.origin : ''
			const resolvedUrl =
				asset.url.startsWith('http://') || asset.url.startsWith('https://')
					? asset.url
					: `${baseUrl}${asset.url.startsWith('/') ? '' : '/'}${asset.url}`
			onSelectCallbackRef.current(
				resolvedUrl,
				asset.altText || asset.fileName || '',
			)
			onSelectCallbackRef.current = null
		}
	}, [])

	return (
		<div className="space-y-3">
			<input type="hidden" name="blocks" value={JSON.stringify(blocks)} />
			<EmailBlockEditor
				blocks={blocks}
				onChange={setBlocks}
				onChooseImageFromLibrary={orgSlug ? handleChooseImage : undefined}
				// Sent broadcast emails carry a signed unsubscribe link.
				unsubscribeLinkPreview
				menuItems
				templatesEndpoint={`/${orgSlug}/marketing/templates/designer`}
				couponAvailable={Boolean(offer)}
				requestFields={{ discountOffer: offer ? JSON.stringify(offer) : '' }}
			/>
			{orgSlug ? (
				<MediaLibraryPicker
					orgSlug={orgSlug}
					open={libraryPickerOpen}
					onOpenChange={setLibraryPickerOpen}
					onSelect={handleAssetSelected}
					trigger={null}
				/>
			) : null}
		</div>
	)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId } = await getOperatorTenantClient(request, orgSlug)

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

	return {
		orgSlug,
		couponOptions: await loadCouponDiscountOptions(userId, orgId),
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

	const prepared = await prepareCampaignMessage({
		formData,
		organizationId: orgId,
		userId,
		baseUrl,
	})
	if (!prepared.ok) return { error: prepared.error }
	const { message } = prepared

	const createRes = await fetchTenant('/operator/marketing/campaigns', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: formData.get('name'),
			channel: message.channel,
			subject: message.subject,
			content: message.content,
			contentHtml: message.contentHtml,
			contentBlocks: message.contentBlocks,
			discountOffer: message.discountOffer,
		}),
	})

	if (!createRes.ok) {
		const err = await createRes.json().catch(() => ({}))
		return {
			error:
				(err as { error?: string }).error ||
				i18n._(t`Failed to create and dispatch campaign`),
		}
	}

	return redirect(`/${orgSlug}/marketing/campaigns`)
}

export default function NewCampaignRoute() {
	const { _ } = useLingui()
	const { orgSlug, couponOptions, template, siteUrl } =
		useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'
	const [offer, setOffer] = useState<CouponOfferValue | null>(null)

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(msg`New broadcast`)}
				description={_(msg`Send a one-time email or SMS to your audience.`)}
			/>

			<Form method="post">
				<CampaignForm
					error={actionData?.error}
					isSubmitting={isSubmitting}
					cancelTo=".."
					emailDesigner={
						<EmailDesignerField
							orgSlug={orgSlug}
							template={template ?? undefined}
							buttonUrl={siteUrl ?? undefined}
							offer={offer}
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
		</div>
	)
}
