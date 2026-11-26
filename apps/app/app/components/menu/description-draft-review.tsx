import { Trans } from '@lingui/macro'
import { type DescriptionDraft } from '#app/utils/menu/description-drafts.ts'

/**
 * Editable drafts before anything is saved (#401). Existing descriptions
 * are shown as kept and are not fields the operator can apply.
 */
export function DescriptionDraftReview({
	drafts,
	selected,
	onToggle,
	onChange,
}: {
	drafts: readonly DescriptionDraft[]
	selected: ReadonlySet<string>
	onToggle: (itemId: string, on: boolean) => void
	onChange: (itemId: string, locale: 'en' | 'ar', value: string) => void
}) {
	return (
		<ul className="space-y-4">
			{drafts.map((draft) => (
				<li key={draft.itemId} className="space-y-2 rounded-md border p-3">
					<label className="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={selected.has(draft.itemId)}
							disabled={draft.unsure || draft.kept.length === 2}
							onChange={(event) =>
								onToggle(draft.itemId, event.currentTarget.checked)
							}
						/>
						{draft.name}
						{draft.unsure ? (
							<span className="text-muted-foreground font-normal">
								<Trans>Needs a description written by hand</Trans>
							</span>
						) : null}
					</label>
					<label className="block text-sm">
						<Trans>English</Trans>
						<textarea
							className="border-input mt-1 w-full rounded-md border p-2"
							dir="ltr"
							value={draft.kept.includes('en') ? '' : draft.en}
							readOnly={draft.kept.includes('en') || draft.unsure}
							aria-label={`${draft.name} English`}
							onChange={(event) =>
								onChange(draft.itemId, 'en', event.currentTarget.value)
							}
						/>
					</label>
					<label className="block text-sm">
						<Trans>Arabic</Trans>
						<textarea
							className="border-input mt-1 w-full rounded-md border p-2"
							dir="rtl"
							value={draft.kept.includes('ar') ? '' : draft.ar}
							readOnly={draft.kept.includes('ar') || draft.unsure}
							aria-label={`${draft.name} Arabic`}
							onChange={(event) =>
								onChange(draft.itemId, 'ar', event.currentTarget.value)
							}
						/>
					</label>
				</li>
			))}
		</ul>
	)
}
