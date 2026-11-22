import { jwtAuthApi } from './index'

/**
 * The operator phone's side of push (#106, #366): the App's
 * `/api/push/devices` and `/api/push/preferences`, with the mobile operator
 * token. NOT the guest customer app's push: that is another app and another
 * route. Nothing here carries a guest.
 */

export type PushCategory =
	| 'new_orders'
	| 'orders_waiting'
	| 'ordering_paused'
	| 'payment_review'
	| 'large_orders'
	| 'station_offline'
	| 'staff'
	| 'inventory'
	| 'reservations'
	| 'chat_mentions'

export interface PushDevice {
	id: string
	platform: string
	deviceName: string | null
	appVersion: string | null
	createdAt: number
	lastSeenAt: number
}

export interface AlertSettings {
	pushEnabled: boolean
	categories: Array<{ category: PushCategory; push: boolean; locked: boolean }>
	quiet: {
		quietStart: string | null
		quietEnd: string | null
		timeZone: string | null
	}
	snoozedUntil: number | null
}

export type AlertSettingChange =
	| { intent: 'push'; category: PushCategory; enabled: boolean }
	| {
			intent: 'quiet_hours'
			quiet: {
				quietStart: string | null
				quietEnd: string | null
				timeZone: string | null
			}
	  }
	| {
			intent: 'snooze'
			option: '1h' | 'tomorrow' | 'custom' | 'clear'
			until?: number
			timeZone?: string | null
	  }

type Response<T> = {
	success: boolean
	data?: T
	error?: string
	message?: string
	status: number
}

export interface PushApi {
	authenticatedGet<T>(path: string): Promise<Response<T>>
	authenticatedSend<T>(
		method: 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown,
	): Promise<Response<T>>
}

export type PushResult<T> =
	| { ok: true; data: T }
	| { ok: false; code: string; status: number; message: string }

function wrap<T>(response: Response<T>, fallback: string): PushResult<T> {
	if (!response.success || response.data === undefined) {
		return {
			ok: false,
			code: response.error || 'unknown_error',
			status: response.status,
			message: response.message || fallback,
		}
	}
	return { ok: true, data: response.data }
}

export async function registerPushDevice(
	input: {
		token: string
		platform: 'ios' | 'android'
		locale: string
		deviceName?: string
		appVersion?: string
	},
	api: PushApi = jwtAuthApi as unknown as PushApi,
) {
	return wrap(
		await api.authenticatedSend<{ deviceId: string }>(
			'POST',
			'/api/push/devices',
			input,
		),
		'Could not register this phone',
	)
}

export async function removePushDevice(
	which: { deviceId?: string; token?: string },
	api: PushApi = jwtAuthApi as unknown as PushApi,
) {
	return wrap(
		await api.authenticatedSend<{ removed: number }>(
			'DELETE',
			'/api/push/devices',
			which,
		),
		'Could not remove the phone',
	)
}

export async function listPushDevices(
	api: PushApi = jwtAuthApi as unknown as PushApi,
) {
	return wrap(
		await api.authenticatedGet<{ devices: PushDevice[] }>('/api/push/devices'),
		'Could not load your phones',
	)
}

export async function fetchAlertSettings(
	organizationId: string,
	api: PushApi = jwtAuthApi as unknown as PushApi,
) {
	const search = new URLSearchParams({ organizationId })
	return wrap(
		await api.authenticatedGet<{ settings: AlertSettings }>(
			`/api/push/preferences?${search.toString()}`,
		),
		'Could not load notification settings',
	)
}

export async function saveAlertSetting(
	organizationId: string,
	change: AlertSettingChange,
	api: PushApi = jwtAuthApi as unknown as PushApi,
) {
	return wrap(
		await api.authenticatedSend<{ settings: AlertSettings }>(
			'PUT',
			'/api/push/preferences',
			{ organizationId, change },
		),
		'Could not save that',
	)
}
