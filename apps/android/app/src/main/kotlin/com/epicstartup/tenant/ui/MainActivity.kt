package com.epicstartup.tenant.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.theme.SiteColorScheme
import com.epicstartup.tenant.core.theme.SiteTheme
import com.epicstartup.tenant.ui.components.AnnouncementBannerView
import com.epicstartup.tenant.ui.components.BrandHeaderView
import com.epicstartup.tenant.ui.components.dp
import com.epicstartup.tenant.ui.screens.ConnectScreen
import com.epicstartup.tenant.ui.screens.FailedScreen
import com.epicstartup.tenant.ui.screens.LoadingScreen
import com.epicstartup.tenant.ui.screens.LoginScreen
import com.epicstartup.tenant.ui.screens.NameScreen
import com.epicstartup.tenant.ui.screens.ProfileScreen
import com.epicstartup.tenant.ui.screens.Screen
import com.epicstartup.tenant.ui.screens.ScreenHost
import com.epicstartup.tenant.ui.screens.VerifyScreen
import java.util.Locale

/**
 * The app's only Activity: branded chrome (icon, name, announcements) plus the
 * screen for the current [AppState.Phase].
 *
 * There is no navigation library and no fragments — the state machine picks one
 * screen, and the screen is only rebuilt when the *kind* of screen changes, so a
 * state update never clears a half-typed phone number.
 */
class MainActivity : Activity(), ScreenHost {

	private lateinit var appState: AppState
	private lateinit var content: FrameLayout
	private lateinit var header: BrandHeaderView
	private lateinit var banner: AnnouncementBannerView

	private var currentKey: String? = null
	private var currentScreen: Screen? = null
	private var appliedLanguage: String? = null
	private var appliedScheme: SiteColorScheme? = null

	private var paletteCache: Pair<Pair<SiteTheme, SiteColorScheme>, ThemePalette>? = null

	override val state: AppState get() = appState

	override val activityContext: Context get() = this

	/**
	 * Views are built with a context that carries both the resolved language
	 * (including RTL) and the resolved light/dark base theme, so widget defaults
	 * match the tenant's branding.
	 */
	override val uiContext: Context by lazy {
		val configuration = Configuration(resources.configuration)
		val locale = Locale.forLanguageTag(appState.language.code)
		configuration.setLocale(locale)
		configuration.setLayoutDirection(locale)
		val localized = createConfigurationContext(configuration)
		val theme = if (resolvedScheme() == SiteColorScheme.DARK) R.style.AppTheme_Dark else R.style.AppTheme
		ContextThemeWrapper(localized, theme)
	}

	override val palette: ThemePalette
		get() {
			val key = appState.theme to resolvedScheme()
			paletteCache?.let { if (it.first == key) return it.second }
			return ThemePalette(key.first, key.second).also { paletteCache = key to it }
		}

	private val stateListener = object : AppState.Listener {
		override fun onStateChanged() = render()
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		appState = AppStateHolder.get(this)
		appliedLanguage = appState.language.code
		appliedScheme = resolvedScheme()

		applyEdgeToEdge()
		setContentView(buildRoot())
		applySystemBarAppearance()
		render()
		appState.start()

		if (Build.VERSION.SDK_INT >= 33) {
			onBackInvokedDispatcher.registerOnBackInvokedCallback(
				android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
			) {
				if (!handleBack()) finish()
			}
		}
	}

	override fun onStart() {
		super.onStart()
		appState.addListener(stateListener)
		render()
	}

	override fun onStop() {
		appState.removeListener(stateListener)
		super.onStop()
	}

	override fun onConfigurationChanged(newConfig: Configuration) {
		super.onConfigurationChanged(newConfig)
		// A device locale change can change the resolved language; render()
		// recreates the Activity when that (or the appearance) moved.
		render()
	}

	/**
	 * Only reached before API 33: from 33 on, `onBackInvokedCallback` above owns
	 * back (the manifest opts into predictive back), so this override is the
	 * fallback for older devices rather than dead code.
	 */
	@SuppressLint("GestureBackNavigation")
	@Deprecated("Deprecated in Java")
	@Suppress("DEPRECATION")
	override fun onBackPressed() {
		if (!handleBack()) super.onBackPressed()
	}

	override fun openUrl(url: String) {
		val uri = Uri.parse(url)
		if (uri.scheme?.lowercase() !in setOf("http", "https")) return
		runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
	}

	// MARK: - Rendering

