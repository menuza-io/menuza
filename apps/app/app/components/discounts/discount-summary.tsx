import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo } from 'react'
import {
	type DiscountChoiceCatalog,
	type EditorState,
} from '#app/utils/discounts/editor-model.ts'
import { buildDiscountSummary } from '#app/utils/discounts/summary.ts'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { EditorSection } from './fields.tsx'

/**
 * The discount in plain words, beside the form. It follows every change, and
 * it reads a half-filled form too, so an operator can check the sentence a
 * customer would get before there is anything valid to save.
 */
export function DiscountSummary({
	state,
	currency,
	catalog,
	choices,
	locations,
}: {
	state: EditorState
	currency: string
	catalog: LoyaltyCatalog
	choices: DiscountChoiceCatalog
	locations: Array<{ id: string; name: string }>
}) {
	const { i18n } = useLingui()
	const summary = useMemo(
		() =>
			buildDiscountSummary({
				state,
				currency,
				locale: i18n.locale,
				catalog,
				choices,
				locations,
				tx: (descriptor) => i18n._(descriptor),
			}),
		[state, currency, catalog, choices, locations, i18n],
	)

	return (
		<EditorSection
			id="discount-section-summary"
			title={<Trans>Summary</Trans>}
			description={
				<Trans>
					What this discount does, in plain words. It updates as you type.
				</Trans>
			}
		>
			<div className="flex flex-col gap-1">
				<p className="text-base font-medium text-pretty wrap-anywhere">
					{summary.title}
				</p>
				<p className="text-muted-foreground text-sm text-pretty">
					{summary.headline}
				</p>
			</div>
			<dl className="flex flex-col gap-3">
				{summary.rows.map((row) => (
					<div key={row.key} className="flex flex-col gap-0.5">
						<dt className="text-muted-foreground text-xs font-medium">
							{row.label}
						</dt>
						<dd className="text-sm text-pretty wrap-anywhere">{row.value}</dd>
					</div>
				))}
			</dl>
		</EditorSection>
	)
}
