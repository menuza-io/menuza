import { Trans } from '@lingui/macro'
import { Frame } from '@repo/ui/frame'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
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
import { EmptyValue } from '#app/components/staff/empty-value.tsx'
import { StaffAvatar } from '#app/components/staff/staff-avatar.tsx'
import { type ApplicantSummary } from '#app/utils/hiring/applicant-types.ts'
import { applicantName, placeLabel } from '#app/utils/hiring/applicant-view.ts'
import {
	FitLabel,
	FlagNote,
	StageDot,
	useRelativeTime,
} from './applicant-bits.tsx'
import { type ApplicantLabels } from './applicant-labels.ts'

type ListProps = {
	rows: readonly ApplicantSummary[]
	labels: ApplicantLabels
	scopeName: (scopeId: string | null) => string | null
	timeZoneOf: (scopeId: string | null) => string | null
	hrefFor: (applicant: ApplicantSummary) => string
}

/**
 * The same applicants as a table from `md` up and a stacked list below it. The
 * name is a real link, so keyboard and screen-reader users reach a candidate the
 * same way a mouse user does; the rest of the row is a larger click target.
 */
export function ApplicantList({
	rows,
	labels,
	scopeName,
	timeZoneOf,
	hrefFor,
}: ListProps) {
	const navigate = useNavigate()
	const relative = useRelativeTime()

	return (
		<>
			<Frame className="hidden w-full md:flex">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Applicant</Trans>
							</TableHead>
							<TableHead>
								<Trans>Stage</Trans>
							</TableHead>
							<TableHead>
								<Trans>Answers</Trans>
							</TableHead>
							<TableHead>
								<Trans>Applied</Trans>
							</TableHead>
							<TableHead>
								<Trans>Interview</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => {
							const name = applicantName(row)
							const place = placeLabel(row, scopeName)
							return (
								<TableRow
									key={row.id}
									className="cursor-pointer"
									onClick={() => void navigate(hrefFor(row))}
								>
									<TableCell>
										<div className="flex items-center gap-3">
											<StaffAvatar name={name} />
											<div className="flex min-w-0 flex-col">
												<Link
													to={hrefFor(row)}
													className="focus-visible:ring-ring/50 block truncate rounded-sm pe-0.5 font-medium outline-none focus-visible:ring-3"
													onClick={(event) => event.stopPropagation()}
												>
													{name}
												</Link>
												<span className="text-muted-foreground truncate text-xs">
													{[row.postingTitle, place]
														.filter(Boolean)
														.join(' · ')}
												</span>
											</div>
										</div>
									</TableCell>
									<TableCell>
										<span className="inline-flex items-center gap-2 text-sm">
											<StageDot stage={row.stage} />
											{labels.stage[row.stage]}
										</span>
									</TableCell>
									<TableCell>
										<div className="flex flex-col gap-0.5">
											<FitLabel score={row.screenerScore} labels={labels} />
											<FlagNote count={row.flagCount} />
											{row.screenerScore === null && row.flagCount === 0 ? (
												<EmptyValue />
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{relative(row.createdAt)}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{row.interviewAt !== null ? (
											labels.formatWhen(
												row.interviewAt,
												timeZoneOf(row.scopeId),
											)
										) : (
											<EmptyValue />
										)}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</Frame>

			<ItemGroup className="md:hidden">
				{rows.map((row) => {
					const name = applicantName(row)
					return (
						<Item
							key={row.id}
							variant="outline"
							render={<Link to={hrefFor(row)} />}
						>
							<ItemMedia>
								<StaffAvatar name={name} />
							</ItemMedia>
							<ItemContent>
								<ItemTitle>{name}</ItemTitle>
								<ItemDescription>
									{[row.postingTitle, placeLabel(row, scopeName)]
										.filter(Boolean)
										.join(' · ')}
								</ItemDescription>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<span className="inline-flex items-center gap-1.5 text-xs">
										<StageDot stage={row.stage} />
										{labels.stage[row.stage]}
									</span>
									<FlagNote count={row.flagCount} />
									<FitLabel score={row.screenerScore} labels={labels} />
								</div>
							</ItemContent>
							<ItemActions>
								<span className="text-muted-foreground text-xs">
									{relative(row.createdAt)}
								</span>
							</ItemActions>
						</Item>
					)
				})}
			</ItemGroup>
		</>
	)
}

export function ApplicantListSkeleton() {
	return (
		<div aria-hidden="true" className="flex flex-col gap-2">
			{Array.from({ length: 6 }, (_, index) => (
				<Skeleton key={index} className="h-14 w-full" />
			))}
		</div>
	)
}
