package com.epicstartup.tenant.ui.components

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Paint
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.model.PublicSiteAnnouncement
import com.epicstartup.tenant.platform.ImageLoader
import com.epicstartup.tenant.ui.ThemePalette

// Shared, themed building blocks (the Android half of apps/ios `ThemedControls`).
// Every view is constructed in code: no XML layout is shipped, and no widget
// library is linked — `android.widget` is already on the device.

/** Branded chrome: the org's icon and name. */
internal class BrandHeaderView(context: Context, private val palette: ThemePalette) :
	LinearLayout(context) {
	private val icon = ImageView(context)
	private val title = TextView(context)
	private var currentIconUrl: String? = null

	init {
		orientation = HORIZONTAL
		gravity = Gravity.CENTER_VERTICAL
		setPadding(context.dp(20f), context.dp(14f), context.dp(20f), context.dp(14f))
		setBackgroundColor(palette.background)

		icon.scaleType = ImageView.ScaleType.FIT_CENTER
		icon.visibility = GONE
		addView(icon, LayoutParams(context.dp(36f), context.dp(36f)))

		title.maxLines = 1
		title.ellipsize = TextUtils.TruncateAt.END
		title.style(17f, palette.foreground, typeface = palette.headingBoldTypeface)
		val titleParams = LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
		titleParams.marginStart = context.dp(12f)
		addView(title, titleParams)
	}

	fun bind(name: String, iconUrl: String?) {
		title.text = name
		if (iconUrl == currentIconUrl) return
		currentIconUrl = iconUrl
		if (iconUrl == null) {
			icon.setImageDrawable(null)
			icon.visibility = GONE
			return
		}
		ImageLoader.load(iconUrl) { bitmap ->
			// A slower request for a previous URL must not overwrite the icon
			// this header is currently bound to.
			if (iconUrl != currentIconUrl) return@load
			val radius = context.dpFloat(palette.controlRadiusPx.coerceAtLeast(6f))
			icon.setImageDrawable(RoundedCornerDrawable(bitmap, radius))
			icon.visibility = VISIBLE
		}
	}
}

