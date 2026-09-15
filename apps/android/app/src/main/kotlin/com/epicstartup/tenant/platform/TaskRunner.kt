package com.epicstartup.tenant.platform

import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors

/**
 * Runs the blocking core calls (network, Keystore) off the main thread and
 * delivers the result back on it.
 *
 * A pair of worker threads and a `Handler` replace coroutines + ViewModel: the
 * app has a handful of short requests, and `kotlinx-coroutines` is real weight
 * in a download we are trying to keep under a megabyte.
 */
object TaskRunner {
	private val executor = Executors.newFixedThreadPool(2) { runnable ->
		Thread(runnable, "tenant-io").apply { isDaemon = true }
	}
	private val main = Handler(Looper.getMainLooper())

	fun <T> run(
		work: () -> T,
		onSuccess: (T) -> Unit = {},
		onFailure: (Exception) -> Unit = {},
	) {
		executor.execute {
			val outcome = try {
				Outcome.Success(work())
			} catch (error: Exception) {
				Outcome.Failure(error)
			}
			main.post {
				when (outcome) {
					is Outcome.Success -> onSuccess(outcome.value)
					is Outcome.Failure -> onFailure(outcome.error)
				}
			}
		}
	}

	private sealed interface Outcome<out T> {
		data class Success<T>(val value: T) : Outcome<T>
		data class Failure(val error: Exception) : Outcome<Nothing>
	}
}
