import { Trans, useLingui } from '@lingui/react/macro'
import { type DiscountHistoryEntry } from '#app/utils/discounts/history.server.ts'
import { formatInstantDate } from '#app/utils/people/people-view.ts'

/** The change log of one discount: who did what, newest first. */
export function DiscountHistory({
	entries,
}: {
	entries: readonly DiscountHistoryEntry[]
}) {
	const { i18n } = useLingui()
	if (entries.length === 0) return null
	return (
		<details className="text-muted-foreground border-border mx-auto w-full max-w-6xl border-b px-4 py-1.5 text-xs md:px-6 lg:px-8">
			<summary className="cursor-pointer">
				<Trans>History</Trans>
			</summary>
			<ul className="mt-2 flex flex-col gap-1.5 pb-1">
				{entries.map((entry) => (
					<li key={entry.id} className="wrap-anywhere">
						<HistoryLine entry={entry} />
						<span aria-hidden="true"> · </span>
						<span>
							{formatInstantDate(
								new Date(entry.createdAt).getTime(),
								i18n.locale,
							)}
						</span>
					</li>
				))}
			</ul>
		</details>
	)
}

function HistoryLine({ entry }: { entry: DiscountHistoryEntry }) {
	const who = entry.userName
	if (entry.kind === 'created') {
		return who ? (
			<Trans>{who} created this discount</Trans>
		) : (
			<Trans>Created</Trans>
		)
	}
	if (entry.kind === 'status') {
		if (entry.status === 'active') {
			return who ? <Trans>{who} resumed it</Trans> : <Trans>Resumed</Trans>
		}
		if (entry.status === 'paused') {
			return who ? <Trans>{who} paused it</Trans> : <Trans>Paused</Trans>
		}
		return who ? <Trans>{who} archived it</Trans> : <Trans>Archived</Trans>
	}
	const count = entry.keys.length
	if (entry.codesChanged) {
		return who ? (
			<Trans>
				{who} edited it ({count} settings and its codes)
			</Trans>
		) : (
			<Trans>Edited ({count} settings and its codes)</Trans>
		)
	}
	return who ? (
		<Trans>
			{who} edited it ({count} settings)
		</Trans>
	) : (
		<Trans>Edited ({count} settings)</Trans>
	)
}
