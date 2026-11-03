import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { type ReactNode, useMemo } from 'react'
import {
	type DiscountChoiceCatalog,
	type EditorState,
} from '#app/utils/discounts/editor-model.ts'
import { buildDiscountSummary } from '#app/utils/discounts/summary.ts'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'

/** The form section each summary line is set in. */
const ROW_SECTION: Record<string, string> = {
	how: 'discount-section-basics',
	tiers: 'discount-section-basics',
	cap: 'discount-section-basics',
	fee: 'discount-section-basics',
	covers: 'discount-section-target',
	require: 'discount-section-target',
	exclude: 'discount-section-target',
	rule: 'discount-section-quantity',
	units: 'discount-section-quantity',
	when: 'discount-section-when',
	where: 'discount-section-where',
	drops: 'discount-section-where',
	who: 'discount-section-who',
	perCustomer: 'discount-section-who',
	combine: 'discount-section-options',
}

/**
 * The discount in plain words, beside the form. It follows every change, and
 * it reads a half-filled form too, so an operator can check the sentence a
 * customer would get before there is anything valid to save.
 *
 * Each line is also the way to the section that sets it: on a long form the
 * summary is the map, so it marks the section on screen and the ones a failed
 * save points at.
 */
export function DiscountSummary({
	state,
	currency,
	catalog,
	choices,
	locations,
	defaultLocale,
	activeSection = null,
	errorSections,
	onNavigate,
	footer,
}: {
	state: EditorState
	currency: string
	catalog: LoyaltyCatalog
	choices: DiscountChoiceCatalog
	locations: Array<{ id: string; name: string }>
	/** The website's default language: the title is the name in it. */
	defaultLocale: string
	/** The section in view, whose lines are marked. */
	activeSection?: string | null
	/** Sections holding a field with an error. */
	errorSections?: ReadonlySet<string>
	/** Moves to a section; without it the lines are plain text. */
	onNavigate?: (sectionId: string) => void
	/** Who made it and what changed since. */
	footer?: ReactNode
}) {
	const { i18n } = useLingui()
	const summary = useMemo(
		() =>
			buildDiscountSummary({
				state,
				currency,
				locale: i18n.locale,
				defaultLocale,
				catalog,
				choices,
				locations,
				tx: (descriptor) => i18n._(descriptor),
			}),
		[state, currency, catalog, choices, locations, defaultLocale, i18n],
	)

	return (
		<Frame
			className="w-full"
			role="group"
			aria-labelledby="discount-section-summary-title"
			id="discount-section-summary"
		>
			<FrameHeader>
				<FrameTitle id="discount-section-summary-title" className="text-base">
					<Trans>Summary</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						What this discount does, in plain words. It updates as you type.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="flex flex-col gap-4">
				<div className="flex flex-col gap-0.5">
					<p className="text-base font-medium text-pretty wrap-anywhere">
						{summary.title}
					</p>
					<p className="text-foreground text-lg font-semibold tracking-tight text-pretty tabular-nums">
						{summary.headline}
					</p>
				</div>
				<ul className="-mx-2 flex flex-col">
					{summary.rows.map((row) => {
						const section = ROW_SECTION[row.key]
						const active = section !== undefined && section === activeSection
						const hasError =
							section !== undefined && (errorSections?.has(section) ?? false)
						const body = (
							<>
								<span
									className={cn(
										'flex items-center gap-1.5 text-xs font-medium',
										hasError ? 'text-destructive' : 'text-muted-foreground',
									)}
								>
									{hasError ? (
										<span
											aria-hidden
											className="bg-destructive size-1.5 shrink-0 rounded-full"
										/>
									) : null}
									{row.label}
									{hasError ? (
										<span className="sr-only">
											<Trans>(has an error)</Trans>
										</span>
									) : null}
								</span>
								<span className="text-sm text-pretty wrap-anywhere">
									{row.value}
								</span>
							</>
						)
						return (
							<li key={row.key}>
								{section && onNavigate ? (
									<a
										href={`#${section}`}
										aria-current={active ? 'location' : undefined}
										onClick={(event) => {
											event.preventDefault()
											onNavigate(section)
										}}
										className={cn(
											'hover:bg-muted/60 focus-visible:ring-ring/50 relative flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors outline-none focus-visible:ring-2',
											active && 'bg-muted',
										)}
									>
										{body}
									</a>
								) : (
									<div className="flex flex-col gap-0.5 px-2 py-1.5">
										{body}
									</div>
								)}
							</li>
						)
					})}
				</ul>
			</FramePanel>
			{footer ? (
				<FramePanel className="text-muted-foreground flex flex-col gap-2 py-3 text-xs">
					{footer}
				</FramePanel>
			) : null}
		</Frame>
	)
}
