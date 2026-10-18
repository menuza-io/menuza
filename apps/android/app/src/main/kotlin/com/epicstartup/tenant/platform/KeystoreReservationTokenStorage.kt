package com.epicstartup.tenant.platform

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.epicstartup.tenant.core.reservations.ReservationTokenStorage
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Keystore-backed storage for booking capability tokens (the same scheme as
 * [KeystoreTokenStorage]: an AES-GCM key that never leaves the Keystore, the
 * ciphertext in a private preferences file that is excluded from backup).
 */
class KeystoreReservationTokenStorage(context: Context) : ReservationTokenStorage {
	private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

	override fun load(): Map<String, String> {
		val stored = preferences.getString(KEY_PAYLOAD, null) ?: return emptyMap()
		return try {
			val separator = stored.indexOf(SEPARATOR)
			if (separator <= 0) return emptyMap()
			val iv = Base64.decode(stored.substring(0, separator), Base64.NO_WRAP)
			val cipherText = Base64.decode(stored.substring(separator + 1), Base64.NO_WRAP)
			val cipher = Cipher.getInstance(TRANSFORMATION)
			cipher.init(Cipher.DECRYPT_MODE, secretKey() ?: return emptyMap(), GCMParameterSpec(TAG_BITS, iv))
			val json = JSONObject(String(cipher.doFinal(cipherText), Charsets.UTF_8))
			json.keys().asSequence().associateWith { json.optString(it) }
		} catch (error: Exception) {
			// A rotated key or corrupt data only loses the shortcuts: `/mine`
			// hands back fresh manage tokens for a signed-in customer.
			emptyMap()
		}
	}

	@SuppressLint("ApplySharedPref")
	override fun save(tokens: Map<String, String>): Boolean {
		if (tokens.isEmpty()) return preferences.edit().remove(KEY_PAYLOAD).commit()
		return try {
			val payload = JSONObject().apply { tokens.forEach { (key, value) -> put(key, value) } }
			val cipher = Cipher.getInstance(TRANSFORMATION)
			cipher.init(Cipher.ENCRYPT_MODE, secretKey() ?: return false)
			val cipherText = cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))
			val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + SEPARATOR +
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
		const val KEY_ALIAS = "com.epicstartup.tenant.reservations"
		const val PREFERENCES_NAME = "epic.tenant.reservations"
		const val KEY_PAYLOAD = "tokens"
		const val TRANSFORMATION = "AES/GCM/NoPadding"
		const val TAG_BITS = 128
		const val SEPARATOR = ":"
	}
}
