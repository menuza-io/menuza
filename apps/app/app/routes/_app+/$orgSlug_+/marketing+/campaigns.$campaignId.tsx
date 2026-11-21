import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignDetailView, type CampaignDetail } from '@repo/marketing'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'
import {
	data,
	redirect,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { CampaignActions } from '#app/components/marketing/campaign-actions.tsx'
import { useLoaderToken } from '#app/hooks/use-loader-token.ts'
import { type BreadcrumbHandle } from '#app/utils/breadcrumb.ts'
import { describeCampaignCoupon } from '#app/utils/discounts/marketing-offers.server.ts'
import { auditCampaign } from '#app/utils/marketing/campaign-audit.server.ts'
import { campaignActionError } from '#app/utils/marketing/campaign-send.server.ts'
import {
	sendTestBroadcast,
	testSendClientFor,
} from '#app/utils/marketing/campaign-test-send.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export const handle: BreadcrumbHandle<Awaited<ReturnType<typeof loader>>> = {
	breadcrumb: (data) => data.name ?? undefined,
}

/**
 * The recipient list holds guest names, emails and phones, which live in the
 * organization's region. The App server only reads the campaign summary (name
 * and coupon offer ids, no recipients) to describe the coupon from
 * control-plane discount names; the browser reads the campaign and its
 * recipients from tenant-api directly with the Marketing token
 * (docs/tenant-data-residency.md).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const campaignId = params.campaignId || ''
	const { orgId, jwt, tenantApiUrl, fetchTenant } =
		await getOperatorTenantClient(request, orgSlug, { area: 'marketing' })

	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)

	let name: string | null = null
	let coupon: CampaignDetail['coupon'] = null
	const res = await fetchTenant(
		`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/summary`,
	).catch(() => null)
	if (res?.ok) {
		const data = (await res.json()) as {
			campaign?: { name?: string; discountOffer?: unknown }
		}
		name = data.campaign?.name ?? null
		coupon = await describeCampaignCoupon(orgId, data.campaign?.discountOffer, {
			userId,
		})
	}

	return { orgSlug, jwt, tenantApiUrl, campaignId, name, coupon }
}

/**
 * What the broadcast page and the list's overflow menu can do (#101): cancel,
 * delete, duplicate, re-send to non-openers and send a test. Each needs
 * `update:campaign:any`, mints only the claims it needs, and writes an audit
 * row with ids only. tenant-api owns the rules (which status allows what, the
 * 48 hours, once per original, 10 tests an hour) and answers with a code.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const campaignId = params.campaignId || ''
	const intent = String((await request.clone().formData()).get('intent') ?? '')
	const { orgId, fetchTenant } = await getOperatorTenantClient(
		request,
		orgSlug,
		{ canUpdate: true, canDelete: intent === 'delete' },
	)
	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)
	const formData = await request.formData()
	const audit = (
		kind: Parameters<typeof auditCampaign>[0]['kind'],
		extra: { campaignId?: string; sourceCampaignId?: string } = {},
	) =>
		auditCampaign({
			kind,
			userId,
			organizationId: orgId,
			campaignId: extra.campaignId ?? campaignId,
			sourceCampaignId: extra.sourceCampaignId,
			request,
		})
	const refused = async (res: Response) => {
		const body = (await res.json().catch(() => ({}))) as { error?: unknown }
		return data(
			{ ok: false as const, error: campaignActionError(body.error) },
			{ status: res.status >= 400 && res.status < 600 ? res.status : 400 },
		)
	}

	switch (intent) {
		case 'cancel': {
			const res = await fetchTenant(
				`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/cancel`,
				{ method: 'POST' },
			)
			if (!res.ok) return refused(res)
			await audit('cancelled')
			return {
				ok: true as const,
				message: i18n._(t`The broadcast was cancelled.`),
			}
		}
		case 'delete': {
			const res = await fetchTenant(
				`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}`,
				{ method: 'DELETE' },
			)
			if (!res.ok) return refused(res)
			await audit('deleted')
			return redirect(`/${orgSlug}/marketing/campaigns`)
		}
		case 'duplicate': {
			const res = await fetchTenant(
				`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/duplicate`,
				{ method: 'POST' },
			)
			if (!res.ok) return refused(res)
			const { campaignId: copyId } = (await res.json()) as {
				campaignId: string
			}
			await audit('duplicated', {
				campaignId: copyId,
				sourceCampaignId: campaignId,
			})
			return redirect(`/${orgSlug}/marketing/campaigns/${copyId}`)
		}
		case 'retarget': {
			const subject = String(formData.get('subject') ?? '').trim()
			const res = await fetchTenant(
				`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/retarget`,
				{
					method: 'POST',
					body: JSON.stringify({ subject: subject || null }),
				},
			)
			if (!res.ok) return refused(res)
			const { campaignId: draftId } = (await res.json()) as {
				campaignId: string
			}
			await audit('retargeted', {
				campaignId: draftId,
				sourceCampaignId: campaignId,
			})
			return redirect(`/${orgSlug}/marketing/campaigns/${draftId}/edit`)
		}
		case 'test': {
			const res = await fetchTenant(
				`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/message`,
			)
			if (!res.ok) return refused(res)
			const { campaign } = (await res.json()) as {
				campaign: {
					channel: 'email' | 'sms' | 'push'
					subject: string | null
					content: string
					contentHtml: string | null
				}
			}
			const result = await sendTestBroadcast({
				makeFetchTenant: testSendClientFor(request, orgSlug),
				userId,
				message: campaign,
			})
			if (result.ok) {
				await audit('test_sent')
				return { ok: true as const, message: result.message }
			}
			return data(
				{ ok: false as const, error: result.message },
				{ status: 400 },
			)
		}
		default:
			return data(
				{ ok: false as const, error: campaignActionError(null) },
				{ status: 400 },
			)
	}
}

type CampaignState =
	| { status: 'loading' }
	| { status: 'not_found' }
	| { status: 'failed' }
	| { status: 'ready'; campaign: Omit<CampaignDetail, 'coupon'> }

export default function CampaignDetailRoute() {
	const { _ } = useLingui()
	const { orgSlug, jwt, tenantApiUrl, campaignId, coupon } =
		useLoaderData<typeof loader>()
	const { token, refreshIfExpired, reloadKey } = useLoaderToken(jwt)
	const [state, setState] = useState<CampaignState>({ status: 'loading' })
	// An action (cancel, …) changed the broadcast: read it again, keeping what
	// is on screen until the new one arrives.
	const [changed, setChanged] = useState(0)
	const onChanged = useCallback(() => setChanged((value) => value + 1), [])

	// Keyed on the campaign, not on the token or coupon: a loader revalidation
	// signs a new token and must not blank the page or download the recipients
	// again. A 401 on an expired token asks the loader for a new one, and
	// `reloadKey` fetches again once it arrives, keeping what is on screen.
	useEffect(() => {
		const controller = new AbortController()
		async function load() {
			const used = token()
			try {
				const res = await fetch(
					`${tenantApiUrl}/operator/marketing/campaigns/${encodeURIComponent(campaignId)}`,
					{
						headers: { Authorization: `Bearer ${used}` },
						signal: controller.signal,
					},
				)
				if (res.status === 401 && refreshIfExpired(used)) return
				if (!res.ok) {
					setState({ status: res.status === 404 ? 'not_found' : 'failed' })
					return
				}
				const data = (await res.json()) as {
					campaign?: CampaignDetail & { discountOffer?: unknown }
				}
				if (!data.campaign) {
					setState({ status: 'not_found' })
					return
				}
				const {
					discountOffer: _offer,
					coupon: _coupon,
					...campaign
				} = data.campaign
				setState({ status: 'ready', campaign })
			} catch {
				if (!controller.signal.aborted) setState({ status: 'failed' })
			}
		}
		void load()
		return () => controller.abort()
	}, [tenantApiUrl, campaignId, reloadKey, changed, token, refreshIfExpired])

	// Another campaign: show the skeleton, not the previous one's recipients.
	const [shownCampaignId, setShownCampaignId] = useState(campaignId)
	if (shownCampaignId !== campaignId) {
		setShownCampaignId(campaignId)
		setState({ status: 'loading' })
	}

	if (state.status === 'loading') {
		return (
			<div className="space-y-4" role="status" aria-busy="true">
				<span className="sr-only">{_(msg`Loading broadcast…`)}</span>
				<Skeleton className="h-8 w-64" aria-hidden />
				<Skeleton className="h-32 w-full rounded-lg" aria-hidden />
				<Skeleton className="h-48 w-full rounded-lg" aria-hidden />
			</div>
		)
	}

	if (state.status !== 'ready') {
		return (
			<p role="alert" className="text-destructive text-sm">
				{state.status === 'not_found'
					? _(msg`Broadcast not found`)
					: _(msg`Failed to load broadcast`)}
			</p>
		)
	}

	return (
		<CampaignDetailView
			campaign={{ ...state.campaign, coupon }}
			getCampaignHref={(id) => `/${orgSlug}/marketing/campaigns/${id}`}
			actions={
				<CampaignActions
					orgSlug={orgSlug}
					campaign={state.campaign}
					variant="buttons"
					onChanged={onChanged}
				/>
			}
		/>
	)
}
