package com.epicstartup.tenant.platform

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.epicstartup.tenant.core.model.AuthTokens
import com.epicstartup.tenant.core.session.TokenStorage
import com.epicstartup.tenant.core.support.stringOrNull
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Keystore-backed storage for the shipping Android app.
 *
 * The session is encrypted with an AES-GCM key that never leaves the Android
 * Keystore, and the ciphertext lives in a private SharedPreferences file (also
 * excluded from backup in the manifest). `androidx.security:security-crypto`
 * would do the same thing with ~300 KB of dependency and is deprecated, so the
 * ~60 lines below are the whole implementation.
 */
class KeystoreTokenStorage(context: Context) : TokenStorage {
	private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

	override fun load(): AuthTokens? {
		val stored = preferences.getString(KEY_PAYLOAD, null) ?: return null
		return try {
			val separator = stored.indexOf(PAYLOAD_SEPARATOR)
			if (separator <= 0) return null
			val iv = Base64.decode(stored.substring(0, separator), Base64.NO_WRAP)
			val cipherText = Base64.decode(stored.substring(separator + 1), Base64.NO_WRAP)
			val key = secretKey() ?: return null

			val cipher = Cipher.getInstance(TRANSFORMATION)
			cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_LENGTH_BITS, iv))
			val json = JSONObject(String(cipher.doFinal(cipherText), Charsets.UTF_8))
			val accessToken = json.stringOrNull("accessToken") ?: return null
			AuthTokens(accessToken = accessToken, refreshToken = json.stringOrNull("refreshToken"))
		} catch (error: Exception) {
			// A rotated Keystore key, a restored backup, or corrupt data: the
			// customer signs in again rather than the app crashing on launch.
			null
		}
	}

	// `commit()` rather than `apply()`: callers are on a background thread and a
	// token that is not on disk yet would be lost if the process died right
	// after the customer signed in.
	@SuppressLint("ApplySharedPref")
	override fun save(tokens: AuthTokens?): Boolean {
		if (tokens == null) {
			return preferences.edit().remove(KEY_PAYLOAD).commit()
		}
		return try {
			val payload = JSONObject().apply {
				put("accessToken", tokens.accessToken)
				tokens.refreshToken?.let { put("refreshToken", it) }
			}
			val key = secretKey() ?: return false
			val cipher = Cipher.getInstance(TRANSFORMATION)
			cipher.init(Cipher.ENCRYPT_MODE, key)
			val cipherText = cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))
			val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
				PAYLOAD_SEPARATOR +
				Base64.encodeToString(cipherText, Base64.NO_WRAP)
			preferences.edit().putString(KEY_PAYLOAD, encoded).commit()
		} catch (error: Exception) {
			false
		}
	}

	private fun secretKey(): SecretKey? {
		val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
		val existing = (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
		if (existing != null) return existing

		val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
		generator.init(
			KeyGenParameterSpec.Builder(
				KEY_ALIAS,
				KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
			)
				.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
				.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
				.setKeySize(256)
				.build(),
		)
		return generator.generateKey()
	}

	private companion object {
		const val ANDROID_KEYSTORE = "AndroidKeyStore"
		const val KEY_ALIAS = "com.epicstartup.tenant.session"
		const val PREFERENCES_NAME = "epic.tenant.session"
		const val KEY_PAYLOAD = "session"
		const val TRANSFORMATION = "AES/GCM/NoPadding"
		const val TAG_LENGTH_BITS = 128
		const val PAYLOAD_SEPARATOR = ":"
	}
}
