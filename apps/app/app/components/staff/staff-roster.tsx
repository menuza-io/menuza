import { Trans, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Frame } from '@repo/ui/frame'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Link, useNavigate } from 'react-router'
import { type OnboardingSummaryRow } from '#app/utils/staffing/onboarding-types.ts'
import {
	rosterOnboarding,
	type RosterOnboarding,
} from '#app/utils/staffing/onboarding-view.ts'
import {
	formatMoneyMinor,
	staffDisplayName,
} from '#app/utils/staffing/staff-format.ts'
import {
	type CurrentRate,
	type StaffListRow,
	type StaffPositionRow,
} from '#app/utils/staffing/staff-types.ts'
import { EmptyValue } from './empty-value.tsx'
import { OnboardingBadge } from './onboarding/onboarding-badge.tsx'
import { PositionChips } from './position-chips.tsx'
import { StaffAvatar } from './staff-avatar.tsx'
import { StaffStatusLabel } from './staff-status.tsx'

export type RosterScope = { id: string; name: string }

type RosterProps = {
	rows: readonly StaffListRow[]
	positions: ReadonlyMap<string, StaffPositionRow>
	scopes: ReadonlyMap<string, RosterScope>
	/** Add the pay column. Only true when the token carries the pay grant. */
	showPay: boolean
	/** Base path of the profile route, for example `/acme/staff/team`. */
	basePath: string
	/**
	 * Onboarding progress by person. Present only while Hiring is on and the
	 * member can read it; the roster shows no onboarding column otherwise.
	 */
	onboarding?: ReadonlyMap<string, OnboardingSummaryRow>
	/** The manager's calendar day, to tell which tasks are late. */
	today?: string
}

function scopeSummary(
	row: StaffListRow,
	scopes: ReadonlyMap<string, RosterScope>,
): string | null {
	const active = row.assignments.filter((assignment) => assignment.active)
	if (active.length === 0) return null
	const primary =
		active.find((assignment) => assignment.isPrimary) ?? active[0]!
	const name = scopes.get(primary.scopeId)?.name
	if (!name) return null
	const others = active.length - 1
	if (others === 0) return name
	const more = plural(others, { one: '+# more', other: '+# more' })
	return `${name} ${more}`
}

/** `$16.50/h` or `$52,000/yr`, from the rate the API returned for this token. */
export function PayCell({
	rate,
	locale,
}: {
	rate: CurrentRate | null | undefined
	locale: string
}) {
	if (!rate) return <EmptyValue />
	if (rate.payType === 'salary' && rate.annualSalaryMinor !== null) {
		const amount = formatMoneyMinor(
			rate.annualSalaryMinor,
			rate.currency,
			locale,
		)
		return (
			<span className="tabular-nums">
				<Trans>{amount}/yr</Trans>
			</span>
		)
	}
	if (rate.rateMinor === null) return <EmptyValue />
	const amount = formatMoneyMinor(rate.rateMinor, rate.currency, locale)
	return (
		<span className="tabular-nums">
			<Trans>{amount}/h</Trans>
		</span>
	)
}

/**
 * The roster: a quiet table from `md` up, and a stacked list below it. The name
 * is a real link, so keyboard and screen-reader users reach a profile the same
 * way a mouse user does; the rest of the row is a larger click target.
 */
export function StaffRoster({
	rows,
	positions,
	scopes,
	showPay,
	basePath,
	onboarding,
	today = '',
}: RosterProps) {
	const { i18n } = useLingui()
	const navigate = useNavigate()
	const locale = i18n.locale
	const progressOf = (id: string): RosterOnboarding =>
		onboarding ? rosterOnboarding(onboarding.get(id), today) : { kind: 'none' }

	return (
		<>
			<Frame className="hidden w-full md:flex">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Name</Trans>
							</TableHead>
							<TableHead>
								<Trans>Positions</Trans>
							</TableHead>
							<TableHead>
								<Trans>Workplace</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
							{showPay ? (
								<TableHead className="text-end">
									<Trans>Pay</Trans>
								</TableHead>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => {
							const name = staffDisplayName(row, locale)
							return (
								<TableRow
									key={row.id}
									className="cursor-pointer"
									onClick={() => void navigate(`${basePath}/${row.id}`)}
								>
									<TableCell>
										<div className="flex items-center gap-3">
											<StaffAvatar name={name} />
											<div className="flex min-w-0 flex-col">
												<Link
													to={`${basePath}/${row.id}`}
													className="focus-visible:ring-ring/50 block truncate rounded-sm pe-0.5 font-medium outline-none focus-visible:ring-3"
													onClick={(event) => event.stopPropagation()}
												>
													{name}
												</Link>
												<span className="text-muted-foreground truncate text-xs">
													<bdi dir="ltr">{row.email ?? row.phone ?? ''}</bdi>
												</span>
											</div>
										</div>
									</TableCell>
									<TableCell>
										<PositionChips
											ids={row.positionIds}
											positions={positions}
										/>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{scopeSummary(row, scopes) ?? <EmptyValue />}
									</TableCell>
									<TableCell>
										<div className="flex flex-col items-start gap-1">
											<StaffStatusLabel status={row.status} />
											<OnboardingBadge progress={progressOf(row.id)} />
										</div>
									</TableCell>
									{showPay ? (
										<TableCell className="text-end">
											<PayCell rate={row.currentRate} locale={locale} />
										</TableCell>
									) : null}
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</Frame>

			<ItemGroup className="md:hidden">
				{rows.map((row) => {
					const name = staffDisplayName(row, locale)
					return (
						<Item
							key={row.id}
							variant="outline"
							render={<Link to={`${basePath}/${row.id}`} />}
						>
							<ItemMedia>
								<StaffAvatar name={name} />
							</ItemMedia>
							<ItemContent>
								<ItemTitle>{name}</ItemTitle>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<PositionChips
										ids={row.positionIds}
										positions={positions}
										max={1}
									/>
									<span className="text-muted-foreground truncate text-xs">
										{scopeSummary(row, scopes) ?? <EmptyValue />}
									</span>
								</div>
								<OnboardingBadge progress={progressOf(row.id)} />
							</ItemContent>
							<ItemActions>
								{showPay ? (
									<span className="text-muted-foreground text-sm tabular-nums">
										<PayCell rate={row.currentRate} locale={locale} />
									</span>
								) : null}
								{row.status !== 'active' ? (
									<StaffStatusLabel status={row.status} />
								) : null}
							</ItemActions>
						</Item>
					)
				})}
			</ItemGroup>
		</>
	)
}

export function StaffRosterSkeleton({ showPay }: { showPay: boolean }) {
	return (
		<div role="status" aria-live="polite" className="flex flex-col gap-3">
			<span className="sr-only">
				<Trans>Loading team</Trans>
			</span>
			{Array.from({ length: 6 }).map((_, index) => (
				<div key={index} className="flex items-center gap-3 py-1">
					<Skeleton className="size-8 rounded-full" />
					<Skeleton className="h-4 w-40" />
					<Skeleton className="ms-auto hidden h-4 w-24 md:block" />
					{showPay ? <Skeleton className="hidden h-4 w-16 md:block" /> : null}
				</div>
			))}
		</div>
	)
}
