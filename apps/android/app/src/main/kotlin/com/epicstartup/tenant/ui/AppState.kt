package com.epicstartup.tenant.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.config.TenantConfiguration
import com.epicstartup.tenant.core.localization.AppLanguage
import com.epicstartup.tenant.core.localization.SiteLocale
import com.epicstartup.tenant.core.model.CustomerProfile
import com.epicstartup.tenant.core.model.PublicOrganization
import com.epicstartup.tenant.core.model.PublicSiteAnnouncement
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.net.TenantApiClient
import com.epicstartup.tenant.core.session.CustomerSession
import com.epicstartup.tenant.core.support.PhoneNumber
import com.epicstartup.tenant.core.support.SiteAddress
import com.epicstartup.tenant.core.theme.SiteTheme
import com.epicstartup.tenant.platform.AndroidTenantConfiguration
import com.epicstartup.tenant.platform.AppPreferences
import com.epicstartup.tenant.platform.KeystoreTokenStorage
import com.epicstartup.tenant.platform.TaskRunner
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The app's single source of truth: tenant branding, the customer session, and
 * the profile shown behind login (mirrors `AppState` in apps/ios).
 *
 * One instance lives for the process (see [AppStateHolder]) so an Activity
 * recreation — a language switch, a rotation, a process restore — never
 * refetches branding or drops a half-typed form. Mutations happen on the main
 * thread: callers enter from the UI, and every background result is posted back
 * by [TaskRunner].
 */
class AppState(private val context: Context) {

	sealed interface Phase {
		data object Loading : Phase
		/** No tenant bound yet — the customer connects their site. */
		data object NeedsSite : Phase
		data object Ready : Phase
		data class Failed(val message: String) : Phase
	}

	fun interface Listener {
		fun onStateChanged()
	}

	private val listeners = CopyOnWriteArrayList<Listener>()
	private val preferences = AppPreferences(context)

	var phase: Phase = Phase.Loading
		private set
	var organization: PublicOrganization? = null
		private set
	var theme: SiteTheme = SiteTheme.fallback
		private set
	var profile: CustomerProfile? = null
		private set
	var isSignedIn: Boolean = false
		private set
	var needsName: Boolean = false
		private set
	var isBusy: Boolean = false
		private set
	var isSavingProfile: Boolean = false
		private set
	var didSaveProfile: Boolean = false
		private set
	var errorMessage: String? = null
		private set
	var pendingPhone: String? = null
		private set

	private var configuration: TenantConfiguration = AndroidTenantConfiguration.from(context)
	private var client = TenantApiClient(configuration)
	private var session: CustomerSession? = null
	private var started = false

	/**
	 * Bumped whenever the sign-in attempt is abandoned, so a late OTP response
	 * cannot sign the customer in after they backed out.
	 */
	private var authAttempt = 0

	private var localizedCache: Pair<String, Context>? = null

	init {
		// A white-label build is bound to one tenant at build time; that binding
		// wins over anything a customer typed into an earlier un-branded install,
		// so the app never asks (or re-points) in the shipping case.
		val buildAddress = configuration.siteAddress
		configuration = configuration.withSiteAddress(
			SiteAddress.resolve(build = buildAddress, stored = preferences.siteAddress),
		)
		if (buildAddress.isBound) preferences.siteAddress = null
		client = TenantApiClient(configuration)
	}

	// MARK: - Branding

	val siteName: String get() = organization?.name ?: "Tenant"

	val iconUrl: String? get() = organization?.iconUrl(configuration.appBaseUrl)

	val announcements: List<PublicSiteAnnouncement> get() = organization?.announcements.orEmpty()

	val siteAddress: SiteAddress get() = configuration.siteAddress

	/** UI language: customer override → device language → org language → English. */
	val language: AppLanguage
		get() = AppLanguage.resolve(
			organization = organization,
			deviceLanguages = deviceLanguages(),
			appLocales = SiteLocale.contentLocales,
			override = preferences.languageOverride,
		)

	var languageOverride: String?
		get() = preferences.languageOverride
		set(value) {
			if (preferences.languageOverride == value) return
			preferences.languageOverride = value
			notifyChanged()
		}

	val availableLanguages: List<String> get() = SiteLocale.contentLocales

	// MARK: - Lifecycle

	fun start() {
		if (started) return
		started = true
		if (!configuration.isBoundToTenant) {
			phase = Phase.NeedsSite
			notifyChanged()
			return
		}
		loadSite()
	}

