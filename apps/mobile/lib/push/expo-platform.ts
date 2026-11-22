import Constants from 'expo-constants'
import { getLocales } from 'expo-localization'
import { Platform } from 'react-native'
import { type PushPlatform } from './operator-push'

/**
 * The real platform for push: `expo-notifications`, loaded lazily so a build
 * that does not have the native module yet (it needs a rebuild) carries on
 * without push instead of failing to start.
 */
type NotificationsModule = typeof import('expo-notifications')

let cached: NotificationsModule | null | undefined

export function loadNotifications(): NotificationsModule | null {
	if (cached !== undefined) return cached
	try {
		cached = require('expo-notifications') as NotificationsModule
	} catch {
		cached = null
	}
	return cached
}

export function createExpoPushPlatform(): PushPlatform | null {
	const Notifications = loadNotifications()
	if (!Notifications) return null
	const os =
		Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other'
	const projectId =
		(
			Constants.expoConfig?.extra as
				{ eas?: { projectId?: string } } | undefined
		)?.eas?.projectId ?? Constants.easConfig?.projectId
	return {
		os,
		locale: getLocales()[0]?.languageTag ?? 'en',
		deviceName: Constants.deviceName ?? undefined,
		appVersion: Constants.expoConfig?.version,
		projectId,
		getPermission: async () => {
			const { status } = await Notifications.getPermissionsAsync()
			return status
		},
		requestPermission: async () => {
			const { status } = await Notifications.requestPermissionsAsync()
			return status
		},
		getToken: async (id) =>
			(
				await Notifications.getExpoPushTokenAsync(
					id ? { projectId: id } : undefined,
				)
			).data,
	}
}
