import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { LoyaltySheet, useUnitText } from './LoyaltySheet.tsx'
import { useLoyalty } from '~/lib/loyalty-store.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import { usePos } from '~/lib/store.ts'
import { Button } from '~/ui/primitives.tsx'

/**
 * The cart's way into rewards: "Add member" until someone is identified, then
 * who they are and what they have. Hidden on a till that is not paired (and in
 * the demo, which has no region) and once the region has said loyalty is off.
 */
export function LoyaltyRewards({ money }: { money: MoneyFormatter }) {
	const { _ } = useLingui()
	const unitText = useUnitText()
	const [open, setOpen] = useState(false)
	const paired = usePos(
		(s) =>
			!s.settings.demo &&
			Boolean(s.settings.deviceToken && s.settings.tenantApiUrl),
	)
	const member = useLoyalty((s) => s.member)
	const applied = useLoyalty((s) => s.applied)
	const waiting = useLoyalty((s) => s.waiting)
	const unavailable = useLoyalty((s) => s.unavailable)
	if (!paired || (unavailable && !member)) return null

	const name = member?.firstName ?? ''
	const balance = member
		? unitText(member.balance.available, member.unitLabel)
		: ''
	const label = member
		? name
			? _(t`${name}, ${balance}`)
			: balance
		: _(t`Add member`)

	return (
		<>
			<Button
				variant="outline"
				className="w-full justify-between"
				onClick={() => setOpen(true)}
				aria-haspopup="dialog"
			>
				<span className="flex min-w-0 items-center gap-2">
					<Icon
						name="star"
						className={member ? 'text-primary size-4' : 'size-4'}
						aria-hidden
					/>
					<span className="truncate">{label}</span>
				</span>
				{waiting ? (
					<span className="text-muted-foreground shrink-0 text-xs">
						{_(t`Waiting for approval`)}
					</span>
				) : applied ? (
					<span className="text-primary tnum shrink-0 text-xs font-semibold">
						−{money(applied.discountMinor)}
					</span>
				) : null}
			</Button>
			<LoyaltySheet open={open} onClose={() => setOpen(false)} money={money} />
		</>
	)
}
