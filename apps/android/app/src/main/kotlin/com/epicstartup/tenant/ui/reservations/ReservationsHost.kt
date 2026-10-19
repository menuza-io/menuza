package com.epicstartup.tenant.ui.reservations

import com.epicstartup.tenant.core.model.CustomerProfile
import com.epicstartup.tenant.platform.TaskRunner

/**
 * What [ReservationsController] needs from the app shell. `AppState` is the one
 * production implementation; the seam lets the controller run on the JVM.
 */
interface ReservationsHost {
	val languageCode: String
	val profile: CustomerProfile?
	val resStack: List<String>

	fun pushRes(key: String)

	fun replaceRes(key: String)

	fun popRes(): Boolean

	fun popResTo(key: String)

	fun notifyReservationsChanged()
}

/** Runs blocking work off the main thread and delivers the result on it. */
interface ReservationTasks {
	fun <T> run(
		work: () -> T,
		onSuccess: (T) -> Unit = {},
		onFailure: (Exception) -> Unit = {},
	)
}

internal object AndroidReservationTasks : ReservationTasks {
	override fun <T> run(work: () -> T, onSuccess: (T) -> Unit, onFailure: (Exception) -> Unit) =
		TaskRunner.run(work, onSuccess, onFailure)
}
