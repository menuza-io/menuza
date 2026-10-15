import { Trans } from '@lingui/macro'
import { Card, CardContent } from '@repo/ui/card'
import { type NotesSummary } from '#app/utils/dashboards/block-data.server.ts'

function Divider() {
	return <div aria-hidden="true" className="bg-border h-4 w-px" />
}

function StatsBody({ notes }: { notes: NotesSummary }) {
	const { total: totalNotes, avgPerDay, trend } = notes
	return (
		<>
			<div className="text-muted-foreground">
				<Trans>{totalNotes} total notes</Trans>
			</div>
			<Divider />
			<div className="text-muted-foreground">
				<Trans>{avgPerDay} avg per day</Trans>
			</div>
			<Divider />
			<div className="flex items-center gap-1">
				{trend >= 0 ? (
					<span className="text-primary font-medium">
						<Trans>+{trend}%</Trans>
					</span>
				) : (
					<span className="font-medium text-red-600 dark:text-red-400">
						<Trans>{trend}%</Trans>
					</span>
				)}
				<span className="text-muted-foreground">
					<Trans>trending</Trans>
				</span>
			</div>
		</>
	)
}

export function StatsBlock({
	notes,
	variant = 'inline',
}: {
	notes: NotesSummary
	/** Inline stats sit flush in the dashboard grid without a nested card. */
	variant?: 'inline' | 'card'
}) {
	if (variant === 'inline') {
		return (
			<div className="flex h-full flex-wrap items-center gap-3 px-1 text-[13px]">
				<StatsBody notes={notes} />
			</div>
		)
	}
	return (
		<Card className="h-full justify-center">
			<CardContent className="flex flex-wrap items-center gap-3">
				<StatsBody notes={notes} />
			</CardContent>
		</Card>
	)
}
