import { useEffect } from 'react'
import { Linking } from 'react-native'
import { useAuth } from '../lib/auth/hooks/use-auth'
import {
	createExpoPushPlatform,
	loadNotifications,
} from '../lib/push/expo-platform'
import { pushTarget, registerThisDevice } from '../lib/push/operator-push'

const APP_ORIGIN = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001'

/**
 * Operator push for the signed-in member (#106): after sign-in the phone asks
 * permission (the system's own question) and registers for pushes; a tap on a
 * push opens the App address it carries (there is no phone screen for orders,
 * tablets, staff, inventory or reservations yet). Renders nothing, and does
 * nothing at all on a build without the native module.
 */
export function PushLifecycle() {
	const { isAuthenticated } = useAuth()

	useEffect(() => {
		if (!isAuthenticated) return
		const platform = createExpoPushPlatform()
		if (!platform) return
		void registerThisDevice({ platform })
	}, [isAuthenticated])

	useEffect(() => {
		const Notifications = loadNotifications()
		if (!Notifications) return
		Notifications.setNotificationHandler({
			handleNotification: async () => ({
				shouldShowBanner: true,
				shouldShowList: true,
				shouldPlaySound: true,
				shouldSetBadge: false,
			}),
		})
		const open = (data: unknown) => {
			const target = pushTarget(data, APP_ORIGIN)
			if (target.kind === 'url') void Linking.openURL(target.url)
		}
		const subscription = Notifications.addNotificationResponseReceivedListener(
			(response) => open(response.notification.request.content.data),
		)
		// The tap that started the app from closed.
		void Notifications.getLastNotificationResponseAsync()
			.then((response) => {
				if (response) open(response.notification.request.content.data)
			})
			.catch(() => undefined)
		return () => subscription.remove()
	}, [])

	return null
}
