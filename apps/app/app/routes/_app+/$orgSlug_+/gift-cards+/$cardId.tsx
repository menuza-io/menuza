import { useLingui as useLinguiRuntime } from '@lingui/react'
import { Trans, useLingui } from '@lingui/react/macro'
import { GIFT_CARD_PERMISSIONS } from '@repo/common/gift-cards'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Form,
	Link,
	useActionData,
	useNavigation,
	useParams,
	type ActionFunctionArgs,
} from 'react-router'
import { useGiftCardClient } from '#app/components/gift-cards/gift-card-client-provider.tsx'
import {
	AdjustDialog,
	ChargeDialog,
	RefundChargeDialog,
	useGiftCardErrorText,
	VoidDialog,
} from '#app/components/gift-cards/gift-card-dialogs.tsx'
import { requireGiftCardAccess } from '#app/utils/gift-cards/access.server.ts'
import { type GiftCardDetail } from '#app/utils/gift-cards/gift-card-client.ts'
import {
	formatGiftCardDate,
	formatGiftCardMoney,
	GIFT_CARD_CHANNEL_LABELS,
	GIFT_CARD_KIND_LABELS,
	GIFT_CARD_STATUS_LABELS,
} from '#app/utils/gift-cards/labels.ts'
import { refundGiftCardPurchase } from '#app/utils/gift-cards/purchase-refund.server.ts'
import { useGiftCardLayout } from './_layout.tsx'

