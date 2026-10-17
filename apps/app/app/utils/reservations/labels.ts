import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * Display labels for the enums the reservations API returns. Callers render
 * them with `i18n._(descriptor)` through `enumLabel`, so no raw enum value
 * reaches the screen for a known value.
 */

export const RESERVATION_STATUS_LABELS: Record<string, MessageDescriptor> = {
	pending_payment: msg`Pending payment`,
	pending_approval: msg`Pending approval`,
	requested: msg`Pending approval`,
	declined: msg`Declined`,
	booked: msg`Booked`,
	confirmed: msg`Confirmed`,
	arrived: msg`Arrived`,
	partially_seated: msg`Partially seated`,
	seated: msg`Seated`,
	completed: msg`Completed`,
	finished: msg`Finished`,
	cancelled: msg`Cancelled`,
	no_show: msg`No-show`,
	expired: msg`Expired`,
}

export const COURSE_STAGE_LABELS: Record<string, MessageDescriptor> = {
	seated: msg`Seated`,
	appetizer: msg`Appetizer`,
	entree: msg`Entree`,
	dessert: msg`Dessert`,
	check_dropped: msg`Check Dropped`,
	bussing: msg`Bussing`,
}

export const CONTACT_STATUS_LABELS: Record<string, MessageDescriptor> = {
	none: msg`Not Contacted`,
	not_contacted: msg`Not Contacted`,
	left_message: msg`Left Message`,
	no_answer: msg`No Answer`,
	wrong_number: msg`Wrong Number`,
}

export const CHANNEL_LABELS: Record<string, MessageDescriptor> = {
	online: msg`Online`,
	native: msg`Mobile app`,
	voice_agent: msg`Voice agent`,
	phone: msg`Phone`,
	host: msg`Host stand`,
	walk_in: msg`Walk-in`,
	waitlist: msg`Waitlist`,
}

/** The `X-Client` value recorded when a guest booked (`operator` is a host entry). */
export const CLIENT_LABELS: Record<string, MessageDescriptor> = {
	web: msg`Web`,
	ios: msg`iOS app`,
	android: msg`Android app`,
}

/** Client label for display; an unrecognized value is shown as received. */
export function clientLabel(
	translate: (descriptor: MessageDescriptor) => string,
	value: string | null | undefined,
): string {
	if (!value) return ''
	const descriptor = CLIENT_LABELS[value]
	return descriptor ? translate(descriptor) : value
}

/** Booking channels the Book list can filter on. */
export const SOURCE_FILTER_OPTIONS = [
	'phone',
	'walk_in',
	'online',
	'host',
	'native',
	'voice_agent',
	'waitlist',
] as const

export const OCCASION_LABELS: Record<string, MessageDescriptor> = {
	birthday: msg`Birthday`,
	anniversary: msg`Anniversary`,
	date_night: msg`Date Night`,
	business: msg`Business Meal`,
	celebration: msg`Celebration`,
	vip: msg`VIP`,
}

/** Built-in reservation tags; tags an org adds keep their own name. */
export const TAG_LABELS: Record<string, MessageDescriptor> = {
	allergy: msg`Allergy`,
	anniversary: msg`Anniversary`,
	birthday: msg`Birthday`,
	regular: msg`Regular`,
	vip: msg`VIP`,
}

export const DIETARY_LABELS: Record<string, MessageDescriptor> = {
	vegetarian: msg`Vegetarian`,
	vegan: msg`Vegan`,
	gluten_free: msg`Gluten-Free`,
	halal: msg`Halal`,
	nut_allergy: msg`Nut Allergy`,
	dairy_free: msg`Dairy-Free`,
	shellfish_allergy: msg`Shellfish Allergy`,
}

export const VIP_TIER_LABELS: Record<string, MessageDescriptor> = {
	none: msg`Standard`,
	silver: msg`Silver`,
	gold: msg`Gold`,
	platinum: msg`Platinum`,
	vip: msg`VIP`,
}

export const LIVE_TABLE_STATUS_LABELS: Record<string, MessageDescriptor> = {
	available: msg`Available`,
	open: msg`Available`,
	reserved_soon: msg`Reserved soon`,
	arrived_waiting: msg`Arrived, waiting`,
	seated: msg`Seated`,
	entree: msg`Entree`,
	dessert: msg`Dessert`,
	dessert_check: msg`Dessert / check`,
	check_dropped: msg`Check Dropped`,
	finishing: msg`Finishing`,
	overtime: msg`Overtime`,
	bussing: msg`Bussing`,
	blocked: msg`Blocked`,
}

export const DAY_CONFLICT_REASON_LABELS: Record<string, MessageDescriptor> = {
	table_blocked: msg`Table blocked`,
	table_overlap: msg`Table overlap`,
	capacity_exceeded: msg`Over capacity`,
	unassigned: msg`Unassigned`,
	schedule_closed: msg`Outside service hours`,
}

export const MOVE_NOTICE_REASON_LABELS: Record<string, MessageDescriptor> = {
	reflow: msg`Moved automatically to make room`,
	auto_reassigned: msg`Moved automatically to make room`,
	block: msg`Moved automatically because a table was blocked`,
	table_blocked: msg`Moved automatically because a table was blocked`,
	turn_extension: msg`Moved automatically after a turn was extended`,
}

/** Tag ids look like `tag_<org>_<code>`; the code is what the labels key on. */
export function stripTagPrefix(value: string): string {
	return value.replace(/^tag_[a-z0-9]+?_/i, '')
}

export function humanizeEnum(value: string): string {
	const text = stripTagPrefix(value).replace(/[_-]+/g, ' ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Renders a known enum through Lingui; unknown values fall back to readable text. */
export function enumLabel(
	translate: (descriptor: MessageDescriptor) => string,
	labels: Record<string, MessageDescriptor>,
	value: string | null | undefined,
): string {
	if (!value) return ''
	const descriptor = labels[value] ?? labels[stripTagPrefix(value)]
	return descriptor ? translate(descriptor) : humanizeEnum(value)
}

export const EVENT_TYPE_LABELS: Record<string, MessageDescriptor> = {
	...RESERVATION_STATUS_LABELS,
	created: msg`Created`,
	seeded: msg`Imported`,
	modified: msg`Details changed`,
	table_changed: msg`Table changed`,
	assigned: msg`Table assigned`,
	locked: msg`Table locked`,
	unlocked: msg`Table unlocked`,
	status_undo: msg`Status change undone`,
	running_late: msg`Running late`,
	contact_status: msg`Contact status changed`,
	course: msg`Course changed`,
	confirmation_resent: msg`Confirmation re-sent`,
	note: msg`Note updated`,
	auto_reassigned: msg`Moved automatically`,
}

export const ACTOR_KIND_LABELS: Record<string, MessageDescriptor> = {
	guest: msg`Guest`,
	operator: msg`Operator`,
	system: msg`System`,
	voice_agent: msg`Voice agent`,
}

export const ELEMENT_KIND_LABELS: Record<string, MessageDescriptor> = {
	wall: msg`Wall`,
	bar: msg`Bar counter`,
	door: msg`Door`,
	window: msg`Window`,
	label: msg`Label`,
	plant: msg`Plant`,
	zone: msg`Zone`,
}
