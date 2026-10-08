/**
 * Settings actions return these codes instead of English text so the page
 * can show them in the operator's language. A code may carry one number,
 * written `code:number` (for example `too_long:60`). Messages without a
 * known code are shown as they are.
 */
export const SETTINGS_ERROR_CODES = [
	// Whole-form errors
	'conflict',
	'invalid_fields',
	'invalid_request',
	'escalation_phone_required',
	'staff_phone_loop',
	'rate_limited_send',
	'rate_limited_check',
	'faq_rate_limited',
	'faq_unavailable',
	'choose_scope',
	'alerts_forbidden',
	// Field errors
	'required',
	'too_short',
	'too_long',
	'too_few',
	'too_many',
	'too_small',
	'too_big',
	'email',
	'phone',
	'phone_region',
	'format',
	'invalid',
	'duplicate_id',
	'transfer_loop',
	'contact_required',
	'code_format',
	'closes_before_opens',
] as const
export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number]

export function settingsError(code: SettingsErrorCode, value?: number) {
	return value === undefined ? code : `${code}:${value}`
}

export function parseSettingsError(
	error: string,
): { code: SettingsErrorCode; value: number | null } | null {
	const [code, value, ...rest] = error.split(':')
	if (rest.length) return null
	const known = SETTINGS_ERROR_CODES.find((candidate) => candidate === code)
	if (!known) return null
	if (value === undefined) return { code: known, value: null }
	const number = Number(value)
	return Number.isFinite(number) ? { code: known, value: number } : null
}

/**
 * Per-key fingerprints of the stored settings. A page sends back the ones
 * for the keys it saves, so a save based on stale values can be refused.
 */
export type SettingsVersions = Record<string, string>

export function isSettingsConflict(result: unknown) {
	return Boolean(
		result &&
		typeof result === 'object' &&
		'ok' in result &&
		result.ok === false &&
		'error' in result &&
		result.error === 'conflict',
	)
}
