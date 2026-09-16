package com.epicstartup.tenant.core.support

/**
 * Decode plan for the org's published site icon.
 *
 * The icon is drawn at 36dp, but the published original can be any size — a
 * phone that decodes a multi-megapixel original to draw a 36dp image is an
 * `OutOfMemoryError` waiting to happen on a low-end device. The caller reads
 * the bounds first (`BitmapFactory.Options.inJustDecodeBounds`), then asks here
 * what to do: refuse something that is not a sane image at all, and otherwise
 * downsample it to roughly [TARGET_SIZE] pixels on the long side.
 */
object IconDecode {
	/** The header draws 36dp; 192px leaves headroom for the densest screens. */
	const val TARGET_SIZE = 192

	/** Compressed bytes worth buffering: the stream is read twice (bounds, then pixels). */
	const val MAX_BYTES = 4 * 1024 * 1024

	/** Well above any real icon: a 32MP / 8192px image is not branding. */
	private const val MAX_DIMENSION = 8_192
	private const val MAX_PIXELS = 32L * 1024 * 1024

	data class Plan(val width: Int, val height: Int, val sampleSize: Int)

	/** `null` when the image is not decodable, or too big to be an icon. */
	fun plan(width: Int, height: Int): Plan? {
		if (width <= 0 || height <= 0) return null
		if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null
		if (width.toLong() * height.toLong() > MAX_PIXELS) return null
		return Plan(width = width, height = height, sampleSize = sampleSizeFor(width, height))
	}

	/**
	 * The largest power of two that keeps both sides at or above
	 * [TARGET_SIZE] (`BitmapFactory` rounds any other value down to one).
	 */
	fun sampleSizeFor(width: Int, height: Int): Int {
		var sample = 1
		while (width / (sample * 2) >= TARGET_SIZE && height / (sample * 2) >= TARGET_SIZE) {
			sample *= 2
		}
		return sample
	}
}
