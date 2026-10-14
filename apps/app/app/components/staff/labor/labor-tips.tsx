import { Trans, plural } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Item, ItemContent, ItemGroup } from '@repo/ui/item'
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	type TipPerson,
	type TipPool,
	type TipReport,
} from '#app/utils/staffing/labor-types.ts'
import { formatShare, hoursOf } from '#app/utils/staffing/labor-view.ts'
import {
	staffDisplayName,
	formatMoneyMinor,
} from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'

/**
 * The tip-pool report: where the pool came from, then each person's share.
 * It is a report to help a manager divide tips, and says so; it pays nobody.
 * Pools of different currencies are listed apart and never added.
 */
export function LaborTips({
	report,
	locale,
	canEditSettings,
	onEditRules,
}: {
	report: TipReport
	locale: string
	canEditSettings: boolean
	onEditRules: () => void
}) {
	const { settings } = report
	const ineligibleHours = hoursOf(report.ineligibleMinutes, locale)
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1">
				<p className="text-sm text-pretty">
					<RulesSummary report={report} locale={locale} />{' '}
					{canEditSettings ? (
						<Button
							variant="link"
							className="h-auto p-0 align-baseline"
							onClick={onEditRules}
						>
							<Trans>Change rules</Trans>
						</Button>
					) : null}
				</p>
				{!settings.configured ? (
					<p className="text-muted-foreground text-sm text-pretty">
						<Trans>
							No rules are saved for this workplace yet, so the defaults are
							used. Delivery tips stay out until you choose to pool them.
						</Trans>
					</p>
				) : null}
			</div>

			{report.pools.length === 0 ? (
				<EmptyState
					title={
						<>
							<Trans>No tips to divide in this range</Trans>
						</>
					}
					description={
						<>
							<Trans>
								Tips on online orders and cash tips people declare on their time
								cards appear here once there are some.
							</Trans>
						</>
					}
					icons={['users', 'clock', 'calendar']}
				/>
			) : (
				report.pools.map((pool) => (
					<PoolSection
						key={pool.currency}
						pool={pool}
						locale={locale}
						daily={settings.cadence === 'daily'}
						showCurrency={report.pools.length > 1}
					/>
				))
			)}

			<ul className="text-muted-foreground flex flex-col gap-1 text-xs text-pretty">
				<li>
					<Trans>
						This is a report to help you divide tips. It does not pay anyone,
						and whether online tips may be pooled depends on where you operate.
					</Trans>
				</li>
				{report.openCards > 0 ? (
					<li>
						{plural(report.openCards, {
							one: '# card is still open and is not counted yet.',
							other: '# cards are still open and are not counted yet.',
						})}
					</li>
				) : null}
				{report.unapprovedCards > 0 ? (
					<li>
						{plural(report.unapprovedCards, {
							one: '# card is not approved yet, so its hours could still change.',
							other:
								'# cards are not approved yet, so their hours could still change.',
						})}
					</li>
				) : null}
				{report.ineligibleMinutes > 0 ? (
					<li>
						<Trans>
							{ineligibleHours} hours were worked in positions that do not earn
							tips and are not in the split.
						</Trans>
					</li>
				) : null}
				{report.undeclaredCurrencyCashTips > 0 ? (
					<li>
						{plural(report.undeclaredCurrencyCashTips, {
							one: '# card has cash tips but no pay rate, so they are left out.',
							other:
								'# cards have cash tips but no pay rate, so they are left out.',
						})}
					</li>
				) : null}
				{report.truncated ? (
					<li>
						<Trans>
							This range has more cards than can be added up here. Choose a
							shorter range.
						</Trans>
					</li>
				) : null}
			</ul>
		</div>
	)
}

function RulesSummary({
	report,
	locale,
}: {
	report: TipReport
	locale: string
}) {
	const { settings } = report
	const fee = formatShare(settings.cardFeeBp, locale)
	const split =
		settings.splitBasis === 'hours' ? (
			<Trans>Split by hours worked</Trans>
		) : (
			<Trans>Split by position percentage</Trans>
		)
	const cadence =
		settings.cadence === 'daily' ? (
			<Trans>each day on its own</Trans>
		) : (
			<Trans>over the whole range</Trans>
		)
	const orders =
		settings.fulfillment.length === 0 ? (
			<Trans>no online order tips</Trans>
		) : settings.fulfillment.length === 2 ? (
			<Trans>pickup and delivery tips</Trans>
		) : settings.fulfillment[0] === 'pickup' ? (
			<Trans>pickup tips</Trans>
		) : (
			<Trans>delivery tips</Trans>
		)
	return (
		<span className="font-medium">
			{split}
			{' · '}
			{cadence}
			{' · '}
			<Trans>Card fee {fee}</Trans>
			{' · '}
			{orders}
		</span>
	)
}

