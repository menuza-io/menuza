const mockSaveAsync = jest.fn()
const mockRenderAsync = jest.fn()
const mockResize = jest.fn()
const mockManipulate = jest.fn()

jest.mock(
	'expo-image-manipulator',
	() => ({
		ImageManipulator: {
			manipulate: (...args: unknown[]) => mockManipulate(...args),
		},
		SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
	}),
	{ virtual: true },
)

import {
	CAPTURE_OPTIONS,
	PHOTO_JPEG_QUALITY,
	PHOTO_LONG_EDGE_PX,
	preparePhoto,
} from '../prepare'
import { PhotoUploadQueue } from '../queue'
import { createMemoryPhotoFiles, createMemoryQueueStorage } from '../storage'

beforeEach(() => {
	jest.clearAllMocks()
	const context = { resize: mockResize, renderAsync: mockRenderAsync }
	mockResize.mockReturnValue(context)
	mockManipulate.mockReturnValue(context)
	mockRenderAsync.mockResolvedValue({ saveAsync: mockSaveAsync })
	mockSaveAsync.mockResolvedValue({
		uri: 'file:///cache/ImageManipulator/out.jpg',
		width: 2000,
		height: 1500,
	})
})

describe('preparePhoto', () => {
	it('resizes the long edge to 2000, re-encodes as JPEG and asks for no base64', async () => {
		const prepared = await preparePhoto({
			uri: 'file:///cache/Camera/raw.heic',
			width: 4032,
			height: 3024,
		})

		expect(mockManipulate).toHaveBeenCalledWith('file:///cache/Camera/raw.heic')
		expect(mockResize).toHaveBeenCalledWith({ width: PHOTO_LONG_EDGE_PX })
		expect(mockSaveAsync).toHaveBeenCalledWith({
			format: 'jpeg',
			compress: PHOTO_JPEG_QUALITY,
			base64: false,
		})
		expect(prepared).toEqual({
			uri: 'file:///cache/ImageManipulator/out.jpg',
			width: 2000,
			height: 1500,
		})
	})

	it('resizes a portrait photo by its height', async () => {
		await preparePhoto({ uri: 'file:///p.jpg', width: 3024, height: 4032 })
		expect(mockResize).toHaveBeenCalledWith({ height: PHOTO_LONG_EDGE_PX })
	})

	it('never enlarges a small photo, but still re-encodes it (that drops EXIF)', async () => {
		await preparePhoto({ uri: 'file:///s.jpg', width: 1200, height: 900 })
		expect(mockResize).not.toHaveBeenCalled()
		expect(mockSaveAsync).toHaveBeenCalledTimes(1)
	})

	it('captures without EXIF or base64', () => {
		expect(CAPTURE_OPTIONS).toMatchObject({ exif: false, base64: false })
	})

	it('queues the prepared file, never the original', async () => {
		const prepared = await preparePhoto({
			uri: 'file:///cache/Camera/raw-with-gps.jpg',
			width: 4000,
			height: 3000,
		})
		const persisted: string[] = []
		const files = createMemoryPhotoFiles()
		const queue = new PhotoUploadQueue({
			storage: createMemoryQueueStorage(),
			files: {
				...files,
				persist: async (uri, id) => {
					persisted.push(uri)
					return files.persist(uri, id)
				},
			},
			upload: async () => ({ kind: 'network', message: 'offline' }),
			getAccessToken: async () => 'tok',
			refreshSession: async () => {},
			isOnline: () => false,
			newId: () => 'id-1',
			setTimer: () => 0,
			clearTimer: () => {},
		})
		await queue.enqueue({
			organizationId: 'org-1',
			itemId: 'dish-1',
			sourceUri: prepared.uri,
		})
		expect(persisted).toEqual(['file:///cache/ImageManipulator/out.jpg'])
	})
})
