import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type ClockEvent, type ClockState } from '@repo/staffing'

/**
 * What the time clock says, in the kiosk's words, so a person hears the same
 * thing at a till as at a wall tablet.
 */

export type NoticeKind = 'retry' | 'wait' | 'manager' | 'offline'

export function clockNotice(
	code: string,
	seconds = 0,
): { message: MessageDescriptor; kind: NoticeKind } {
	switch (code) {
		case 'invalid_pin':
			return seconds > 0
				? {
						message: msg`That PIN is not right. Try again in ${seconds} seconds.`,
						kind: 'wait',
					}
				: { message: msg`That PIN is not right.`, kind: 'retry' }
		case 'backoff':
			return {
				message: msg`Too many wrong PINs. Try again in ${seconds} seconds.`,
				kind: 'wait',
			}
		case 'time_tracking_disabled':
			return {
				message: msg`Time tracking is turned off at this workplace.`,
				kind: 'manager',
			}
		case 'already_clocked_in':
			return { message: msg`You are already clocked in.`, kind: 'retry' }
		case 'not_clocked_in':
			return { message: msg`You are not clocked in.`, kind: 'retry' }
		case 'already_on_break':
			return { message: msg`You are already on a break.`, kind: 'retry' }
		case 'not_on_break':
			return { message: msg`You are not on a break.`, kind: 'retry' }
		case 'clocked_in_elsewhere':
			return {
				message: msg`You are clocked in at another workplace. Clock out there first.`,
				kind: 'manager',
			}
		case 'overlaps_previous_entry':
		case 'time_conflict':
			return {
				message: msg`That time overlaps another shift. Ask a manager to fix it.`,
				kind: 'manager',
			}
		case 'early_clock_in':
			return {
				message: msg`It is too early to clock in for your shift.`,
				kind: 'manager',
			}
		case 'unscheduled_not_allowed':
			return {
				message: msg`You do not have a shift right now. Ask a manager.`,
				kind: 'manager',
			}
		case 'position_required':
			return { message: msg`Choose the role you are working.`, kind: 'retry' }
		case 'invalid_position':
			return {
				message: msg`That role is not available. Choose another.`,
				kind: 'retry',
			}
		case 'punch_in_future':
		case 'punch_too_old':
		case 'punch_id_conflict':
			return {
				message: msg`This punch could not be saved. Ask a manager to add it.`,
				kind: 'manager',
			}
		case 'time_zone_unavailable':
			return {
				message: msg`The time clock is not ready yet. Ask a manager.`,
				kind: 'manager',
			}
		case 'timeclock_not_enabled':
		case 'timeclock_disabled':
			return {
				message: msg`The time clock is turned off on this terminal. Ask a manager.`,
				kind: 'manager',
			}
		case 'timeclock_was_off':
			return {
				message: msg`The time clock was off on this terminal when this was punched. Ask a manager to add it.`,
				kind: 'manager',
			}
		case 'kiosk_disabled':
		case 'service_unavailable':
			return {
				message: msg`The time clock is unavailable right now. Try again soon.`,
				kind: 'offline',
			}
		case 'pos_disabled':
			return {
				message: msg`Terminals are paused right now. Try again soon.`,
				kind: 'manager',
			}
		case 'invalid_device':
		case 'device_revoked':
			return {
				message: msg`This terminal is no longer paired. Ask a manager to pair it again.`,
				kind: 'manager',
			}
		case 'queue_unavailable':
			return {
				message: msg`This terminal cannot save punches without a connection. Try again when it is back.`,
				kind: 'offline',
			}
		case 'network_unavailable':
			return {
				message: msg`No connection. Try again in a moment.`,
				kind: 'offline',
			}
		default:
			return {
				message: msg`Something went wrong. Try again.`,
				kind: 'retry',
			}
	}
}

export const EVENT_LABEL: Record<ClockEvent, MessageDescriptor> = {
	clock_in: msg`Clock in`,
	break_start: msg`Start break`,
	break_end: msg`End break`,
	clock_out: msg`Clock out`,
}

/** "Clocked in, Rana" on the confirmation. */
export const EVENT_DONE: Record<ClockEvent, MessageDescriptor> = {
	clock_in: msg`Clocked in`,
	break_start: msg`Break started`,
	break_end: msg`Back from break`,
	clock_out: msg`Clocked out`,
}

export const BREAK_LABEL: Record<'meal' | 'rest', MessageDescriptor> = {
	meal: msg`Meal break`,
	rest: msg`Rest break`,
}

export const STATE_LINE: Record<ClockState, MessageDescriptor> = {
	out: msg`You are clocked out.`,
	in: msg`You are clocked in.`,
	on_break: msg`You are on a break.`,
}