function PoolSection({
	pool,
	locale,
	daily,
	showCurrency,
}: {
	pool: TipPool
	locale: string
	daily: boolean
	showCurrency: boolean
}) {
	const money = (minor: number) =>
		formatMoneyMinor(minor, pool.currency, locale)
	return (
		<section className="flex flex-col gap-3">
			{showCurrency ? (
				<h3 className="text-muted-foreground text-xs font-medium">
					{pool.currency}
				</h3>
			) : null}
			<dl className="border-border grid grid-cols-2 gap-x-6 gap-y-3 border-y py-3 md:grid-cols-5">
				<Line term={<Trans>Online order tips</Trans>}>
					{money(pool.onlineTipsMinor)}
				</Line>
				<Line term={<Trans>Card fee withheld</Trans>}>
					{pool.cardFeeMinor > 0 ? `−${money(pool.cardFeeMinor)}` : money(0)}
				</Line>
				<Line term={<Trans>Declared cash tips</Trans>}>
					{money(pool.cashTipsMinor)}
				</Line>
				<Line term={<Trans>To divide</Trans>} strong>
					{money(pool.poolMinor)}
				</Line>
				{pool.unallocatedMinor > 0 ? (
					<Line term={<Trans>Not allocated</Trans>}>
						{money(pool.unallocatedMinor)}
					</Line>
				) : null}
			</dl>

			{pool.people.length > 0 ? (
				<Table>
					<TableCaption className="sr-only">
						<Trans>Tip shares</Trans>
					</TableCaption>
					<TableHeader>
						<TableRow>
							<TableHead className="text-start">
								<Trans>Person</Trans>
							</TableHead>
							<TableHead className="text-end">
								<Trans>Hours</Trans>
							</TableHead>
							<TableHead className="text-end">
								<Trans>Share</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{pool.people.map((person) => (
							<TableRow key={person.staffId}>
								<TableCell>{nameOf(person, locale)}</TableCell>
								<TableCell className="text-end tabular-nums">
									{hoursOf(person.minutes, locale)}
								</TableCell>
								<TableCell className="text-end tabular-nums">
									{money(person.shareMinor)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
					<TableFooter>
						<TableRow>
							<TableCell className="font-medium">
								<Trans>Total</Trans>
							</TableCell>
							<TableCell className="text-end font-medium tabular-nums">
								{hoursOf(
									pool.people.reduce((sum, p) => sum + p.minutes, 0),
									locale,
								)}
							</TableCell>
							<TableCell className="text-end font-medium tabular-nums">
								{money(pool.people.reduce((sum, p) => sum + p.shareMinor, 0))}
							</TableCell>
						</TableRow>
					</TableFooter>
				</Table>
			) : null}

			{daily && pool.groups.length > 1 ? (
				<Collapsible>
					<CollapsibleTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								className="text-muted-foreground h-auto min-h-11 justify-start px-0 md:min-h-8"
							/>
						}
					>
						<Trans>Pool by day</Trans>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ItemGroup className="gap-1">
							{pool.groups.map((group) => (
								<Item key={group.key} variant="outline" size="sm">
									<ItemContent>
										<div className="flex items-baseline justify-between gap-3">
											<span>{formatDateLabel(group.key, locale)}</span>
											<span className="tabular-nums">
												{money(group.poolMinor)}
											</span>
										</div>
									</ItemContent>
								</Item>
							))}
						</ItemGroup>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</section>
	)
}

function Line({
	term,
	children,
	strong,
}: {
	term: React.ReactNode
	children: React.ReactNode
	strong?: boolean
}) {
	return (
		<div className="min-w-0">
			<dt className="text-muted-foreground text-xs">{term}</dt>
			<dd
				className={
					strong
						? 'text-base font-semibold tabular-nums'
						: 'text-base font-medium tabular-nums'
				}
			>
				{children}
			</dd>
		</div>
	)
}

function nameOf(person: TipPerson, locale: string): string {
	return staffDisplayName(
		{
			firstName: person.firstName,
			lastName: person.lastName,
			firstNameAr: person.firstNameAr,
			lastNameAr: person.lastNameAr,
		},
		locale,
	)
}
