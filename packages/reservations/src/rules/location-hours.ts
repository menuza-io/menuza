/**
 * Re-exports the shared opening-hours module. Reservation-only helpers live in
 * `reservation-effective-day.ts`.
 */
export * from '@repo/opening-hours'
export {
	buildEffectiveDay,
	describeLocationClosedReason,
	type EffectiveDay,
	type EffectiveDayClosedReason,
	type EffectiveDaySource,
	type ReservationDayInput,
} from './reservation-effective-day.ts'