	private fun render() {
		if (isFinishing || isDestroyed) return

		val language = appState.language.code
		val scheme = resolvedScheme()
		if (language != appliedLanguage || scheme != appliedScheme) {
			// The locale/appearance the hierarchy was built with no longer
			// matches; rebuilding is cheaper and safer than patching every view.
			recreate()
			return
		}

		header.bind(appState.siteName, appState.iconUrl)

		val announcement = appState.announcements.firstOrNull()
		if (announcement == null) {
			banner.visibility = View.GONE
		} else {
			banner.bind(announcement) { openUrl(it) }
			banner.visibility = View.VISIBLE
		}

		val key = screenKey()
		if (key != currentKey) {
			// Record the key first: building a screen must not be able to
			// re-enter this method and build a second copy of it.
			currentKey = key
			val screen = buildScreen(key)
			currentScreen = screen
			content.removeAllViews()
			content.addView(screen.view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
			// Entering an auth screen drops the previous screen's message.
			if (key == "login" || key == "verify" || key == "name") {
				appState.clearTransientMessages()
			}
		}
		currentScreen?.update()
	}

	private fun screenKey(): String = when (val phase = appState.phase) {
		is AppState.Phase.Loading -> "loading"
		is AppState.Phase.NeedsSite -> "connect"
		is AppState.Phase.Failed -> "failed:${phase.message}"
		is AppState.Phase.Ready -> when {
			appState.isSignedIn && appState.needsName -> "name"
			appState.isSignedIn -> "profile"
			appState.pendingPhone != null -> "verify"
			else -> "login"
		}
	}

	private fun buildScreen(key: String): Screen = when {
		key == "loading" -> LoadingScreen(this)
		key == "connect" -> ConnectScreen(this)
		key.startsWith("failed:") -> FailedScreen(this, key.removePrefix("failed:"))
		key == "name" -> NameScreen(this)
		key == "profile" -> ProfileScreen(this)
		key == "verify" -> VerifyScreen(this)
		else -> LoginScreen(this)
	}

	private fun buildRoot(): View {
		val context = uiContext
		val root = LinearLayout(context).apply {
			orientation = LinearLayout.VERTICAL
			setBackgroundColor(palette.background)
		}

		header = BrandHeaderView(context, palette)
		root.addView(header, LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

		val divider = View(context).apply { setBackgroundColor(palette.border) }
		root.addView(divider, LinearLayout.LayoutParams(MATCH_PARENT, context.dp(1f)))

		banner = AnnouncementBannerView(context, palette).apply { visibility = View.GONE }
		root.addView(banner, LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

		content = FrameLayout(context)
		root.addView(content, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

		if (Build.VERSION.SDK_INT >= 30) {
			// Edge-to-edge (enforced on API 35+): pad the root by the system bars
			// so the header is never under the status bar.
			root.setOnApplyWindowInsetsListener { view, insets ->
				val bars = insets.getInsets(
					WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
				)
				view.setPadding(0, bars.top, 0, bars.bottom)
				insets
			}
		}
		return root
	}

	// MARK: - Window chrome

	private fun resolvedScheme(): SiteColorScheme = appState.theme.resolvedScheme(systemIsDark())

	private fun systemIsDark(): Boolean =
		(resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

	private fun applyEdgeToEdge() {
		window.setBackgroundDrawable(ColorDrawable(palette.background))
		if (Build.VERSION.SDK_INT in 30..34) {
			// Edge-to-edge is enforced from API 35 on; below that it is opt-in,
			// and below 30 the system fits the window and colors the bars.
			@Suppress("DEPRECATION")
			window.setDecorFitsSystemWindows(false)
		} else if (Build.VERSION.SDK_INT < 30) {
			@Suppress("DEPRECATION")
			window.statusBarColor = palette.background
			@Suppress("DEPRECATION")
			window.navigationBarColor = palette.background
		}
	}

	private fun applySystemBarAppearance() {
		val light = resolvedScheme() == SiteColorScheme.LIGHT
		if (Build.VERSION.SDK_INT >= 30) {
			val appearance = if (light) {
				WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
					WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
			} else {
				0
			}
			window.insetsController?.setSystemBarsAppearance(
				appearance,
				WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
					WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
			)
		} else {
			@Suppress("DEPRECATION")
			window.decorView.systemUiVisibility =
				if (light) View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else 0
		}
	}

	private fun handleBack(): Boolean {
		// On the OTP screen, back abandons the attempt instead of leaving the app.
		if (!appState.isSignedIn && appState.pendingPhone != null) {
			appState.cancelVerification()
			return true
		}
		return false
	}

	private companion object {
		const val MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT
		const val WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT
	}
}
