package com.epicstartup.tenant.ui.components

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.widget.TextView

// Small view helpers. Everything here exists to keep the screen code readable
// without an XML layout (layouts are dead weight we do not ship) or a UI toolkit.

internal fun Context.dp(value: Float): Int = Math.round(value * resources.displayMetrics.density)

internal fun Context.dpFloat(value: Float): Float = value * resources.displayMetrics.density

internal fun roundedBackground(
	fill: Int,
	radiusPx: Float,
	strokeColor: Int? = null,
	strokeWidthPx: Int = 0,
): GradientDrawable = GradientDrawable().apply {
	setColor(fill)
	cornerRadius = radiusPx
	if (strokeColor != null && strokeWidthPx > 0) setStroke(strokeWidthPx, strokeColor)
}

internal fun TextView.style(
	sizeSp: Float,
	color: Int,
	typeface: Typeface? = null,
	bold: Boolean = false,
) {
	setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
	setTextColor(color)
	when {
		typeface != null && bold -> this.typeface = Typeface.create(typeface, Typeface.BOLD)
		typeface != null -> this.typeface = typeface
		bold -> setTypeface(this.typeface, Typeface.BOLD)
	}
}

/** Draws a bitmap clipped to a rounded rectangle (the brand icon). */
internal class RoundedCornerDrawable(
	private val bitmap: Bitmap,
	private val radius: Float,
) : Drawable() {
	private val path = Path()
	private val rect = RectF()

	override fun draw(canvas: Canvas) {
		val save = canvas.save()
		rect.set(bounds)
		path.reset()
		path.addRoundRect(rect, radius, radius, Path.Direction.CW)
		canvas.clipPath(path)
		canvas.drawBitmap(bitmap, null, bounds, null)
		canvas.restoreToCount(save)
	}

	override fun setAlpha(alpha: Int) = Unit

	override fun setColorFilter(colorFilter: ColorFilter?) = Unit

	@Deprecated("Deprecated in Java")
	override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
