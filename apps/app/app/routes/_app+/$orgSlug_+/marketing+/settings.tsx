import { i18n } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { useEffect, useState } from 'react'
import {
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { toast } from 'sonner'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type Settings = {
	frequencyCap: { limit: number; days: number } | null
	defaultFrequencyCap: { limit: number; days: number }
	cartReminder: { delayMinutes: number; minCartMinor: number }
	defaultCartReminder: { delayMinutes: number; minCartMinor: number }
}

/**
 * Marketing settings (#99 #150): the frequency cap across broadcasts and
 * automations, and the cart reminder's delay and smallest cart. Organization
 * wide; no guest data. The page exists while order automations are on.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)
	const features = await getMarketingFeatures(orgId)
	if (!features.orderAutomations && !features.cartReminders) {
		throw new Response('Not found', { status: 404 })
	}
	const res = await fetchTenant('/operator/marketing/settings')
	const settings = res.ok ? ((await res.json()) as Settings) : null
	return {
		orgSlug,
		settings,
		cartReminders: features.cartReminders,
		error: settings ? null : i18n._(t`Failed to load settings`),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug, {
		canUpdate: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)
	const features = await getMarketingFeatures(orgId)
	if (!features.orderAutomations && !features.cartReminders) {
		throw new Response('Not found', { status: 404 })
	}
	const form = await request.formData()
	const body: Record<string, unknown> = {}
	if (form.get('capOff') === '1') body.frequencyCap = null
	else {
		const limit = Math.floor(Number(form.get('capLimit')))
		if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
			return { ok: false as const, error: i18n._(t`Enter a number from 1 to 50.`) }
		}
		body.frequencyCap = { limit, days: 7 }
	}
	if (features.cartReminders) {
		const hours = Number(form.get('cartDelayHours'))
		const minimum = Number(form.get('cartMinimum'))
		const delayMinutes = Math.round(hours * 60)
		if (
			!Number.isFinite(delayMinutes) ||
			delayMinutes < 5 ||
			delayMinutes > 24 * 60 ||
			!Number.isFinite(minimum) ||
			minimum < 0
		) {
			return {
				ok: false as const,
				error: i18n._(t`Check the cart reminder delay and the smallest cart.`),
			}
		}
		body.cartReminder = {
			delayMinutes,
			minCartMinor: Math.round(minimum * 100),
		}
	}
	const res = await fetchTenant('/operator/marketing/settings', {
		method: 'PUT',
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		return { ok: false as const, error: i18n._(t`Settings could not be saved.`) }
	}
	return { ok: true as const }
}

export default function MarketingSettingsRoute() {
	const { _ } = useLingui()
	const { settings, cartReminders, error } = useLoaderData<typeof loader>()
	const hasPermission = useHasPermission()
	const canManage = hasPermission('update:campaign:any')
	const fetcher = useFetcher<typeof action>()
	const cap = settings?.frequencyCap ?? null
	const [capOff, setCapOff] = useState(cap === null)

	useEffect(() => {
		if (fetcher.state !== 'idle' || !fetcher.data) return
		if (fetcher.data.ok) toast.success(_(msg`Settings saved`))
		else toast.error(fetcher.data.error)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Marketing settings`)}
				description={_(
					msg`Limits that protect your guests from too many messages.`,
				)}
			/>
			{error || !settings ? (
				<p className="text-destructive text-sm">{error}</p>
			) : (
				<fetcher.Form method="post" className="max-w-xl space-y-8">
					<section className="space-y-3">
						<h2 className="text-base font-semibold">
							<Trans>Message limit</Trans>
						</h2>
						<p className="text-muted-foreground text-sm">
							<Trans>
								The most marketing messages one guest gets in 7 days, across
								broadcasts and automations. Receipts and other order messages never
								count. A step over the limit is skipped and the run shows why.
							</Trans>
						</p>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="capOff"
								value="1"
								checked={capOff}
								disabled={!canManage}
								onChange={(event) => setCapOff(event.target.checked)}
							/>
							<Trans>No limit</Trans>
						</label>
						<div className="space-y-1.5">
							<Label htmlFor="capLimit">
								<Trans>Messages per guest per 7 days</Trans>
							</Label>
							<Input
								id="capLimit"
								name="capLimit"
								type="number"
								min={1}
								max={50}
								className="w-28"
								defaultValue={cap?.limit ?? settings.defaultFrequencyCap.limit}
								disabled={capOff || !canManage}
							/>
						</div>
					</section>

					{cartReminders ? (
						<section className="space-y-3">
							<h2 className="text-base font-semibold">
								<Trans>Cart reminder</Trans>
							</h2>
							<p className="text-muted-foreground text-sm">
								<Trans>
									A signed-in guest who agreed to hear from you and leaves a cart gets
									one reminder, at most once a day.
								</Trans>
							</p>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-1.5">
									<Label htmlFor="cartDelayHours">
										<Trans>Wait this many hours</Trans>
									</Label>
									<Input
										id="cartDelayHours"
										name="cartDelayHours"
										type="number"
										step="0.25"
										min={0.1}
										max={24}
										className="w-28"
										defaultValue={settings.cartReminder.delayMinutes / 60}
										disabled={!canManage}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="cartMinimum">
										<Trans>Smallest cart to remind about</Trans>
									</Label>
									<Input
										id="cartMinimum"
										name="cartMinimum"
										type="number"
										step="0.01"
										min={0}
										className="w-28"
										defaultValue={settings.cartReminder.minCartMinor / 100}
										disabled={!canManage}
									/>
								</div>
							</div>
						</section>
					) : null}

					{canManage ? (
						<Button type="submit" disabled={fetcher.state !== 'idle'}>
							<Trans>Save settings</Trans>
						</Button>
					) : null}
				</fetcher.Form>
			)}
		</div>
	)
}
