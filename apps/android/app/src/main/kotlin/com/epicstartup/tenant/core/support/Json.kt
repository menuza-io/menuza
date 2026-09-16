package com.epicstartup.tenant.core.support

import org.json.JSONArray
import org.json.JSONObject

/**
 * `org.json` helpers shared by the API models.
 *
 * `org.json` ships with the Android framework, so the app parses JSON without a
 * serialization library (and without its megabytes). These helpers keep the
 * "missing or null or empty" handling in one place instead of repeating it in
 * every `fromJson`.
 */

/** A non-blank string, or `null` when the field is missing, null, or empty. */
fun JSONObject.stringOrNull(name: String): String? {
	if (!has(name) || isNull(name)) return null
	val value = optString(name, "").trim()
	return value.ifEmpty { null }
}

/** A string that may legitimately be empty (for example "clear the email"). */
fun JSONObject.rawStringOrNull(name: String): String? {
	if (!has(name) || isNull(name)) return null
	return optString(name, "")
}

fun JSONObject.booleanOrNull(name: String): Boolean? {
	if (!has(name) || isNull(name)) return null
	return optBoolean(name)
}

fun JSONObject.objectOrNull(name: String): JSONObject? {
	if (!has(name) || isNull(name)) return null
	return optJSONObject(name)
}

fun JSONObject.arrayOrNull(name: String): JSONArray? {
	if (!has(name) || isNull(name)) return null
	return optJSONArray(name)
}

/** A list of non-blank strings, or `null` when the array is missing or empty. */
fun JSONObject.stringListOrNull(name: String): List<String>? {
	val array = arrayOrNull(name) ?: return null
	val values = (0 until array.length()).mapNotNull { index ->
		array.optString(index, "").trim().ifEmpty { null }
	}
	return values.ifEmpty { null }
}

/** Parses a JSON object, returning `null` instead of throwing on bad input. */
fun parseJsonObject(body: ByteArray): JSONObject? =
	runCatching { JSONObject(String(body, Charsets.UTF_8)) }.getOrNull()

fun parseJsonObject(text: String): JSONObject? = runCatching { JSONObject(text) }.getOrNull()
