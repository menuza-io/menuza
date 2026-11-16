import { Trans, useLingui } from '@lingui/react/macro'
import { useLingui as useLinguiRuntime } from '@lingui/react'
import { GIFT_CARD_STATUSES, type GiftCardStatus } from '@repo/common/gift-cards'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	ChargeDialog,
	useGiftCardErrorText,
} from '#app/components/gift-cards/gift-card-dialogs.tsx'
import { useGiftCardClient } from '#app/components/gift-cards/gift-card-client-provider.tsx'
import { TextField } from '#app/components/staff/controls.tsx'
import { type GiftCardSummary } from '#app/utils/gift-cards/gift-card-client.ts'
import {
	formatGiftCardDate,
	formatGiftCardMoney,
	GIFT_CARD_STATUS_LABELS,
} from '#app/utils/gift-cards/labels.ts'
import { useGiftCardLayout } from './_layout.tsx'

/**
 * The cards: last four, balance, status, issued and last used. Read straight
 * from the region with a short-lived token (the App server never sees a card).
 * `?needsReview=true` is the review queue for held purchases.
 */
export default function GiftCardsIndex() {
	const { orgSlug, nav, locations } = useGiftCardLayout()
	const client = useGiftCardClient()
	const errorText = useGiftCardErrorText()
	const { t, i18n } = useLingui()
	const { _ } = useLinguiRuntime()
	const [params, setParams] = useSearchParams()
	const needsReview = params.get('needsReview') === 'true'
	const statusParam = params.get('status')
	const status = (GIFT_CARD_STATUSES as readonly string[]).includes(statusParam ?? '')
		? (statusParam as GiftCardStatus)
		: undefined
	const [last4, setLast4] = useState(params.get('last4') ?? '')
	const [cards, setCards] = useState<GiftCardSummary[] | null>(null)
	const [next, setNext] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [charging, setCharging] = useState(false)
	const [version, setVersion] = useState(0)

	const load = useCallback(
		async (before?: number) => {
			try {
				const result = await client.list({
					status,
					needsReview,
					last4: params.get('last4') ?? undefined,
					before,
				})
				setCards((current) => (before && current ? [...current, ...result.cards] : result.cards))
				setNext(result.next)
				setError(null)
			} catch (caught) {
				setError(errorText(caught))
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[client, status, needsReview, params, version],
	)
	useEffect(() => {
		setCards(null)
		void load()
	}, [load])

	function applyFilters(event: React.FormEvent) {
		event.preventDefault()
		const nextParams = new URLSearchParams(params)
		if (last4.trim()) nextParams.set('last4', last4.trim())
		else nextParams.delete('last4')
		setParams(nextParams)
	}

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-end gap-3">
				<form onSubmit={applyFilters} className="flex items-end gap-2">
					<TextField
						label={t`Last four characters`}
						value={last4}
						onChange={(event) => setLast4(event.target.value)}
						maxLength={4}
						autoComplete="off"
					/>
					<Button type="submit" variant="outline">
						<Trans>Find</Trans>
					</Button>
				</form>
				<div className="flex flex-wrap gap-2" role="group" aria-label={t`Status`}>
					{(['', 'active', 'held', 'frozen', 'voided'] as const).map((value) => (
						<Button
							key={value || 'all'}
							variant={(status ?? '') === value ? 'default' : 'outline'}
							size="sm"
							onClick={() => {
								const nextParams = new URLSearchParams(params)
								if (value) nextParams.set('status', value)
								else nextParams.delete('status')
								setParams(nextParams)
							}}
						>
							{value ? _(GIFT_CARD_STATUS_LABELS[value]) : t`All`}
						</Button>
					))}
				</div>
				{nav.canCharge ? (
					<Button className="ms-auto" onClick={() => setCharging(true)}>
						<Trans>Charge card</Trans>
					</Button>
				) : null}
			</div>

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}

			{cards && cards.length === 0 ? (
				<EmptyState
					title={needsReview ? t`Nothing needs review` : t`No gift cards yet`}
					description={
						needsReview
							? t`Purchases the payment provider flags as higher risk wait here until you approve them or refund the buyer.`
							: t`Cards appear here once a guest buys one online or you sell one at the till.`
					}
					icons={['credit-card', 'file-text', 'check-circle']}
				/>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead><Trans>Card</Trans></TableHead>
							<TableHead><Trans>Status</Trans></TableHead>
							<TableHead className="text-end"><Trans>Balance</Trans></TableHead>
							<TableHead><Trans>Issued</Trans></TableHead>
							<TableHead><Trans>Last used</Trans></TableHead>
							<TableHead><Trans>Location</Trans></TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{(cards ?? []).map((card) => (
							<TableRow key={card.id}>
								<TableCell>
									<Link
										className="font-medium underline-offset-2 hover:underline"
										to={`/${orgSlug}/gift-cards/${card.id}`}
									>
										{'••••'} {card.last4}
									</Link>
									{card.imported ? (
										<span className="text-muted-foreground ms-2 text-xs">
											<Trans>Imported</Trans>
										</span>
									) : null}
								</TableCell>
								<TableCell>
									<Badge variant={card.status === 'active' ? 'default' : 'secondary'}>
										{_(GIFT_CARD_STATUS_LABELS[card.status])}
									</Badge>
								</TableCell>
								<TableCell className="text-end tabular-nums">
									{formatGiftCardMoney(card.balanceMinor, card.currency, i18n.locale)}
								</TableCell>
								<TableCell>{formatGiftCardDate(card.createdAt, i18n.locale)}</TableCell>
								<TableCell>{formatGiftCardDate(card.lastUsedAt, i18n.locale)}</TableCell>
								<TableCell>{card.locationId ? (locations[card.locationId] ?? '—') : '—'}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			{cards === null && !error ? (
				<p className="text-muted-foreground text-sm"><Trans>Loading cards…</Trans></p>
			) : null}
			{next ? (
				<Button variant="outline" onClick={() => void load(next)}>
					<Trans>Show more</Trans>
				</Button>
			) : null}

			{nav.canCharge ? (
				<ChargeDialog
					client={client}
					open={charging}
					onOpenChange={setCharging}
					onDone={() => setVersion((value) => value + 1)}
				/>
			) : null}
		</div>
	)
}