/**
 * Refunding a held online purchase (#218): the region books the removal of the
 * unspent balance and the App then calls the payment provider with the
 * region's own facts. Server-side, so the browser never names a payment.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	await requireGiftCardAccess(request, params.orgSlug, {
		requireAll: [GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD],
	})
	const form = await request.formData()
	if (form.get('intent') !== 'refund-purchase') {
		return Response.json({ ok: false, code: 'invalid_request' }, { status: 400 })
	}
	const key = String(form.get('key') ?? '')
	if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
		return Response.json({ ok: false, code: 'invalid_request' }, { status: 400 })
	}
	const result = await refundGiftCardPurchase({
		request,
		orgSlug: params.orgSlug,
		cardId: params.cardId ?? '',
		key,
	})
	return Response.json(result, { status: result.ok ? 200 : result.status })
}

export default function GiftCardDetailRoute() {
	const { orgSlug, nav, locations } = useGiftCardLayout()
	const client = useGiftCardClient()
	const errorText = useGiftCardErrorText()
	const { t, i18n } = useLingui()
	const { _ } = useLinguiRuntime()
	const cardId = useParams().cardId ?? ''
	const [detail, setDetail] = useState<GiftCardDetail | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [dialog, setDialog] = useState<'adjust' | 'void' | 'charge' | { refund: string; max: number } | null>(null)
	const [version, setVersion] = useState(0)
	const [approving, setApproving] = useState(false)
	const refundKey = useRef(`gc-refund-${crypto.randomUUID()}`)
	const navigation = useNavigation()
	const actionData = useActionData<typeof action>() as
		| { ok: true; refundMinor: number; provider: string }
		| { ok: false; code: string }
		| undefined

	const load = useCallback(async () => {
		try {
			setDetail(await client.detail(cardId))
			setError(null)
		} catch (caught) {
			setError(errorText(caught))
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, cardId, version])
	useEffect(() => {
		void load()
	}, [load])
	useEffect(() => {
		if (actionData?.ok) setVersion((value) => value + 1)
	}, [actionData])

	if (error) {
		return (
			<p role="alert" className="text-destructive text-sm">
				{error}
			</p>
		)
	}
	if (!detail) {
		return <p className="text-muted-foreground text-sm"><Trans>Loading card…</Trans></p>
	}
	const { card, history, people } = detail
	const money = (minor: number) => formatGiftCardMoney(minor, card.currency, i18n.locale)
	const refresh = () => setVersion((value) => value + 1)
	const reviewable = card.status === 'held' && card.holdReason !== 'first_buyer'
	const chargeRefunded = (chargeId: string) =>
		history
			.filter((entry) => entry.kind === 'refund' && entry.refEntryId === chargeId)
			.reduce((sum, entry) => sum + entry.amountMinor, 0)

	return (
		<div className="grid gap-6">
			<div className="flex flex-wrap items-center gap-3">
				<Button variant="ghost" size="sm" render={<Link to={`/${orgSlug}/gift-cards`} />}>
					<Trans>All cards</Trans>
				</Button>
				<h2 className="text-lg font-semibold">
					{'••••'} {card.last4}
				</h2>
				<Badge variant={card.status === 'active' ? 'default' : 'secondary'}>
					{_(GIFT_CARD_STATUS_LABELS[card.status])}
				</Badge>
				<span className="text-2xl font-semibold tabular-nums ms-auto">{money(card.balanceMinor)}</span>
			</div>

			{detail.originalLast4 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Original card number ends {detail.originalLast4}</Trans>
				</p>
			) : null}

			<div className="flex flex-wrap gap-2">
				{nav.canCharge && card.status === 'active' ? (
					<Button onClick={() => setDialog('charge')}>
						<Trans>Charge card</Trans>
					</Button>
				) : null}
				{nav.canManage ? (
					<>
						<Button variant="outline" onClick={() => setDialog('adjust')}>
							<Trans>Adjust balance</Trans>
						</Button>
						{card.status !== 'voided' ? (
							<Button variant="outline" onClick={() => setDialog('void')}>
								<Trans>Void</Trans>
							</Button>
						) : null}
					</>
				) : null}
			</div>

			{reviewable && nav.canManage ? (
				<Frame className="grid gap-3 p-4">
					<h3 className="font-medium"><Trans>Needs review</Trans></h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							The payment provider marked this purchase as higher risk. The card cannot be spent until you approve it
							or refund the buyer. A refund can only return what is still unspent.
						</Trans>
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={approving}
							onClick={async () => {
								setApproving(true)
								try {
									await client.approve(card.id)
									refresh()
								} catch (caught) {
									setError(errorText(caught))
								} finally {
									setApproving(false)
								}
							}}
						>
							<Trans>Approve</Trans>
						</Button>
						<Form method="post">
							<input type="hidden" name="intent" value="refund-purchase" />
							<input type="hidden" name="key" value={refundKey.current} />
							<Button type="submit" variant="outline" disabled={navigation.state !== 'idle'}>
								<Trans>Refund the buyer</Trans>
							</Button>
						</Form>
					</div>
					{actionData && !actionData.ok ? (
						<p role="alert" className="text-destructive text-sm">
							<Trans>The refund could not be completed. Try again: the same refund is never made twice.</Trans>
						</p>
					) : null}
					{actionData?.ok ? (
						<p role="status" className="text-sm">
							{actionData.provider === 'none'
								? t`The balance was removed. There was no online payment to refund automatically.`
								: t`Refund of ${money(actionData.refundMinor)} sent to the payment provider.`}
						</p>
					) : null}
				</Frame>
			) : null}

			{card.status === 'frozen' ? (
				<Frame className="p-4 text-sm">
					<Trans>
						This card is frozen because its purchase was disputed. What was spent before the freeze is in the history
						below.
					</Trans>
				</Frame>
			) : null}

			<section className="grid gap-2">
				<h3 className="font-medium"><Trans>History</Trans></h3>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead><Trans>When</Trans></TableHead>
							<TableHead><Trans>What</Trans></TableHead>
							<TableHead><Trans>Where</Trans></TableHead>
							<TableHead><Trans>Who and why</Trans></TableHead>
							<TableHead className="text-end"><Trans>Amount</Trans></TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{[...history].reverse().map((entry) => {
							const charge = entry.sourceType === 'manual_charge' && entry.kind === 'redeem'
							const left = charge ? -entry.amountMinor - chargeRefunded(entry.id) : 0
							return (
								<TableRow key={entry.id}>
									<TableCell>{formatGiftCardDate(entry.at, i18n.locale)}</TableCell>
									<TableCell>
										{charge ? t`Charged from the App` : _(GIFT_CARD_KIND_LABELS[entry.kind])}
										<span className="text-muted-foreground ms-2 text-xs">
											{GIFT_CARD_CHANNEL_LABELS[entry.channel] ? _(GIFT_CARD_CHANNEL_LABELS[entry.channel]!) : null}
										</span>
									</TableCell>
									<TableCell>{entry.locationId ? (locations[entry.locationId] ?? '—') : '—'}</TableCell>
									<TableCell className="max-w-xs wrap-anywhere">
										{[entry.actorName, entry.reason, entry.note].filter(Boolean).join(' · ') || '—'}
									</TableCell>
									<TableCell className="text-end tabular-nums">
										{entry.kind === 'event' ? '—' : money(entry.amountMinor)}
										{charge && left > 0 && nav.canCharge ? (
											<Button
												variant="link"
												size="sm"
												onClick={() => setDialog({ refund: entry.id, max: left })}
											>
												<Trans>Refund</Trans>
											</Button>
										) : null}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</section>

			{people.purchaserName || people.recipientName || people.purchaserEmail || people.recipientEmail ? (
				<section className="grid gap-1 text-sm">
					<h3 className="font-medium"><Trans>Buyer and recipient</Trans></h3>
					<p className="text-muted-foreground">
						{[people.purchaserName, people.purchaserEmail].filter(Boolean).join(' · ')}
					</p>
					<p>
						{[people.recipientName, people.recipientEmail].filter(Boolean).join(' · ')}
					</p>
					{people.message ? <p className="wrap-anywhere italic">{people.message}</p> : null}
				</section>
			) : null}

			{dialog === 'adjust' ? (
				<AdjustDialog client={client} card={card} open onOpenChange={(open) => !open && setDialog(null)} onDone={refresh} />
			) : null}
			{dialog === 'void' ? (
				<VoidDialog client={client} card={card} open onOpenChange={(open) => !open && setDialog(null)} onDone={refresh} />
			) : null}
			{dialog === 'charge' ? (
				<ChargeDialog client={client} card={card} open onOpenChange={(open) => !open && setDialog(null)} onDone={refresh} />
			) : null}
			{dialog && typeof dialog === 'object' ? (
				<RefundChargeDialog
					client={client}
					card={card}
					chargeId={dialog.refund}
					maxMinor={dialog.max}
					open
					onOpenChange={(open) => !open && setDialog(null)}
					onDone={refresh}
				/>
			) : null}
		</div>
	)
}
