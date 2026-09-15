package com.epicstartup.tenant.ui.screens

import android.content.Context
import android.content.res.ColorStateList
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.support.PhoneNumber
import com.epicstartup.tenant.ui.AppState
import com.epicstartup.tenant.ui.ThemePalette
import com.epicstartup.tenant.ui.components.FormMessage
import com.epicstartup.tenant.ui.components.PrimaryButton
import com.epicstartup.tenant.ui.components.ThemedCard
import com.epicstartup.tenant.ui.components.ThemedTextField
import com.epicstartup.tenant.ui.components.dp
import com.epicstartup.tenant.ui.components.style

/**
 * What a screen needs from the Activity: the state, the resolved palette, and
 * the localized + themed context every view is built with.
 */
internal interface ScreenHost {
	val state: AppState
	val palette: ThemePalette
	val uiContext: Context
	val activityContext: Context

	fun openUrl(url: String)
}

internal interface Screen {
	val view: View

	/** Re-reads the state; called on every state change. */
	fun update() = Unit
}

// MARK: - Layout helpers

internal fun Context.screenColumn(spacing: Int = 20): LinearLayout =
	LinearLayout(this).apply {
		orientation = LinearLayout.VERTICAL
		setPadding(dp(20f), dp(20f), dp(20f), dp(20f))
	}

internal fun LinearLayout.addSpaced(child: View, spacing: Int) {
	val params = LinearLayout.LayoutParams(
		ViewGroup.LayoutParams.MATCH_PARENT,
		ViewGroup.LayoutParams.WRAP_CONTENT,
	)
	if (childCount > 0) params.topMargin = spacing
	addView(child, params)
}

internal fun Context.screenScroll(content: View): ScrollView =
	ScrollView(this).apply {
		isFillViewport = true
		addView(content)
	}

/** Card title + subtitle pair, as used by every auth screen. */
internal fun ThemedCard.titleBlock(
	context: Context,
	palette: ThemePalette,
	title: String,
	subtitle: String,
) {
	val titleView = TextView(context).apply {
		text = title
		style(18f, palette.cardForeground, typeface = palette.headingBoldTypeface)
	}
	val subtitleView = TextView(context).apply {
		text = subtitle
		style(14f, palette.mutedForeground, typeface = palette.bodyTypeface)
	}
	val titleParams = LinearLayout.LayoutParams(
		ViewGroup.LayoutParams.MATCH_PARENT,
		ViewGroup.LayoutParams.WRAP_CONTENT,
	)
	addView(titleView, titleParams)
	val subtitleParams = LinearLayout.LayoutParams(
		ViewGroup.LayoutParams.MATCH_PARENT,
		ViewGroup.LayoutParams.WRAP_CONTENT,
	)
	subtitleParams.topMargin = context.dp(6f)
	addView(subtitleView, subtitleParams)
}

internal fun ThemedCard.addField(view: View, spacing: Int) {
	val params = LinearLayout.LayoutParams(
		ViewGroup.LayoutParams.MATCH_PARENT,
		ViewGroup.LayoutParams.WRAP_CONTENT,
	)
	params.topMargin = spacing
	addView(view, params)
}

// MARK: - Loading

internal class LoadingScreen(host: ScreenHost) : Screen {
	private val container = LinearLayout(host.uiContext).apply {
		orientation = LinearLayout.VERTICAL
		gravity = Gravity.CENTER
	}

	private val label = TextView(host.uiContext)

	init {
		val spinner = ProgressBar(host.uiContext)
		spinner.indeterminateTintList = ColorStateList.valueOf(host.palette.primary)
		container.addView(
			spinner,
			LinearLayout.LayoutParams(host.uiContext.dp(32f), host.uiContext.dp(32f)).apply {
				gravity = Gravity.CENTER_HORIZONTAL
			},
		)

		label.text = host.uiContext.getString(R.string.app_loading)
		label.style(13f, host.palette.mutedForeground, typeface = host.palette.bodyTypeface)
		container.addView(
			label,
			LinearLayout.LayoutParams(
				ViewGroup.LayoutParams.WRAP_CONTENT,
				ViewGroup.LayoutParams.WRAP_CONTENT,
			).apply {
				gravity = Gravity.CENTER_HORIZONTAL
				topMargin = host.uiContext.dp(12f)
			},
		)
	}

