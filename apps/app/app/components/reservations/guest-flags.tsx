import { useLingui } from '@lingui/react/macro'
import { RSV_ALLERGEN_CODES } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import {
	DIETARY_LABELS,
	enumLabel,
	OCCASION_LABELS,
	VIP_TIER_LABELS,
} from '#app/utils/reservations/labels.ts'

/**
 * The flags a host must be able to scan on a board card, list row, floor tile
 * and the overview: VIP, allergy and occasion.
 *
 * Privacy: `allergy` and coded allergens come from reservation-level data every
 * `read:reservation` token receives (`allergyFlag` / `dietaryCodes`). Free text
 * (`allergenText`) only exists when the feed carried it, which it does for a
 * guest-grant token, so a host without that grant sees "Allergy" and the coded
 * allergen, never the notes.
 */

export type GuestFlagState = {
	/** A VIP tier other than `none`, else `null`. */
	vipTier: string | null
	allergy: boolean
	/** Coded allergens, in feed order (`nut_allergy`, ...). */
	allergenCodes: string[]
	/** First free-text allergen, only when the token may read guest notes. */
	allergenText: string | null
	occasion: string | null
}

type FlagSource = Pick<
	DayReservationView,
	'hasAllergy' | 'dietaryCodes' | 'occasion'
> & {
	guest?: Pick<
		NonNullable<DayReservationView['guest']>,
		'vipTier' | 'allergyNotes'
	> | null
}

const ALLERGEN_SET = new Set<string>(RSV_ALLERGEN_CODES)

function firstSegment(text: string | null | undefined): string | null {
	const first = text?.split(/[,;\n]/)[0]?.trim()
	return first ? first : null
}

/** Pure: what the flags are for one feed reservation. */
export function deriveGuestFlags(rsv: FlagSource): GuestFlagState {
	const codes = rsv.dietaryCodes ?? []
	const allergenCodes = codes.filter((c) => ALLERGEN_SET.has(c))
	const freeText = codes.find((c) => !(c in DIETARY_LABELS))
	const tier = rsv.guest?.vipTier
	return {
		vipTier: tier && tier !== 'none' ? tier : null,
		allergy: Boolean(rsv.hasAllergy) || allergenCodes.length > 0,
		allergenCodes,
		allergenText:
			allergenCodes.length > 0
				? null
				: (firstSegment(freeText) ?? firstSegment(rsv.guest?.allergyNotes)),
		occasion: rsv.occasion || null,
	}
}

const NOT_TONIGHT = new Set(['cancelled', 'no_show', 'declined', 'expired'])

/** Parties still on tonight's book that carry an allergy flag. */
export function countAllergyParties(
	reservations: ReadonlyArray<FlagSource & Pick<DayReservationView, 'status'>>,
): number {
	return reservations.filter(
		(r) => !NOT_TONIGHT.has(r.status) && deriveGuestFlags(r).allergy,
	).length
}

export function hasGuestFlags(flags: GuestFlagState): boolean {
	return Boolean(flags.vipTier || flags.allergy || flags.occasion)
}

export type GuestFlagsProps = {
	reservation: FlagSource
	/**
	 * `full`: labelled chips (cards, rows, overview).
	 * `tight`: small icons with a title and screen-reader text (floor tiles).
	 */
	tier?: 'full' | 'tight'
	/** Occasion is quiet and skipped where space is scarce. */
	showOccasion?: boolean
	className?: string
	testIdPrefix?: string
}

export function GuestFlags({
	reservation,
	tier = 'full',
	showOccasion = true,
	className,
	testIdPrefix = 'guest-flag',
}: GuestFlagsProps) {
	const { t, i18n } = useLingui()
	const flags = deriveGuestFlags(reservation)
	if (!hasGuestFlags(flags)) return null

	const vipLabel = flags.vipTier
		? flags.vipTier === 'vip'
			? t`VIP`
			: enumLabel(i18n._.bind(i18n), VIP_TIER_LABELS, flags.vipTier)
		: null
	const firstCode = flags.allergenCodes[0]
	const extraAllergens = Math.max(flags.allergenCodes.length - 1, 0)
	const allergyName = firstCode
		? enumLabel(i18n._.bind(i18n), DIETARY_LABELS, firstCode)
		: flags.allergenText
	const allergyLabel = allergyName ?? t`Allergy`
	const allergyTitle = allergyName ? t`Allergy: ${allergyName}` : t`Allergy`
	const occasionLabel =
		showOccasion && flags.occasion
			? enumLabel(i18n._.bind(i18n), OCCASION_LABELS, flags.occasion)
			: null

	if (tier === 'tight') {
		return (
			<span
				className={cn('inline-flex items-center gap-0.5', className)}
				data-testid={`${testIdPrefix}-tight`}
			>
				{flags.allergy ? (
					<span title={allergyTitle} data-testid={`${testIdPrefix}-allergy`}>
						<Icon
							name="alert-triangle"
							className="text-destructive size-3.5"
							aria-hidden="true"
						/>
						<span className="sr-only">{allergyTitle}</span>
					</span>
				) : null}
				{vipLabel ? (
					<span title={vipLabel} data-testid={`${testIdPrefix}-vip`}>
						<Icon
							name="star"
							className="text-primary size-3.5"
							aria-hidden="true"
						/>
						<span className="sr-only">{vipLabel}</span>
					</span>
				) : null}
			</span>
		)
	}

	return (
		<span
			className={cn('flex min-w-0 flex-wrap items-start gap-1', className)}
			data-testid={`${testIdPrefix}-list`}
		>
			{flags.allergy ? (
				<span
					className="bg-destructive/10 text-destructive inline-flex max-w-full min-w-0 items-start gap-1 rounded-sm px-1.5 py-0.5 text-xs leading-snug font-medium"
					data-testid={`${testIdPrefix}-allergy`}
					title={allergyTitle}
				>
					<Icon
						name="alert-triangle"
						className="mt-px size-3.5 shrink-0"
						aria-hidden="true"
					/>
					<span className="min-w-0 break-words">
						{allergyLabel}
						{extraAllergens > 0 ? (
							<span className="ms-1 tabular-nums">+{extraAllergens}</span>
						) : null}
					</span>
				</span>
			) : null}
			{vipLabel ? (
				<span
					className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs leading-snug font-medium"
					data-testid={`${testIdPrefix}-vip`}
				>
					<Icon name="star" className="size-3.5 shrink-0" aria-hidden="true" />
					{vipLabel}
				</span>
			) : null}
			{occasionLabel ? (
				<span
					className="bg-muted text-muted-foreground inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs leading-snug"
					data-testid={`${testIdPrefix}-occasion`}
				>
					{occasionLabel}
				</span>
			) : null}
		</span>
	)
}
