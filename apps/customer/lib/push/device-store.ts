import * as SecureStore from 'expo-secure-store'

/**
 * The id the region gave this install's push registration, kept so signing out
 * can delete it. It is an opaque id (not the push token) and is per
 * organization, so leaving one restaurant never touches another's device.
 */
export type PushDeviceStore = {
	read(orgId: string): Promise<string | null>
	write(orgId: string, deviceId: string | null): Promise<void>
}

const key = (orgId: string) =>
	`push-device-${orgId.replace(/[^A-Za-z0-9._-]/g, '_')}`

export const secureDeviceStore: PushDeviceStore = {
	async read(orgId) {
		try {
			return await SecureStore.getItemAsync(key(orgId))
		} catch {
			return null
		}
	},
	async write(orgId, deviceId) {
		try {
			if (deviceId === null) await SecureStore.deleteItemAsync(key(orgId))
			else await SecureStore.setItemAsync(key(orgId), deviceId)
		} catch {
			// Storage can fail on a locked device; the next launch registers again.
		}
	},
}

export function memoryDeviceStore(
	initial: Record<string, string> = {},
): PushDeviceStore & { readonly values: Map<string, string> } {
	const values = new Map(Object.entries(initial))
	return {
		values,
		async read(orgId) {
			return values.get(orgId) ?? null
		},
		async write(orgId, deviceId) {
			if (deviceId === null) values.delete(orgId)
			else values.set(orgId, deviceId)
		},
	}
}
