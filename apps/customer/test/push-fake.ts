import {
	type NotificationPermission,
	type NotificationsAdapter,
	type PushTapData,
} from '@/lib/push/notifications'

/** A device with no native module: permission, token and taps are all under the test's control. */
export function fakeNotifications(
	options: {
		permission?: NotificationPermission
		/** What the system answers when asked. */
		answer?: NotificationPermission
		token?: string | null
		initial?: PushTapData | null
	} = {},
) {
	const state = {
		permission:
			options.permission ?? ('undetermined' as NotificationPermission),
		prompts: 0,
		shown: 0,
	}
	let listener: ((data: PushTapData) => void) | null = null
	const adapter: NotificationsAdapter = {
		async permission() {
			return state.permission
		},
		async requestPermission() {
			state.prompts += 1
			state.permission = options.answer ?? 'granted'
			return state.permission
		},
		async token() {
			return options.token === undefined
				? 'ExponentPushToken[abcdefghijklmnop]'
				: options.token
		},
		onTap(next) {
			listener = next
			return () => {
				listener = null
			}
		},
		async initialTap() {
			return options.initial ?? null
		},
		showWhileOpen() {
			state.shown += 1
		},
	}
	return {
		adapter,
		state,
		tap: (data: PushTapData) => listener?.(data),
		get listening() {
			return listener !== null
		},
	}
}
