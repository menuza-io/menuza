import { Platform } from 'react-native'
import {
	PushClient,
	type PushPreferences,
	type PushPreferencesChange,
} from '../api/push'
import { tokenOrgId } from '../session/auth-tokens'
import { type CustomerSession } from '../session/customer-session'
import { secureDeviceStore, type PushDeviceStore } from './device-store'
import {
	notificationsAdapter,
	type NotificationPermission,
	type NotificationsAdapter,
} from './notifications'

export type PushState =
	/** Push is not on for this restaurant, or the node says no: show nothing. */
	| { kind: 'unavailable' }
	| {
			kind: 'ready'
			permission: NotificationPermission
			preferences: PushPreferences
	  }

export type EnableResult =
	| { kind: 'enabled'; preferences: PushPreferences }
	| { kind: 'denied' }
	| { kind: 'no_token' }

/**
 * Guest push on this device (#105): asks the system, registers the token with
 * the regional tenant-api, keeps it fresh and deletes it on sign-out. All
 * calls go browser-direct with the customer token; nothing is proxied.
 */
export class PushManager {
	readonly #session: CustomerSession
	readonly #client: PushClient
	readonly #devices: PushDeviceStore
	readonly #adapter: () => NotificationsAdapter
	readonly #language: () => string
	readonly #platform: 'ios' | 'android'

	constructor(options: {
		session: CustomerSession
		language: () => string
		devices?: PushDeviceStore
		adapter?: () => NotificationsAdapter
		platform?: 'ios' | 'android'
	}) {
		this.#session = options.session
		this.#client = new PushClient(options.session)
		this.#devices = options.devices ?? secureDeviceStore
		this.#adapter = options.adapter ?? notificationsAdapter
		this.#language = options.language
		this.#platform =
			options.platform ?? (Platform.OS === 'android' ? 'android' : 'ios')
	}

	get client(): PushClient {
		return this.#client
	}

	#orgId(): string | null {
		const tokens = this.#session.tokens
		return tokens ? tokenOrgId(tokens) : null
	}

	/** What the screen shows: unavailable, or the permission and the guest's switches. */
	async state(): Promise<PushState> {
		const preferences = await this.#client.preferences()
		if (!preferences) return { kind: 'unavailable' }
		const permission = await this.#adapter().permission()
		return { kind: 'ready', permission, preferences }
	}

	/**
	 * The pre-prompt's "Turn on": the system prompt, then the token, then the
	 * registration. `marketing` is the offers switch the guest chose on the
	 * pre-prompt (off by default); it is recorded with the `app_prompt` source.
	 */
	async enable(options: { marketing?: boolean } = {}): Promise<EnableResult> {
		const adapter = this.#adapter()
		const permission =
			(await adapter.permission()) === 'granted'
				? 'granted'
				: await adapter.requestPermission()
		if (permission !== 'granted') return { kind: 'denied' }
		const registered = await this.#register()
		if (!registered) return { kind: 'no_token' }
		adapter.showWhileOpen()
		const preferences = options.marketing
			? await this.#client.setPreferences({
					marketing: true,
					source: 'app_prompt',
				})
			: await this.#client.setPreferences({})
		return { kind: 'enabled', preferences }
	}

	setPreferences(change: PushPreferencesChange): Promise<PushPreferences> {
		return this.#client.setPreferences(change)
	}

	/**
	 * On launch and after sign-in: when the system already allows notifications
	 * and push is on for this restaurant, registers again (a push token can
	 * change). Never asks the system and never throws.
	 */
	async sync(): Promise<void> {
		try {
			const adapter = this.#adapter()
			if ((await adapter.permission()) !== 'granted') return
			if (!(await this.#client.preferences())) return
			await this.#register()
			adapter.showWhileOpen()
		} catch {
			// Best effort: the next launch tries again.
		}
	}

	/** Sign-out: deletes this device on the server and forgets its id. Never throws. */
	async unregister(): Promise<void> {
		const orgId = this.#orgId()
		if (!orgId) return
		try {
			const deviceId = await this.#devices.read(orgId)
			if (deviceId) await this.#client.remove(deviceId)
		} catch {
			// Offline: the server drops a device whose token it can no longer reach.
		} finally {
			await this.#devices.write(orgId, null)
		}
	}

	async #register(): Promise<boolean> {
		const orgId = this.#orgId()
		if (!orgId) return false
		const token = await this.#adapter().token()
		if (!token) return false
		const id = await this.#client.register({
			token,
			platform: this.#platform,
			locale: this.#language(),
		})
		await this.#devices.write(orgId, id)
		return true
	}
}