	override val view: View get() = container
}

// MARK: - Failed

internal class FailedScreen(private val host: ScreenHost, private val message: String) : Screen {
	private val container = host.uiContext.screenColumn()

	override val view: View get() = container

	init {
		val text = TextView(host.uiContext).apply {
			this.text = message
			style(14f, host.palette.mutedForeground, typeface = host.palette.bodyTypeface)
			gravity = Gravity.CENTER
		}
		container.addSpaced(text, 0)

		val retry = PrimaryButton(host.uiContext, host.palette).apply {
			bind(
				title = host.uiContext.getString(R.string.app_retry),
				isLoading = false,
				isEnabled = true,
			) { host.state.retry() }
		}
		container.addSpaced(retry, host.uiContext.dp(16f))
	}
}

// MARK: - Connect a site (un-branded builds only)

internal class ConnectScreen(private val host: ScreenHost) : Screen {
	private val card = ThemedCard(host.uiContext, host.palette)
	private val address = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.connect_field_label),
		placeholder = host.uiContext.getString(R.string.connect_placeholder),
		inputType = InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_CLASS_TEXT,
		onTextChanged = { updateAction() },
	)
	private val message = FormMessage(host.uiContext, host.palette)
	private val action = PrimaryButton(host.uiContext, host.palette)
	private val container = host.uiContext.screenScroll(
		host.uiContext.screenColumn().apply {
			card.titleBlock(
				context = host.uiContext,
				palette = host.palette,
				title = host.uiContext.getString(R.string.connect_title),
				subtitle = host.uiContext.getString(R.string.connect_subtitle),
			)
			card.addField(address, host.uiContext.dp(16f))
			card.addField(message, host.uiContext.dp(16f))
			card.addField(action, host.uiContext.dp(16f))
			addSpaced(card, 0)
		},
	)

	override val view: View get() = container

	init {
		action.bind(
			title = host.uiContext.getString(R.string.connect_action),
			isLoading = false,
			isEnabled = false,
		) {
			address.input.clearFocus()
			host.state.connect(address.text)
		}
		address.focusInput()
	}

	override fun update() {
		message.bind(host.state.errorMessage)
		updateAction()
	}

	private fun updateAction() {
		val busy = host.state.phase is AppState.Phase.Loading
		action.bind(
			title = host.uiContext.getString(R.string.connect_action),
			isLoading = busy,
			isEnabled = address.text.trim().isNotEmpty(),
		) {
			address.input.clearFocus()
			host.state.connect(address.text)
		}
	}
}

// MARK: - Sign in

internal class LoginScreen(private val host: ScreenHost) : Screen {
	private val card = ThemedCard(host.uiContext, host.palette)
	private val phone = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.login_phone),
		placeholder = host.uiContext.getString(R.string.login_phone_placeholder),
		inputType = InputType.TYPE_CLASS_PHONE,
		autofillHints = arrayOf(View.AUTOFILL_HINT_PHONE),
		onTextChanged = { updateAction() },
	)
	private val message = FormMessage(host.uiContext, host.palette)
	private val action = PrimaryButton(host.uiContext, host.palette)
	private val container = host.uiContext.screenScroll(
		host.uiContext.screenColumn().apply {
			card.titleBlock(
				context = host.uiContext,
				palette = host.palette,
				title = host.uiContext.getString(R.string.login_title),
				subtitle = host.uiContext.getString(R.string.login_subtitle),
			)
			card.addField(phone, host.uiContext.dp(16f))
			card.addField(message, host.uiContext.dp(16f))
			card.addField(action, host.uiContext.dp(16f))
			addSpaced(card, 0)
		},
	)

	override val view: View get() = container

	init {
		updateAction()
		phone.focusInput()
	}

	override fun update() {
		message.bind(host.state.errorMessage)
		updateAction()
	}

	private fun updateAction() {
		action.bind(
			title = host.uiContext.getString(R.string.login_action),
			isLoading = host.state.isBusy,
			isEnabled = PhoneNumber.isValid(phone.text),
		) {
			phone.input.clearFocus()
			host.state.sendCode(phone.text)
		}
	}
}

// MARK: - One-time code

