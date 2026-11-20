import Constants from 'expo-constants'
import type * as ExpoNotificationsModule from 'expo-notifications'
import { Platform } from 'react-native'

/** What the system says about notifications for this app. */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined'

/** The data a tapped push carries: only what the payload allow-list permits (`@repo/common/push`). */
export type PushTapData = {
	url?: string | null
	messageId?: string | null
	kind?: string | null
}

/**
 * The device side of push, behind one small interface so the rest of the app
 * (and every test) never touches the native module. The default talks to
 * `expo-notifications`; tests install a fake with `setNotificationsAdapter`.
 */
export type NotificationsAdapter = {
	permission(): Promise<NotificationPermission>
	/** Shows the system prompt (once; iOS never asks twice). */
	requestPermission(): Promise<NotificationPermission>
	/** The Expo push token of this install, or null when it cannot be had (simulator, no project id). */
	token(): Promise<string | null>
	/** Calls back when the guest taps a push while the app runs; returns the unsubscribe. */
	onTap(listener: (data: PushTapData) => void): () => void
	/** The push that opened the app from a cold start, once. */
	initialTap(): Promise<PushTapData | null>
	/** Shows pushes that arrive while the app is open (banner, no sound or badge). */
	showWhileOpen(): void
}

type ExpoNotifications = typeof ExpoNotificationsModule

function native(): ExpoNotifications {
	// Loaded on first use: Jest and the web build never need the native module.
	return require('expo-notifications') as ExpoNotifications
}

function permissionOf(status: {
	granted: boolean
	canAskAgain: boolean
}): NotificationPermission {
	if (status.granted) return 'granted'
	return status.canAskAgain ? 'undetermined' : 'denied'
}

function tapData(raw: unknown): PushTapData {
	const data =
		raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
	const text = (value: unknown) => (typeof value === 'string' ? value : null)
	return {
		url: text(data.url),
		messageId: text(data.messageId),
		kind: text(data.kind),
	}
}

function projectId(): string | undefined {
	const eas = Constants.expoConfig?.extra?.eas as
		{ projectId?: string } | undefined
	return eas?.projectId ?? Constants.easConfig?.projectId ?? undefined
}

export const expoNotificationsAdapter: NotificationsAdapter = {
	async permission() {
		return permissionOf(await native().getPermissionsAsync())
	},
	async requestPermission() {
		const notifications = native()
		if (Platform.OS === 'android') {
			// Android needs a channel before a notification can show.
			await notifications.setNotificationChannelAsync('default', {
				name: 'default',
				importance: notifications.AndroidImportance.DEFAULT,
			})
		}
		return permissionOf(await notifications.requestPermissionsAsync())
	},
	async token() {
		try {
			const id = projectId()
			const result = await native().getExpoPushTokenAsync(
				id ? { projectId: id } : undefined,
			)
			return result.data
		} catch {
			return null
		}
	},
	onTap(listener) {
		const subscription = native().addNotificationResponseReceivedListener(
			(response) =>
				listener(tapData(response.notification.request.content.data)),
		)
		return () => subscription.remove()
	},
	async initialTap() {
		const response = await native().getLastNotificationResponseAsync()
		return response ? tapData(response.notification.request.content.data) : null
	},
	showWhileOpen() {
		native().setNotificationHandler({
			handleNotification: async () => ({
				shouldShowBanner: true,
				shouldShowList: true,
				shouldPlaySound: false,
				shouldSetBadge: false,
			}),
		})
	},
}

let adapter: NotificationsAdapter = expoNotificationsAdapter

export function notificationsAdapter(): NotificationsAdapter {
	return adapter
}

/** Test seam; pass null to restore the real one. */
export function setNotificationsAdapter(
	next: NotificationsAdapter | null,
): void {
	adapter = next ?? expoNotificationsAdapter
}

export { tapData as parseTapData }