/** Mirrors the Sites announcement banner (type → colors). */
internal class AnnouncementBannerView(context: Context, private val palette: ThemePalette) :
	LinearLayout(context) {
	private val message = TextView(context)
	private val link = TextView(context)

	init {
		orientation = HORIZONTAL
		gravity = Gravity.CENTER_VERTICAL
		setPadding(context.dp(16f), context.dp(10f), context.dp(16f), context.dp(10f))

		message.style(13f, palette.primaryForeground)
		message.gravity = Gravity.CENTER
		addView(message, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

		link.style(13f, palette.primaryForeground, bold = true)
		link.paintFlags = link.paintFlags or Paint.UNDERLINE_TEXT_FLAG
		val linkParams = LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
		linkParams.marginStart = context.dp(8f)
		link.visibility = GONE
		addView(link, linkParams)
	}

	fun bind(announcement: PublicSiteAnnouncement, onOpenLink: (String) -> Unit) {
		val background = when (announcement.type) {
			"warning" -> palette.accent
			"error" -> palette.destructive
			else -> palette.primary
		}
		val foreground = when (announcement.type) {
			"warning" -> palette.accentForeground
			"error" -> palette.destructiveForeground
			else -> palette.primaryForeground
		}
		setBackgroundColor(background)
		message.setTextColor(foreground)
		link.setTextColor(foreground)
		message.text = announcement.content

		val url = announcement.linkUrl
		if (url.isNullOrEmpty()) {
			link.visibility = GONE
			link.setOnClickListener(null)
		} else {
			link.text = announcement.linkLabel ?: context.getString(R.string.announcement_learn_more)
			link.visibility = VISIBLE
			link.setOnClickListener { onOpenLink(url) }
		}
	}
}

/** A themed surface for a screen's content. */
internal class ThemedCard(context: Context, palette: ThemePalette) : LinearLayout(context) {
	init {
		orientation = VERTICAL
		setPadding(context.dp(24f), context.dp(24f), context.dp(24f), context.dp(24f))
		background = roundedBackground(
			fill = palette.card,
			radiusPx = palette.radiusPx,
			strokeColor = palette.border,
			strokeWidthPx = context.dp(1f),
		)
	}
}

/** The primary call to action, with an inline spinner. */
internal class PrimaryButton(context: Context, private val palette: ThemePalette) :
	FrameLayout(context) {
	private val label = TextView(context)
	private val spinner = ProgressBar(context, null, android.R.attr.progressBarStyleSmall)
	private var onClick: (() -> Unit)? = null

	init {
		background = roundedBackground(palette.primary, palette.radiusPx)
		isClickable = true
		isFocusable = true

		label.style(15f, palette.primaryForeground, typeface = palette.bodyBoldTypeface)
		label.gravity = Gravity.CENTER
		label.setPadding(context.dp(16f), context.dp(12f), context.dp(16f), context.dp(12f))
		addView(label, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

		spinner.indeterminateTintList = ColorStateList.valueOf(palette.primaryForeground)
		val spinnerParams = LayoutParams(context.dp(18f), context.dp(18f))
		spinnerParams.gravity = Gravity.CENTER
		spinner.visibility = GONE
		addView(spinner, spinnerParams)

		setOnClickListener { onClick?.invoke() }
	}

	fun bind(title: String, isLoading: Boolean, isEnabled: Boolean, onClick: () -> Unit) {
		this.onClick = onClick
		label.text = title
		label.visibility = if (isLoading) GONE else VISIBLE
		spinner.visibility = if (isLoading) VISIBLE else GONE
		val enabled = isEnabled && !isLoading
		this.isEnabled = enabled
		isClickable = enabled
		alpha = if (enabled) 1f else 0.6f
	}
}

/** A quieter action: outlined, full width. */
internal class SecondaryButton(context: Context, palette: ThemePalette) : TextView(context) {
	init {
		style(15f, palette.foreground, typeface = palette.bodyTypeface)
		gravity = Gravity.CENTER
		setPadding(context.dp(16f), context.dp(12f), context.dp(16f), context.dp(12f))
		background = roundedBackground(
			fill = android.graphics.Color.TRANSPARENT,
			radiusPx = palette.radiusPx,
			strokeColor = palette.border,
			strokeWidthPx = context.dp(1f),
		)
		isClickable = true
		isFocusable = true
	}
}

/** Label + input, themed with the org palette. */
internal class ThemedTextField(
	context: Context,
	private val palette: ThemePalette,
	label: String,
	placeholder: String,
	inputType: Int = InputType.TYPE_CLASS_TEXT,
	autofillHints: Array<String>? = null,
	isDisabled: Boolean = false,
	private val onTextChanged: (String) -> Unit = {},
) : LinearLayout(context) {
	val input = EditText(context)

	init {
		orientation = VERTICAL

		val labelView = TextView(context)
		labelView.text = label
		labelView.style(14f, palette.foreground, typeface = palette.bodyTypeface)
		addView(labelView)

		input.inputType = inputType
		input.hint = placeholder
		input.isSingleLine = true
		input.setTextColor(if (isDisabled) palette.mutedForeground else palette.foreground)
		input.setHintTextColor(palette.mutedForeground)
		input.style(16f, palette.foreground, typeface = palette.bodyTypeface)
		input.setPadding(context.dp(12f), context.dp(10f), context.dp(12f), context.dp(10f))
		input.background = roundedBackground(
			fill = palette.background,
			radiusPx = palette.fieldRadiusPx,
			strokeColor = palette.border,
			strokeWidthPx = context.dp(1f),
		)
		input.imeOptions = EditorInfo.IME_ACTION_DONE
		if (autofillHints != null) input.setAutofillHints(*autofillHints)
		input.isEnabled = !isDisabled
		if (!isDisabled) {
			input.addTextChangedListener(object : TextWatcher {
				override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit

				override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit

				override fun afterTextChanged(text: Editable?) {
					onTextChanged(text?.toString().orEmpty())
				}
			})
		}
		val inputParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
		inputParams.topMargin = context.dp(8f)
		addView(input, inputParams)
	}

	val text: String get() = input.text.toString()

	fun setText(value: String) {
		if (input.text.toString() == value) return
		input.setText(value)
		input.setSelection(value.length)
	}

	fun focusInput() {
		input.requestFocus()
		// requestFocus alone does not raise the keyboard on every device.
		input.post {
			val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
			manager?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
		}
	}
}

/** Inline form feedback: server errors in destructive, saves in primary. */
internal class FormMessage(context: Context, private val palette: ThemePalette) : TextView(context) {
	init {
		style(13f, palette.destructive, typeface = palette.bodyTypeface)
		visibility = GONE
	}

	fun bind(message: String?, isSuccess: Boolean = false) {
		if (message.isNullOrEmpty()) {
			visibility = GONE
			text = ""
			return
		}
		setTextColor(if (isSuccess) palette.primary else palette.destructive)
		text = message
		visibility = VISIBLE
	}
}

/** A field-shaped row that opens a picker (used for the language choice). */
internal class ThemedPickerRow(context: Context, palette: ThemePalette) : TextView(context) {
	init {
		style(16f, palette.cardForeground, typeface = palette.bodyTypeface)
		setPadding(context.dp(12f), context.dp(10f), context.dp(12f), context.dp(10f))
		background = roundedBackground(
			fill = android.graphics.Color.TRANSPARENT,
			radiusPx = palette.fieldRadiusPx,
			strokeColor = palette.border,
			strokeWidthPx = context.dp(1f),
		)
		isClickable = true
		isFocusable = true
	}
}
