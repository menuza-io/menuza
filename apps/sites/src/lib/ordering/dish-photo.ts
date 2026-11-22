import {
	focalObjectPosition,
	formatFocalPoint,
	type FocalPoint,
} from '@repo/common/image-focal'

/**
 * One place that decides how a dish photo is cropped and how an A/B test
 * (#192) is marked on it, so the server render, the client row builders, the
 * item modal and the upsell row all do it the same way.
 *
 * The focal point (#394) is a CSS `object-position` on an `object-cover`
 * image. No focal point means the centre, which is the browser default, so
 * those photos get no style at all and keep the crop they always had.
 */

export type DishPhotoTest = {
	id: string
	/** Photo B, already resolved to a public address. Never used server-side. */
	imageUrlB: string
	imageFocalB?: FocalPoint | null
	/** The beacon key the App signed for this test; counters need it. */
	key?: string
}

/** The `object-position` value; the centre for no focal point. */
export function dishPhotoPosition(focal: FocalPoint | null | undefined) {
	return focalObjectPosition(focal)
}

/** The inline `style` text, or `undefined` at the centre (nothing to override). */
export function dishPhotoStyle(
	focal: FocalPoint | null | undefined,
): string | undefined {
	const position = focalObjectPosition(focal)
	return position === '50% 50%' ? undefined : `object-position: ${position}`
}

/**
 * The markers a photo carries while its dish is in a test. Photo A stays the
 * `src`; the page script swaps to B for the visitors in B. Returns `{}` when
 * there is no test, so a spread adds nothing.
 */
export function photoTestAttributes(
	itemId: string,
	test: DishPhotoTest | null | undefined,
): Record<string, string> {
	if (!test?.id || !test.imageUrlB) return {}
	return {
		'data-photo-test-id': test.id,
		'data-photo-test-item': itemId,
		'data-photo-test-src-b': test.imageUrlB,
		'data-photo-test-focal-b': formatFocalPoint(test.imageFocalB),
		...(test.key ? { 'data-photo-test-key': test.key } : {}),
	}
}

/**
 * Applies the crop and the test markers to a photo built in the browser
 * (menu rows, item modal, upsell row). Server-rendered photos get the same
 * through `dishPhotoStyle` and `photoTestAttributes`.
 */
export function decorateDishPhoto(
	img: HTMLImageElement,
	options: {
		itemId: string
		focal?: FocalPoint | null
		test?: DishPhotoTest | null
	},
) {
	const style = dishPhotoStyle(options.focal)
	if (style) img.style.objectPosition = dishPhotoPosition(options.focal)
	for (const [name, value] of Object.entries(
		photoTestAttributes(options.itemId, options.test),
	)) {
		img.setAttribute(name, value)
	}
}