internal class VerifyScreen(private val host: ScreenHost) : Screen {
	private val card = ThemedCard(host.uiContext, host.palette)
	private val code = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.verify_code),
		placeholder = "123456",
		inputType = InputType.TYPE_CLASS_NUMBER,
		onTextChanged = { updateAction() },
	)
	private val message = FormMessage(host.uiContext, host.palette)
	private val action = PrimaryButton(host.uiContext, host.palette)
	private val resend = TextView(host.uiContext)
	private val changeNumber = TextView(host.uiContext)
	private val container: View

	override val view: View get() = container

	init {
		val phone = PhoneNumber.display(host.state.pendingPhone.orEmpty())
		card.titleBlock(
			context = host.uiContext,
			palette = host.palette,
			title = host.uiContext.getString(R.string.verify_title),
			subtitle = host.uiContext.getString(R.string.verify_subtitle, phone),
		)
		card.addField(code, host.uiContext.dp(16f))
		card.addField(message, host.uiContext.dp(16f))
		card.addField(action, host.uiContext.dp(16f))

		resend.text = host.uiContext.getString(R.string.verify_resend)
		resend.style(13f, host.palette.primary, typeface = host.palette.bodyBoldTypeface)
		resend.setOnClickListener { host.state.resendCode() }

		changeNumber.text = host.uiContext.getString(R.string.verify_change_number)
		changeNumber.style(13f, host.palette.primary, typeface = host.palette.bodyBoldTypeface)
		changeNumber.setOnClickListener { host.state.cancelVerification() }

		val links = LinearLayout(host.uiContext).apply {
			orientation = LinearLayout.HORIZONTAL
			addView(resend)
			addView(
				changeNumber,
				LinearLayout.LayoutParams(
					ViewGroup.LayoutParams.WRAP_CONTENT,
					ViewGroup.LayoutParams.WRAP_CONTENT,
				).apply { marginStart = host.uiContext.dp(16f) },
			)
		}
		card.addField(links, host.uiContext.dp(16f))

		val column = host.uiContext.screenColumn().apply {
			addSpaced(card, 0)
		}
		container = host.uiContext.screenScroll(column)

		updateAction()
		code.focusInput()
	}

	override fun update() {
		message.bind(host.state.errorMessage)
		updateAction()
		// One OTP request at a time: resending or leaving mid-verify would race
		// the in-flight attempt.
		val enabled = !host.state.isBusy
		resend.isEnabled = enabled
		changeNumber.isEnabled = enabled
		resend.alpha = if (enabled) 1f else 0.6f
		changeNumber.alpha = if (enabled) 1f else 0.6f
	}

	private fun updateAction() {
		action.bind(
			title = host.uiContext.getString(R.string.verify_action),
			isLoading = host.state.isBusy,
			isEnabled = code.text.length == 6,
		) {
			code.input.clearFocus()
			host.state.verify(code.text)
		}
	}
}

// MARK: - New customer name

internal class NameScreen(private val host: ScreenHost) : Screen {
	private val card = ThemedCard(host.uiContext, host.palette)
	private val name = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.name_field),
		placeholder = host.uiContext.getString(R.string.name_placeholder),
		inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS,
		autofillHints = arrayOf(View.AUTOFILL_HINT_NAME),
		onTextChanged = { updateAction() },
	)
	private val message = FormMessage(host.uiContext, host.palette)
	private val action = PrimaryButton(host.uiContext, host.palette)
	private val container = host.uiContext.screenScroll(
		host.uiContext.screenColumn().apply {
			card.titleBlock(
				context = host.uiContext,
				palette = host.palette,
				title = host.uiContext.getString(R.string.name_title),
				subtitle = host.uiContext.getString(R.string.name_subtitle),
			)
			card.addField(name, host.uiContext.dp(16f))
			card.addField(message, host.uiContext.dp(16f))
			card.addField(action, host.uiContext.dp(16f))
			addSpaced(card, 0)
		},
	)

	override val view: View get() = container

	init {
		updateAction()
		name.focusInput()
	}

	override fun update() {
		message.bind(host.state.errorMessage)
		updateAction()
	}

	private fun updateAction() {
		action.bind(
			title = host.uiContext.getString(R.string.name_action),
			isLoading = host.state.isBusy,
			isEnabled = name.text.trim().length >= 2,
		) {
			name.input.clearFocus()
			host.state.completeName(name.text)
		}
	}
}
