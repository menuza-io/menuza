import { type I18n, type MessageDescriptor } from '@lingui/core'
import { buildReservationLabels } from './labels.ts'

/** English labels with placeholders left in place, for DOM tests. */
export function testLabels() {
	const i18n = {
		_: (descriptor: MessageDescriptor & { values?: Record<string, unknown> }) =>
			String(descriptor.message).replace(/\{(\w+)\}/g, (match, key: string) =>
				descriptor.values && key in descriptor.values
					? String(descriptor.values[key])
					: match,
			),
	} as unknown as I18n
	return buildReservationLabels(i18n)
}
