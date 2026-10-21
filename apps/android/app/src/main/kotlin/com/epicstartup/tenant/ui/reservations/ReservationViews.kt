package com.epicstartup.tenant.ui.reservations

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import com.epicstartup.tenant.R
import com.epicstartup.tenant.ui.ThemePalette
import com.epicstartup.tenant.ui.components.dp
import com.epicstartup.tenant.ui.components.roundedBackground
import com.epicstartup.tenant.ui.components.style

// Small building blocks for the reservations screens (framework views only).

internal fun Context.bodyText(
	palette: ThemePalette,
	text: String,
	sizeSp: Float = 14f,
	muted: Boolean = false,
	bold: Boolean = false,
): TextView = TextView(this).apply {
	this.text = text
	style(
		sizeSp,
		if (muted) palette.mutedForeground else palette.cardForeground,
		typeface = if (bold) palette.bodyBoldTypeface else palette.bodyTypeface,
	)
}

internal fun Context.headingText(palette: ThemePalette, text: String): TextView =
	TextView(this).apply {
		this.text = text
		style(18f, palette.cardForeground, typeface = palette.headingBoldTypeface)
	}

internal fun LinearLayout.addRow(child: View, topDp: Float = 12f) {
	val params = LinearLayout.LayoutParams(
		ViewGroup.LayoutParams.MATCH_PARENT,
		ViewGroup.LayoutParams.WRAP_CONTENT,
	)
	params.topMargin = if (childCount == 0) 0 else context.dp(topDp)
	addView(child, params)
}

/** A tappable text row (a reservation, a location). */
internal fun Context.listRow(palette: ThemePalette, title: String, subtitle: String?, onClick: () -> Unit): View =
	LinearLayout(this).apply {
		orientation = LinearLayout.VERTICAL
		setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
		background = roundedBackground(
			fill = android.graphics.Color.TRANSPARENT,
			radiusPx = palette.fieldRadiusPx,
			strokeColor = palette.border,
			strokeWidthPx = dp(1f),
		)
		isClickable = true
		isFocusable = true
		setOnClickListener { onClick() }
		addView(bodyText(palette, title, 15f, bold = true))
		if (subtitle != null) addView(bodyText(palette, subtitle, 13f, muted = true))
	}

/**
 * Time and date chips: `TextView`s in rows of four inside a vertical
 * `LinearLayout`, so there is no RecyclerView and no extra dependency.
 */
internal class ChipGrid(context: Context, private val palette: ThemePalette, private val perRow: Int = 4) :
	LinearLayout(context) {
	init {
		orientation = VERTICAL
	}

	fun bind(labels: List<String>, selected: Int = -1, onClick: (Int) -> Unit) {
		removeAllViews()
		labels.chunked(perRow).forEachIndexed { rowIndex, row ->
			val line = LinearLayout(context).apply { orientation = HORIZONTAL }
			row.forEachIndexed { column, label ->
				val index = rowIndex * perRow + column
				line.addView(chip(label, index == selected) { onClick(index) }, chipParams())
			}
			// Keep the last row's chips the same width as the others.
			repeat(perRow - row.size) { line.addView(View(context), chipParams()) }
			val params = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
			if (rowIndex > 0) params.topMargin = context.dp(8f)
			addView(line, params)
		}
	}

	private fun chipParams(): LayoutParams {
		val params = LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
		params.marginStart = context.dp(4f)
		params.marginEnd = context.dp(4f)
		return params
	}

	private fun chip(label: String, selected: Boolean, onClick: () -> Unit): TextView =
		TextView(context).apply {
			text = label
			gravity = Gravity.CENTER
			style(
				14f,
				if (selected) palette.primaryForeground else palette.foreground,
				typeface = palette.bodyTypeface,
			)
			setPadding(context.dp(4f), context.dp(10f), context.dp(4f), context.dp(10f))
			background = roundedBackground(
				fill = if (selected) palette.primary else android.graphics.Color.TRANSPARENT,
				radiusPx = palette.controlRadiusPx,
				strokeColor = palette.border,
				strokeWidthPx = context.dp(1f),
			)
			// 48dp touch target, and selection exposed to TalkBack: the filled colour
			// alone does not tell a screen reader which chip is chosen.
			minHeight = context.dp(48f)
			isSelected = selected
			isClickable = true
			isFocusable = true
			setOnClickListener { onClick() }
		}
}

/** `-  n  +` with accessible labels for the two buttons. */
internal class Stepper(context: Context, private val palette: ThemePalette, private val onChange: (Int) -> Unit) :
	LinearLayout(context) {
	private val value = TextView(context)
	private var current = 1
	private var min = 1
	private var max = 99

	init {
		orientation = HORIZONTAL
		gravity = Gravity.CENTER_VERTICAL
		addView(button("−", R.string.res_fewer) { set(current - 1) })
		value.style(18f, palette.cardForeground, typeface = palette.bodyBoldTypeface)
		value.gravity = Gravity.CENTER
		addView(value, LayoutParams(context.dp(56f), ViewGroup.LayoutParams.WRAP_CONTENT))
		addView(button("+", R.string.res_more) { set(current + 1) })
	}

	fun bind(current: Int, min: Int, max: Int) {
		this.min = min
		this.max = max
		this.current = current
		value.text = "$current"
	}

	private fun set(next: Int) {
		val clamped = next.coerceIn(min, max)
		if (clamped == current) return
		current = clamped
		value.text = "$clamped"
		onChange(clamped)
	}

	private fun button(symbol: String, description: Int, onClick: () -> Unit) = TextView(context).apply {
		text = symbol
		contentDescription = context.getString(description)
		gravity = Gravity.CENTER
		style(20f, palette.foreground, typeface = palette.bodyBoldTypeface)
		minWidth = context.dp(44f)
		minHeight = context.dp(44f)
		background = roundedBackground(
			fill = android.graphics.Color.TRANSPARENT,
			radiusPx = palette.controlRadiusPx,
			strokeColor = palette.border,
			strokeWidthPx = context.dp(1f),
		)
		isClickable = true
		isFocusable = true
		setOnClickListener { onClick() }
	}
}

internal fun Context.themedCheckBox(palette: ThemePalette, label: String): CheckBox =
	CheckBox(this).apply {
		text = label
		style(14f, palette.cardForeground, typeface = palette.bodyTypeface)
		buttonTintList = android.content.res.ColorStateList.valueOf(palette.primary)
	}