	/** Connects the app to a tenant the customer typed in. */
	fun connect(input: String) {
		val address = SiteAddress.parse(input, configuration.brandDomain)
		if (address == null) {
			errorMessage = string(R.string.connect_error)
			notifyChanged()
			return
		}
		loadSite(bindingTo = address)
	}

	fun retry() {
		if (!configuration.isBoundToTenant) {
			phase = Phase.NeedsSite
			notifyChanged()
			return
		}
		loadSite()
	}

	/**
	 * Loads the org's published branding.
	 *
	 * The binding is only persisted once the tenant's payload resolves, so a
	 * typo cannot leave the app pointed at a site that does not exist.
	 */
	private fun loadSite(bindingTo: SiteAddress? = null) {
		val previousAddress = configuration.siteAddress
		if (bindingTo != null) {
			configuration = configuration.withSiteAddress(bindingTo)
			client = TenantApiClient(configuration)
		}

		phase = Phase.Loading
		errorMessage = null
		notifyChanged()

		val targetClient = client
		TaskRunner.run(
			work = {
				targetClient.fetchOrganization(
					locale = null,
					acceptLanguage = deviceLanguages().joinToString(", "),
				)
			},
			onSuccess = { organization ->
				if (bindingTo != null) preferences.siteAddress = bindingTo
				this.organization = organization
				this.theme = SiteTheme(organization.theme)
				configureSession(organization)
				// `notifyChanged` below also lets listeners notice that the
				// negotiated language changed (MainActivity recreates itself then).
				phase = Phase.Ready
				notifyChanged()
			},
			onFailure = { error ->
				if (bindingTo != null) {
					// Roll back for any failure (decoding errors included) so a
					// failed attempt cannot strand the app on a binding that does
					// not resolve.
					configuration = configuration.withSiteAddress(previousAddress)
					client = TenantApiClient(configuration)
					phase = if (previousAddress.isBound) {
						Phase.Failed(messageFor(error))
					} else {
						Phase.NeedsSite
					}
					errorMessage = messageFor(error)
				} else {
					phase = Phase.Failed(messageFor(error))
				}
				notifyChanged()
			},
		)
	}

	/** Rebuilds the API client for the org's data region and restores any session. */
	private fun configureSession(organization: PublicOrganization) {
		configuration = configuration.withDataRegion(organization.resolvedDataRegion)
		val client = TenantApiClient(configuration)
		this.client = client

		TaskRunner.run(
			// The session is built here, not on the main thread: its constructor
			// reads SharedPreferences and unwraps the Android Keystore.
			work = {
				val session = CustomerSession(client, KeystoreTokenStorage(context))
				val tokens = session.restore()
				// A stored session belongs to one org; drop it when the tenant
				// changes. It is cleared locally on purpose — the tokens may
				// belong to a tenant in another region, and this org's node must
				// never see them.
				if (tokens != null && tokens.orgId != organization.id) {
					session.clearLocalSession()
					null to session
				} else {
					tokens to session
				}
			},
			onSuccess = { (tokens, session) ->
				this.session = session
				isSignedIn = tokens != null
				notifyChanged()
				if (tokens != null) loadProfile()
			},
			onFailure = { error ->
				errorMessage = messageFor(error)
				notifyChanged()
			},
		)
	}

	// MARK: - Authentication

	fun sendCode(phone: String) {
		val session = session ?: return
		if (!PhoneNumber.isValid(phone)) {
			errorMessage = string(R.string.login_invalid_phone)
			notifyChanged()
			return
		}
		isBusy = true
		errorMessage = null
		notifyChanged()

		TaskRunner.run(
			work = { session.sendCode(phone) },
			onSuccess = {
				pendingPhone = PhoneNumber.normalize(phone)
				isBusy = false
				notifyChanged()
			},
			onFailure = { error ->
				errorMessage = messageFor(error)
				isBusy = false
				notifyChanged()
			},
		)
	}

	fun verify(code: String) {
		val session = session ?: return
		val phone = pendingPhone ?: return
		authAttempt += 1
		val attempt = authAttempt
		isBusy = true
		errorMessage = null
		notifyChanged()

		TaskRunner.run(
			work = { session.verify(phone = phone, code = code) },
			onSuccess = { result ->
				if (attempt != authAttempt) return@run
				isBusy = false
				isSignedIn = true
				if (result.needsName == true) {
					needsName = true
					notifyChanged()
				} else {
					notifyChanged()
					loadProfile()
				}
			},
			onFailure = { error ->
				if (attempt != authAttempt) return@run
				isBusy = false
				errorMessage = messageFor(error)
				notifyChanged()
			},
		)
	}

