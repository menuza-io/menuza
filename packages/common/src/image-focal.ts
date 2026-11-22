/**
 * Focal point of a dish photo (#394). Pure: the App stores it on the media
 * asset, every channel (website, QR, customer app, delivery menus) reads it.
 *
 * A focal point is a normalized `x,y` in 0..1 (0,0 is the top left, 1,1 the
 * bottom right). The centre is the default and is stored as no value, so a
 * photo nobody touched keeps the crop it always had.
 */

export type FocalPoint = { x: number; y: number }

export const CENTER_FOCAL_POINT: FocalPoint = { x: 0.5, y: 0.5 }

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, value))
}

/** Two decimals are far finer than any crop can show and keep URLs short. */
function round2(value: number): number {
	return Math.round(clampUnit(value) * 100) / 100
}

export function isCenterFocalPoint(point: FocalPoint | null | undefined) {
	return !point || (point.x === 0.5 && point.y === 0.5)
}

/**
 * Cleans a stored or submitted pair. Anything that is not a finite number
 * pair, and the exact centre, answers `null` ("no focal point").
 */
export function normalizeFocalPoint(x: unknown, y: unknown): FocalPoint | null {
	if (typeof x !== 'number' || typeof y !== 'number') return null
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null
	const point = { x: round2(x), y: round2(y) }
	return isCenterFocalPoint(point) ? null : point
}

/** Reads `"0.2,0.35"` (a query value or a stored string). */
export function parseFocalPoint(value: unknown): FocalPoint | null {
	if (typeof value !== 'string') return null
	const match = /^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*$/.exec(value)
	if (!match) return null
	return normalizeFocalPoint(Number(match[1]), Number(match[2]))
}

/** The `x,y` string for URLs; empty for the default centre. */
export function formatFocalPoint(point: FocalPoint | null | undefined) {
	const clean = point ? normalizeFocalPoint(point.x, point.y) : null
	return clean ? `${clean.x},${clean.y}` : ''
}

/** CSS `object-position` for an `object-fit: cover` image. */
export function focalObjectPosition(
	point: FocalPoint | null | undefined,
): string {
	const clean = point ? normalizeFocalPoint(point.x, point.y) : null
	const p = clean ?? CENTER_FOCAL_POINT
	return `${Math.round(p.x * 100)}% ${Math.round(p.y * 100)}%`
}

/**
 * The `gravity` value of Cloudflare Images (`cdn-cgi/image/gravity=0.2x0.3`)
 * and of `cf.image`; `null` keeps the default centre crop.
 */
export function focalGravity(
	point: FocalPoint | null | undefined,
): { x: number; y: number } | null {
	return point ? normalizeFocalPoint(point.x, point.y) : null
}

/** `gravity=0.2x0.3` for a `/cdn-cgi/image/` option list; empty at centre. */
export function focalCdnOption(point: FocalPoint | null | undefined): string {
	const gravity = focalGravity(point)
	return gravity ? `gravity=${gravity.x}x${gravity.y}` : ''
}

export type CropRect = {
	left: number
	top: number
	width: number
	height: number
}

/**
 * The window a `cover` crop takes from a source image so it fills
 * `outWidth x outHeight`. The window is as large as the target aspect ratio
 * allows and is placed so the focal point sits as close to its middle as the
 * photo's edges permit (a point near an edge shifts the crop toward that edge
 * and never past it). With no focal point it is centred.
 */
export function coverCropRect(input: {
	sourceWidth: number
	sourceHeight: number
	outWidth: number
	outHeight: number
	focal?: FocalPoint | null
}): CropRect {
	const { sourceWidth, sourceHeight, outWidth, outHeight } = input
	const target = outWidth / outHeight
	const source = sourceWidth / sourceHeight
	let width = sourceWidth
	let height = sourceHeight
	if (source > target) width = Math.round(sourceHeight * target)
	else height = Math.round(sourceWidth / target)
	const point = input.focal
		? (normalizeFocalPoint(input.focal.x, input.focal.y) ?? CENTER_FOCAL_POINT)
		: CENTER_FOCAL_POINT
	const left = Math.round(
		Math.min(
			sourceWidth - width,
			Math.max(0, point.x * sourceWidth - width / 2),
		),
	)
	const top = Math.round(
		Math.min(
			sourceHeight - height,
			Math.max(0, point.y * sourceHeight - height / 2),
		),
	)
	return { left, top, width, height }
}

/** Reads a stored pair of nullable numbers off a media asset row. */
export function focalPointOf(row: {
	focalX?: number | null
	focalY?: number | null
}): FocalPoint | null {
	return normalizeFocalPoint(row.focalX, row.focalY)
}

/**
 * A delivery platform crops the photo it is given on its own, so a photo with
 * a focal point is handed over already cropped around it: the same library URL
 * with a `cover` crop and the point (`fp=`), which `/resources/images` honours.
 * A photo without a point (or an address that is not a library photo) comes
 * back unchanged, so nothing that was fine changes.
 */
export function focalCropUrl(
	url: string | null | undefined,
	point: FocalPoint | null | undefined,
	size = 1200,
): string | null {
	if (!url) return null
	const clean = point ? normalizeFocalPoint(point.x, point.y) : null
	if (!clean || !/[?&]mediaId=/.test(url)) return url
	const joiner = url.includes('?') ? '&' : '?'
	return `${url}${joiner}fit=cover&w=${size}&h=${size}&fp=${formatFocalPoint(clean)}`
}

/** The library asset id inside a `/resources/images?mediaId=...` address. */
export function mediaIdOfUrl(url: string | null | undefined): string | null {
	return url ? (/[?&]mediaId=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null
}
