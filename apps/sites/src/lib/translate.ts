import { type I18n, type MessageDescriptor } from '@lingui/core'

/** Translates a `msg` descriptor with ICU placeholder values. */
export function translate(
	i18n: I18n,
	descriptor: MessageDescriptor,
	values: Record<string, string | number>,
): string {
	const withValues: MessageDescriptor = { ...descriptor, values }
	// The extractor already collected the `msg` descriptor at the call site.
	return /* lingui-extract-ignore */ i18n._(withValues)
}