	fun resendCode() {
		val phone = pendingPhone ?: return
		sendCode(phone)
	}

	fun cancelVerification() {
		// Abandon the attempt: an in-flight `verify` that lands later must not
		// sign the customer in, and its error must not reappear.
		authAttempt += 1
		pendingPhone = null
		errorMessage = null
		isBusy = false
		notifyChanged()
	}

	fun completeName(name: String) {
		val session = session ?: return
		isBusy = true
		errorMessage = null
		notifyChanged()

		TaskRunner.run(
			work = { session.updateProfile(name = name, email = null) },
			onSuccess = { profile ->
				this.profile = profile
				needsName = false
				isBusy = false
				notifyChanged()
			},
			onFailure = { error ->
				errorMessage = messageFor(error)
				isBusy = false
				notifyChanged()
			},
		)
	}

	fun signOut() {
		authAttempt += 1
		val session = session
		isSignedIn = false
		profile = null
		needsName = false
		pendingPhone = null
		errorMessage = null
		notifyChanged()

		if (session != null) TaskRunner.run(work = { session.signOut() })
	}

	// MARK: - Profile

	fun loadProfile() {
		val session = session ?: return
		if (!isSignedIn) return

		TaskRunner.run(
			work = { session.profile() },
			onSuccess = { profile ->
				this.profile = profile
				if (profile.needsName == true) needsName = true
				notifyChanged()
			},
			onFailure = { error ->
				if (error is ApiException && error.isUnauthorized) {
					isSignedIn = false
					profile = null
				} else {
					errorMessage = messageFor(error)
				}
				notifyChanged()
			},
		)
	}

	fun saveProfile(name: String, email: String) {
		val session = session ?: return
		isSavingProfile = true
		errorMessage = null
		didSaveProfile = false
		notifyChanged()

		TaskRunner.run(
			work = { session.updateProfile(name = name, email = email) },
			onSuccess = { profile ->
				this.profile = profile
				isSavingProfile = false
				didSaveProfile = true
				notifyChanged()
			},
			onFailure = { error ->
				errorMessage = messageFor(error, R.string.profile_network_error)
				isSavingProfile = false
				notifyChanged()
			},
		)
	}

	fun clearTransientMessages() {
		if (errorMessage == null && !didSaveProfile) return
		errorMessage = null
		didSaveProfile = false
		notifyChanged()
	}

	// MARK: - Listeners

	fun addListener(listener: Listener) {
		listeners += listener
	}

	fun removeListener(listener: Listener) {
		listeners -= listener
	}

	private fun notifyChanged() {
		listeners.forEach { it.onStateChanged() }
	}

	// MARK: - Helpers

	/** Localized strings for state messages (the UI has its own themed context). */
	fun string(id: Int): String = localizedContext().getString(id)

	private fun localizedContext(): Context {
		val code = language.code
		localizedCache?.let { if (it.first == code) return it.second }
		val configuration = Configuration(context.resources.configuration)
		val locale = Locale.forLanguageTag(code)
		configuration.setLocale(locale)
		configuration.setLayoutDirection(locale)
		val created = context.createConfigurationContext(configuration)
		localizedCache = code to created
		return created
	}

	private fun deviceLanguages(): List<String> =
		android.os.LocaleList.getDefault().toLanguageTags().split(',').map { it.trim() }

	/** Server messages are English; transport failures get a localized one. */
	private fun messageFor(error: Exception, networkErrorRes: Int = R.string.login_network_error): String {
		val apiError = error as? ApiException ?: return string(networkErrorRes)
		if (apiError.isTransportFailure) return string(networkErrorRes)
		return apiError.message
	}
}

/**
 * Process-wide holder so an Activity recreation keeps the loaded tenant and
 * session (the Android equivalent of iOS keeping `@StateObject` alive).
 */
object AppStateHolder {
	// The singleton deliberately holds the *application* context (never an
	// Activity), so there is nothing to leak across a configuration change.
	@SuppressLint("StaticFieldLeak")
	@Volatile
	private var state: AppState? = null

	fun get(context: Context): AppState =
		state ?: synchronized(this) {
			state ?: AppState(context.applicationContext).also { state = it }
		}
}
