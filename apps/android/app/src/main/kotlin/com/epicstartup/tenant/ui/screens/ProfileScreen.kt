package com.epicstartup.tenant.ui.screens

import android.app.AlertDialog
import android.text.InputType
import android.view.View
import android.widget.TextView
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.localization.SiteLocale
import com.epicstartup.tenant.core.support.PhoneNumber
import com.epicstartup.tenant.ui.components.FormMessage
import com.epicstartup.tenant.ui.components.PrimaryButton
import com.epicstartup.tenant.ui.components.SecondaryButton
import com.epicstartup.tenant.ui.components.ThemedCard
import com.epicstartup.tenant.ui.components.ThemedPickerRow
import com.epicstartup.tenant.ui.components.ThemedTextField
import com.epicstartup.tenant.ui.components.dp
import com.epicstartup.tenant.ui.components.style

/**
 * The signed-in customer's profile: name + email are editable, the phone number
 * is the verified identity and stays read-only (same rule as Sites).
 */
internal class ProfileScreen(private val host: ScreenHost) : Screen {
	private val nameField = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.profile_name),
		placeholder = host.uiContext.getString(R.string.name_placeholder),
		inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS,
		autofillHints = arrayOf(View.AUTOFILL_HINT_NAME),
		onTextChanged = { updateAction() },
	)
	private val emailField = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.profile_email),
		placeholder = "jane@example.com",
		inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
		autofillHints = arrayOf(View.AUTOFILL_HINT_EMAIL_ADDRESS),
	)
	private val phoneField = ThemedTextField(
		context = host.uiContext,
		palette = host.palette,
		label = host.uiContext.getString(R.string.profile_phone),
		placeholder = "",
		inputType = InputType.TYPE_CLASS_PHONE,
		isDisabled = true,
	)
	private val message = FormMessage(host.uiContext, host.palette)
	private val saved = FormMessage(host.uiContext, host.palette)
	private val save = PrimaryButton(host.uiContext, host.palette)
	private val languageRow = ThemedPickerRow(host.uiContext, host.palette)
	private val container: View

	private var loaded = false
	private var loadedName = ""
	private var loadedEmail = ""

	override val view: View get() = container

	init {
		val details = ThemedCard(host.uiContext, host.palette)
		details.titleBlock(
			context = host.uiContext,
			palette = host.palette,
			title = host.uiContext.getString(R.string.profile_title),
			subtitle = host.uiContext.getString(R.string.profile_subtitle),
		)
		details.addField(nameField, host.uiContext.dp(16f))
		details.addField(emailField, host.uiContext.dp(16f))
		details.addField(phoneField, host.uiContext.dp(16f))

		val locked = TextView(host.uiContext).apply {
			text = host.uiContext.getString(R.string.profile_phone_locked)
			style(12f, host.palette.mutedForeground, typeface = host.palette.bodyTypeface)
		}
		details.addField(locked, host.uiContext.dp(6f))
		details.addField(message, host.uiContext.dp(16f))
		details.addField(saved, host.uiContext.dp(8f))
		details.addField(save, host.uiContext.dp(16f))

		val language = ThemedCard(host.uiContext, host.palette)
		val languageLabel = TextView(host.uiContext).apply {
			text = host.uiContext.getString(R.string.profile_language)
			style(14f, host.palette.cardForeground, typeface = host.palette.bodyBoldTypeface)
		}
		language.addView(languageLabel)
		languageRow.setOnClickListener { showLanguagePicker() }
		language.addField(languageRow, host.uiContext.dp(12f))

		val signOut = SecondaryButton(host.uiContext, host.palette).apply {
			text = host.uiContext.getString(R.string.profile_sign_out)
			setOnClickListener { host.state.signOut() }
		}

		container = host.uiContext.screenScroll(
			host.uiContext.screenColumn().apply {
				addSpaced(details, 0)
				addSpaced(language, host.uiContext.dp(20f))
				addSpaced(signOut, host.uiContext.dp(20f))
			},
		)
	}

	override fun update() {
		val profile = host.state.profile
		val name = profile?.name.orEmpty()
		val email = profile?.email.orEmpty()
		if (!loaded || name != loadedName || email != loadedEmail) {
			nameField.setText(name)
			emailField.setText(email)
			loadedName = name
			loadedEmail = email
			loaded = true
		}
		phoneField.setText(PhoneNumber.display(profile?.phone.orEmpty()))

		languageRow.text = host.state.languageOverride?.let { SiteLocale.label(it) }
			?: host.uiContext.getString(R.string.profile_language_system)

		message.bind(host.state.errorMessage)
		saved.bind(
			if (host.state.didSaveProfile) host.uiContext.getString(R.string.profile_saved) else null,
			isSuccess = true,
		)
		updateAction()
	}

	private fun updateAction() {
		save.bind(
			title = host.uiContext.getString(R.string.profile_save),
			isLoading = host.state.isSavingProfile,
			isEnabled = nameField.text.trim().length >= 2,
		) {
			nameField.input.clearFocus()
			emailField.input.clearFocus()
			host.state.saveProfile(nameField.text.trim(), emailField.text.trim())
		}
	}

	private fun showLanguagePicker() {
		val languages = host.state.availableLanguages
		val labels = buildList {
			add(host.uiContext.getString(R.string.profile_language_system))
			languages.forEach { add(SiteLocale.label(it)) }
		}
		val current = host.state.languageOverride
		val checked = if (current == null) 0 else languages.indexOf(current).let { if (it < 0) 0 else it + 1 }

		AlertDialog.Builder(host.activityContext)
			.setTitle(R.string.profile_language)
			.setSingleChoiceItems(labels.toTypedArray(), checked) { dialog, which ->
				// Dismiss before the state change: a language switch recreates the
				// Activity, and the dialog must not outlive it.
				dialog.dismiss()
				host.state.languageOverride = if (which == 0) null else languages[which - 1]
			}
			.show()
	}
}
