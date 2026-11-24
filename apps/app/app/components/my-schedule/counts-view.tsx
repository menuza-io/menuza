import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { type MyCounts } from '#app/utils/my-schedule/my-schedule-api.ts'

/**
 * The stock counts on the weekly count plan that are this person's to do
 * (#491): what to count, when it is due, and whether it is late. They start
 * the count on the Station tablet after their PIN, where the same list shows.
 */
export function CountsView({
	counts,
	locale,
}: {
	counts: MyCounts | null
	locale: string
}) {
	const { _ } = useLingui()
	const runs = counts?.counts ?? []
	if (runs.length === 0) return null
	const day = (iso: string) => {
		const [year, month, dayOfMonth] = iso.split('-').map(Number) as [
			number,
			number,
			number,
		]
		return new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(new Date(year, month - 1, dayOfMonth))
	}
	const time = (at: number) =>
		new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(at))
	return (
		<section
			className="flex flex-col gap-2"
			aria-label={_(t`Counts for you`)}
			data-testid="my-counts"
		>
			<h2 className="text-base font-semibold">
				<Trans>Counts for you</Trans>
			</h2>
			<ItemGroup>
				{runs.map((run) => {
					const listName = run.listName ?? ''
					return (
						<Item
							key={run.id}
							variant="outline"
							data-testid={`my-count-${run.id}`}
						>
							<Icon name="list" className="size-5 shrink-0" />
							<ItemContent>
								<ItemTitle className="wrap-anywhere">
									{run.listName ? (
										<Trans>Count of {listName}</Trans>
									) : run.kind === 'quick' ? (
										<Trans>Quick count of key items</Trans>
									) : (
										<Trans>Full count</Trans>
									)}
								</ItemTitle>
								<ItemDescription>
									{day(run.date)}, <bdi dir="ltr">{time(run.dueAt)}</bdi>
									{run.status === 'started'
										? ` · ${_(t`Started`)}`
										: run.late
											? ` · ${_(t`Late`)}`
											: ''}
								</ItemDescription>
							</ItemContent>
						</Item>
					)
				})}
			</ItemGroup>
		</section>
	)
}
