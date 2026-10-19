import { type ConfigValidationIssueCode } from '@repo/reservations'

/**
 * The settings tab (a route under `reservations/settings`) where a setup
 * diagnostics issue is fixed, or `null` when the fix is on the Booking rules
 * page that lists it, so no link is needed. Keyed by the exact issue code; the
 * test keeps this in step with the tabs in `settings.tsx`.
 */
export type SetupIssueTab =
	| 'services'
	| 'special-days'
	| 'tables'
	| 'sections'
	| 'floor-plan'
	| 'messages'
	| 'waitlist'
	| 'policies'

const TARGETS: Record<ConfigValidationIssueCode, SetupIssueTab | null> = {
	// Booking rules page (general settings, including the advanced pacing caps).
	invalid_interval_min: null,
	invalid_horizon_days: null,
	invalid_party_bounds: null,
	pacing_cap_below_min_party: null,
	// Floor group: tables, areas and table combinations.
	duplicate_table_label: 'tables',
	invalid_table_seats: 'tables',
	unseatable_party_size: 'tables',
	combination_too_few_members: 'tables',
	combination_invalid_seats: 'tables',
	combination_missing_table: 'tables',
	combination_archived_table: 'tables',
	combination_uncombinable_table: 'tables',
	combination_cross_area: 'tables',
	combination_duplicate_members: 'tables',
	// Services group: service windows and turn times.
	service_invalid_window: 'services',
	service_duration_exceeds_24h: 'services',
	service_last_seating_after_end: 'services',
	service_last_seating_before_start: 'services',
	turn_time_bucket_invalid_range: 'services',
	turn_time_bucket_overlap: 'services',
	turn_time_bucket_gap: 'services',
	// Location hours: services outside opening hours are fixed on the service;
	// an inactive location or missing hours are fixed in Location settings
	// (not a Reservations tab, so no link here).
	service_on_closed_weekday: 'services',
	service_outside_location_hours: 'services',
	location_inactive: null,
	location_no_hours: null,
	// Rules group: payment policies.
	policy_unknown_service: 'policies',
	policy_party_bounds_inverted: 'policies',
	policy_invalid_window: 'policies',
	// Services group: special days and blocks.
	block_invalid_window: 'special-days',
	block_unknown_table: 'special-days',
}

export function setupIssueTab(code: string): SetupIssueTab | null {
	return (TARGETS as Record<string, SetupIssueTab | null>)[code] ?? null
}
