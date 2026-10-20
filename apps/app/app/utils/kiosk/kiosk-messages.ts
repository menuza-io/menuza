import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type KioskErrorCode } from '@repo/staffing'

/**
 * What the tablet says when something does not work. Every line is written for
 * someone on a busy shift standing at a counter: what happened, and the one
 * thing to do next. No server text, status codes or stack traces ever reach the
 * screen.
 */

export type KioskMessage = {
	message: MessageDescriptor
	/**
	 * `retry`: try again now. `wait`: the pad is paused for a while.
	 * `manager`: nothing the person can do; ask someone. `repair`: this tablet
	 * itself is no longer connected.
	 */
	kind: 'retry' | 'wait' | 'manager' | 'repair'
}

const GENERIC: KioskMessage = {
	message: msg`Something went wrong. Please try again.`,
	kind: 'retry',
}

export function describeKioskError(
	code: string,
	options: { retryAfterSeconds?: number } = {},
): KioskMessage {
	const seconds = Math.max(1, Math.ceil(options.retryAfterSeconds ?? 30))
	const known = code as KioskErrorCode
	switch (known) {
		case 'invalid_pin':
			return options.retryAfterSeconds && options.retryAfterSeconds > 0
				? {
						message: msg`That PIN did not match. Wait ${seconds} seconds, then try again.`,
						kind: 'wait',
					}
				: { message: msg`That PIN did not match. Try again.`, kind: 'retry' }
		case 'backoff':
			return {
				message: msg`Too many wrong PINs. Try again in ${seconds} seconds.`,
				kind: 'wait',
			}
		case 'person_locked':
			return {
				message: msg`This PIN is paused for a few minutes. Ask a manager.`,
				kind: 'manager',
			}
		case 'not_available':
			return {
				message: msg`This is not available on this tablet.`,
				kind: 'manager',
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
				message: msg`This tablet is not ready yet. Ask a manager.`,
				kind: 'manager',
			}
		case 'kiosk_disabled':
			return {
				message: msg`Tablet time clocks are switched off right now. Ask your manager.`,
				kind: 'manager',
			}
		case 'invalid_device':
		case 'device_revoked':
			return {
				message: msg`This tablet is no longer connected. Ask a manager to pair it again.`,
				kind: 'repair',
			}
		case 'queue_unavailable' as KioskErrorCode:
			return {
				message: msg`This tablet cannot save punches without a connection. Try again when it is back.`,
				kind: 'manager',
			}
		case 'network_unavailable' as KioskErrorCode:
			return {
				message: msg`No connection right now. Try again in a moment.`,
				kind: 'retry',
			}
		case 'invalid_pairing_code':
			return {
				message: msg`That code did not work. It may have expired. Ask for a new one.`,
				kind: 'manager',
			}
		default:
			return GENERIC
	}
}
