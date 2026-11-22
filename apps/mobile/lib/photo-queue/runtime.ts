import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import { randomUUID } from 'expo-crypto'
import { Directory, File, Paths } from 'expo-file-system'
import { AppState } from 'react-native'
import { jwtAuthApi } from '../api'
import { refreshSessionOnce } from '../api/session-refresh'
import { TokenManager } from '../storage/session-manager'
import { PhotoUploadQueue } from './queue'
import { createKeyValueQueueStorage } from './storage'
import { type PhotoFiles } from './types'
import { uploadPhoto } from './upload-photo'

/**
 * The real wiring of the queue: AsyncStorage, the document directory,
 * NetInfo, the app state and the app's own session. Nothing here has logic
 * worth testing on its own; the rules live in `queue.ts`.
 */

const PHOTO_DIRECTORY = 'dish-photos'

/** Photos live in the document directory (not the cache): the system must not clear them while they wait. */
export const documentPhotoFiles: PhotoFiles = {
	async persist(sourceUri, id) {
		const directory = new Directory(Paths.document, PHOTO_DIRECTORY)
		if (!directory.exists) directory.create({ idempotent: true })
		const target = new File(directory, `${id}.jpg`)
		await new File(sourceUri).copy(target)
		return target.uri
	},
	async remove(uri) {
		try {
			const file = new File(uri)
			if (file.exists) file.delete()
		} catch {
			// Already gone.
		}
	},
}

let online = true
let queue: PhotoUploadQueue | null = null
let teardown: (() => void) | null = null

function baseUrl(): string {
	return jwtAuthApi.getConfig().baseUrl
}

/** The one queue of this app process. Started lazily by `startPhotoQueue`. */
export function getPhotoQueue(): PhotoUploadQueue {
	if (!queue) {
		queue = new PhotoUploadQueue({
			storage: createKeyValueQueueStorage(AsyncStorage),
			files: documentPhotoFiles,
			upload: (input) => uploadPhoto({ ...input, baseUrl: baseUrl() }),
			getAccessToken: async () => {
				const { tokens } = await TokenManager.getInstance().validateTokens()
				return tokens?.accessToken ?? null
			},
			refreshSession: async () => {
				await refreshSessionOnce(baseUrl())
			},
			isOnline: async () => {
				const state = await NetInfo.fetch()
				online =
					state.isConnected !== false && state.isInternetReachable !== false
				return online
			},
			newId: () => randomUUID(),
		})
	}
	return queue
}

/**
 * Loads the saved queue and starts retrying: on start, when the phone comes
 * online, when the app returns to the foreground, and on the queue's own timer.
 * Safe to call more than once.
 */
export function startPhotoQueue(): PhotoUploadQueue {
	const photoQueue = getPhotoQueue()
	if (teardown) return photoQueue

	const unsubscribeNet = NetInfo.addEventListener((state: NetInfoState) => {
		const wasOnline = online
		online = state.isConnected !== false && state.isInternetReachable !== false
		if (online && !wasOnline) void photoQueue.kick()
	})
	const appState = AppState.addEventListener('change', (next) => {
		if (next === 'active') void photoQueue.kick()
	})
	teardown = () => {
		unsubscribeNet()
		appState.remove()
		teardown = null
	}
	void photoQueue.load().then(() => photoQueue.kick())
	return photoQueue
}

export function stopPhotoQueue(): void {
	teardown?.()
}

/**
 * Signing out drops the photos still waiting: they were taken for the previous
 * member's menu permission and must not upload under the next account.
 */
export async function clearPhotoQueue(): Promise<void> {
	stopPhotoQueue()
	await getPhotoQueue().clear()
}
