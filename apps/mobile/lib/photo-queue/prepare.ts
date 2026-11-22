import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'

/** The long edge of an uploaded dish photo, in pixels. */
export const PHOTO_LONG_EDGE_PX = 2000
export const PHOTO_JPEG_QUALITY = 0.85

/**
 * Options for `CameraView.takePictureAsync` and `launchImageLibraryAsync`.
 * `exif: false` asks the platform not to hand us the metadata at all; the
 * re-encode in `preparePhoto` is what actually guarantees it is gone.
 */
export const CAPTURE_OPTIONS = {
	exif: false,
	base64: false,
	quality: 1,
} as const

export interface CapturedPhoto {
	uri: string
	width?: number
	height?: number
}

export interface PreparedPhoto {
	uri: string
	width: number
	height: number
}

/**
 * Shrinks a photo so its long edge is at most 2000 px (never enlarges) and
 * re-encodes it as JPEG.
 *
 * Location data and the rest of EXIF are removed by that re-encode: the
 * manipulator decodes the pixels and writes a new JPEG, and what it writes
 * carries no metadata of the original. The App route strips metadata again
 * on the server (defence in depth), so a photo that reached it some other
 * way is clean too. The result is also the only file that is ever queued, so
 * the original (which may hold GPS) never goes into the upload queue.
 */
export async function preparePhoto(
	photo: CapturedPhoto,
): Promise<PreparedPhoto> {
	const context = ImageManipulator.manipulate(photo.uri)

	const { width, height } = photo
	if (width && height && Math.max(width, height) > PHOTO_LONG_EDGE_PX) {
		context.resize(
			width >= height
				? { width: PHOTO_LONG_EDGE_PX }
				: { height: PHOTO_LONG_EDGE_PX },
		)
	}

	const rendered = await context.renderAsync()
	const saved = await rendered.saveAsync({
		format: SaveFormat.JPEG,
		compress: PHOTO_JPEG_QUALITY,
		base64: false,
	})
	return { uri: saved.uri, width: saved.width, height: saved.height }
}
