/**
 * Guest-facing discount text (name, description) is edited in every website
 * language with the same fields Reservations uses. Neutral names here so the
 * discount editor does not read as if it belonged to Reservations.
 */
export {
	LocalizedMapInput,
	LocalizedMapTextarea,
	ReservationLocaleProvider as ContentLocaleProvider,
	useActiveLocale,
	WritingLanguageNote,
} from '#app/components/reservations/localized-fields.tsx'
