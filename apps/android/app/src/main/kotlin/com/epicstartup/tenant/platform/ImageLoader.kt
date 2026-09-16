package com.epicstartup.tenant.platform

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import com.epicstartup.tenant.core.config.TenantConfiguration
import com.epicstartup.tenant.core.support.IconDecode
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Loads the org's site icon without an image library.
 *
 * Coil/Glide would add hundreds of kilobytes and a disk cache for a single
 * 36dp image, so this is a tiny memory cache plus `BitmapFactory`. Failures are
 * silent: the header simply renders without an icon.
 */
object ImageLoader {
	private const val MAX_REDIRECTS = 3

	private val cache = LruCache<String, Bitmap>(16)

	/** Every callback waiting on a URL, so a re-created view is not dropped. */
	private val inFlight = mutableMapOf<String, MutableList<(Bitmap) -> Unit>>()

	fun load(url: String, onLoaded: (Bitmap) -> Unit) {
		cache.get(url)?.let {
			onLoaded(it)
			return
		}
		synchronized(inFlight) {
			val waiting = inFlight[url]
			if (waiting != null) {
				waiting += onLoaded
				return
			}
			inFlight[url] = mutableListOf(onLoaded)
		}

		TaskRunner.run(
			work = { fetch(url) },
			onSuccess = { bitmap ->
				val waiting = synchronized(inFlight) { inFlight.remove(url) }.orEmpty()
				if (bitmap != null) {
					cache.put(url, bitmap)
					waiting.forEach { it(bitmap) }
				}
			},
			onFailure = { synchronized(inFlight) { inFlight.remove(url) } },
		)
	}

	/**
	 * The URL comes from the org's published payload, so it is treated as
	 * untrusted: only HTTPS (or loopback HTTP, as in local development) is
	 * fetched, and redirects are followed by hand so every hop is checked too.
	 */
	private fun fetch(url: String): Bitmap? {
		var target = url
		repeat(MAX_REDIRECTS + 1) {
			if (!TenantConfiguration.isTransportSafe(target)) return null
			val connection = try {
				URL(target).openConnection() as HttpURLConnection
			} catch (error: Exception) {
				return null
			}
			try {
				connection.connectTimeout = 10_000
				connection.readTimeout = 10_000
				connection.instanceFollowRedirects = false
				when (connection.responseCode) {
					in 200..299 -> return connection.inputStream.use { decodeIcon(it) }
					in 300..399 -> {
						val location = connection.getHeaderField("Location") ?: return null
						target = URL(URL(target), location).toString()
					}
					else -> return null
				}
			} catch (error: Exception) {
				return null
			} finally {
				connection.disconnect()
			}
		}
		return null
	}

	/**
	 * Reads the icon into a bitmap sized for the header, never for the original
	 * upload: bounds are inspected first and everything bigger than
	 * [IconDecode.TARGET_SIZE] is downsampled, so a multi-megapixel icon cannot
	 * allocate its way into an `OutOfMemoryError`.
	 */
	private fun decodeIcon(stream: InputStream): Bitmap? {
		val bytes = readBounded(stream) ?: return null
		val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
		BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
		val plan = IconDecode.plan(bounds.outWidth, bounds.outHeight) ?: return null
		val options = BitmapFactory.Options().apply { inSampleSize = plan.sampleSize }
		return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
	}

	/** At most [IconDecode.MAX_BYTES]: a bigger body is refused, not buffered. */
	private fun readBounded(stream: InputStream): ByteArray? {
		val buffer = ByteArrayOutputStream()
		val chunk = ByteArray(16 * 1024)
		while (true) {
			val read = stream.read(chunk)
			if (read < 0) return buffer.toByteArray()
			if (buffer.size() + read > IconDecode.MAX_BYTES) return null
			buffer.write(chunk, 0, read)
		}
	}
}
