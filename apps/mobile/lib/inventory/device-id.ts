import AsyncStorage from '@react-native-async-storage/async-storage'
import { randomUUID } from 'expo-crypto'

const KEY = 'menuza.inventory.deviceId'

/**
 * A stable id for this phone, so the office can tell which devices joined a
 * count and how many entries each still holds unsent (#474). Made once.
 */
export async function getDeviceId(): Promise<string> {
	try {
		const saved = await AsyncStorage.getItem(KEY)
		if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved
	} catch {
		// Fall through to a new id.
	}
	const id = `p${randomUUID().replaceAll('-', '')}`.slice(0, 40)
	try {
		await AsyncStorage.setItem(KEY, id)
	} catch {
		// Not remembered: a new id next time.
	}
	return id
}
