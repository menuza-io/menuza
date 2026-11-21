import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	INVITE_BANNER_TEXT_MAX,
	INVITE_PLACEMENTS,
	inviteSettingsSchema,
	type InvitePlacement,
} from '@repo/common/customer-app'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Switch } from '@repo/ui/switch'
import { useId, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { customerAppPanelAvailable } from '#app/utils/customer-apps/panel.server.ts'
import { updateInviteSettings } from '#app/utils/customer-apps/service.server.ts'
import { loadCustomerAppView } from '#app/utils/customer-apps/view.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/**
 * Marketing, Customer app (#196): the "Get the app" placements on the website.
 * Switches for the phone banner, the order confirmation (and the receipt
 * email) and the footer, the banner's own words, and how many times each
 * placement was tapped in the last 30 days. Nothing shows to a guest until at
 * least one store is live, and each placement shows only the stores that are.
 * Needs `update:settings:any` to change; the page exists behind
 * `customer_app.enabled`.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)
	if (!(await customerAppPanelAvailable(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	const view = await loadCustomerAppView(organization.id)
	if (!view) throw new Response('Not found', { status: 404 })
	const canEdit = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
		.then(() => true)
		.catch(() => false)
	return {
		orgSlug: organization.slug,
		displayName: view.displayName,
		invite: view.invite,
		live: {
			app_store: Boolean(view.live.app_store),
			play_store: Boolean(view.live.play_store),
		},
		taps: view.taps,
		canEdit,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	if (!(await customerAppPanelAvailable(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	const view = await loadCustomerAppView(organization.id)
	if (!view) throw new Response('Not found', { status: 404 })
	const form = await request.formData()
	const parsed = inviteSettingsSchema.safeParse({
		banner: form.get('banner') === 'on',
		confirmation: form.get('confirmation') === 'on',
		footer: form.get('footer') === 'on',
		bannerText: String(form.get('bannerText') ?? ''),
	})
	if (!parsed.success) {
		return { ok: false as const, error: 'invalid' as const }
	}
	const result = await updateInviteSettings(view.id, parsed.data)
	return result.ok
		? { ok: true as const }
		: { ok: false as const, error: 'invalid' as const }
}

const PLACEMENT_LABELS = {
	banner: msg`Phone banner`,
	confirmation: msg`Order confirmation page`,
	email: msg`Receipt email`,
	footer: msg`Website footer`,
	block: msg`Page block`,
	print: msg`Printed QR code`,
} satisfies Record<InvitePlacement, ReturnType<typeof msg>>

export default function CustomerAppPromote() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	const fetcher = useFetcher<typeof action>()
	const [bannerText, setBannerText] = useState(data.invite.bannerText)
	const textId = useId()
	const nobodyLive = !data.live.app_store && !data.live.play_store
	const total = (placement: string) =>
		data.taps.find((entry) => entry.placement === placement)?.total ?? 0

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(msg`Customer app`)}
				description={_(msg`Invite website guests to get ${data.displayName}.`)}
			/>
			{nobodyLive ? (
				<Alert>
					<AlertTitle>
						<Trans>Nothing shows yet</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							The invitations appear once your app is live in a store. Each one
							shows only the stores that are live.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Where guests are invited</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							The banner is shown to phone visitors after their first order or
							on their second visit, can be dismissed for 30 days, and never
							covers the cart or checkout.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<fetcher.Form method="post" className="flex flex-col gap-4">
						{(
							[
								['banner', _(msg`Phone banner`)],
								[
									'confirmation',
									_(msg`Order confirmation page and receipt email`),
								],
								['footer', _(msg`Website footer`)],
							] as const
						).map(([name, label]) => (
							<label
								key={name}
								className="flex items-center justify-between gap-4"
							>
								<span>{label}</span>
								<Switch
									name={name}
									defaultChecked={data.invite[name]}
									disabled={!data.canEdit}
								/>
							</label>
						))}
						<div className="flex flex-col gap-1">
							<Label htmlFor={textId}>
								<Trans>Banner text</Trans>
							</Label>
							<Input
								id={textId}
								name="bannerText"
								value={bannerText}
								maxLength={INVITE_BANNER_TEXT_MAX}
								placeholder={_(msg`Order faster in our app`)}
								onChange={(event) => setBannerText(event.target.value)}
								disabled={!data.canEdit}
							/>
						</div>
						{data.canEdit ? (
							<div className="flex items-center gap-3">
								<Button type="submit" disabled={fetcher.state !== 'idle'}>
									<Trans>Save</Trans>
								</Button>
								{fetcher.data?.ok ? (
									<span className="text-muted-foreground text-sm" role="status">
										<Trans>Saved.</Trans>
									</span>
								) : null}
								{fetcher.data && !fetcher.data.ok ? (
									<span className="text-destructive text-sm" role="alert">
										<Trans>Check the values and try again.</Trans>
									</span>
								) : null}
							</div>
						) : null}
					</fetcher.Form>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Taps in the last 30 days</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Counted per place, with nothing about the visitor.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ul className="flex flex-col gap-2" data-testid="tap-counts">
						{INVITE_PLACEMENTS.map((placement) => (
							<li key={placement} className="flex items-center justify-between">
								<span>{_(PLACEMENT_LABELS[placement])}</span>
								<span className="font-medium tabular-nums">
									{total(placement)}
								</span>
							</li>
						))}
					</ul>
				</CardContent>
			</Card>
		</div>
	)
}
