import { isRecord, type Json } from '../util'
import { invalidRequest } from './errors'

/**
 * Allowed-parameter trees. `true` accepts a scalar, `ANY` a free-form map
 * (metadata), `[tree]` a list of that shape. Unknown parameters are refused
 * the way Stripe refuses them, which is how emulated calls catch typos.
 */
export const ANY = Symbol('any')
export type ParamTree =
	| true
	| typeof ANY
	| { readonly [key: string]: ParamTree }
	| readonly [ParamTree]

export function rejectUnknownParams(params: Json, tree: ParamTree, path = '') {
	if (tree === ANY) return
	if (Array.isArray(tree)) {
		const items = Array.isArray(params) ? params : [params]
		for (const [index, item] of items.entries()) {
			rejectUnknownParams(
				item as Json,
				(tree as readonly [ParamTree])[0],
				`${path}[${index}]`,
			)
		}
		return
	}
	if (tree === true) {
		if (isRecord(params) || Array.isArray(params)) {
			throw invalidRequest(`Invalid value for ${path}.`, {
				code: 'parameter_invalid_empty',
				param: path,
			})
		}
		return
	}
	if (!isRecord(params)) {
		throw invalidRequest(`Invalid value for ${path}: expected a hash.`, {
			code: 'parameter_invalid_empty',
			param: path,
		})
	}
	for (const [key, value] of Object.entries(params)) {
		const child = (tree as { readonly [key: string]: ParamTree })[key]
		const here = path ? `${path}[${key}]` : key
		if (child === undefined) {
			throw invalidRequest(`Received unknown parameter: ${here}`, {
				code: 'parameter_unknown',
				param: here,
			})
		}
		rejectUnknownParams(value as Json, child, here)
	}
}

export function intParam(
	value: unknown,
	param: string,
	options: { required?: boolean } = {},
): number | undefined {
	if (value === undefined || value === '') {
		if (options.required) {
			throw invalidRequest(`Missing required param: ${param}.`, {
				code: 'parameter_missing',
				param,
			})
		}
		return undefined
	}
	if (typeof value === 'number' && Number.isInteger(value)) return value
	if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
	throw invalidRequest(`Invalid integer: ${String(value)}`, {
		code: 'parameter_invalid_integer',
		param,
	})
}

export function boolParam(value: unknown, param: string): boolean | undefined {
	if (value === undefined || value === '') return undefined
	if (value === true || value === 'true') return true
	if (value === false || value === 'false') return false
	throw invalidRequest(`Invalid boolean: ${String(value)}`, {
		code: 'parameter_invalid_enum',
		param,
	})
}

export function stringParam(value: unknown, param: string): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string') {
		throw invalidRequest(`Invalid string: ${param}`, {
			code: 'parameter_invalid_empty',
			param,
		})
	}
	return value
}

export function metadataParam(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {}
	const out: Record<string, string> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (key.length > 40) {
			throw invalidRequest(
				`Metadata key ${key.slice(0, 20)}... is too long: keys can be at most 40 characters.`,
				{ param: 'metadata' },
			)
		}
		const text = String(entry)
		if (text.length > 500) {
			throw invalidRequest(
				`Metadata values can have up to 500 characters, but you passed in a value for ${key} with ${text.length} characters.`,
				{ param: 'metadata' },
			)
		}
		out[key] = text
	}
	return out
}

const MIN_AMOUNT: Record<string, number> = { usd: 50, cad: 50, sar: 200 }

export function assertChargeableAmount(
	amount: number,
	currency: string,
	param: string,
) {
	const minimum = MIN_AMOUNT[currency] ?? 50
	if (amount < minimum) {
		throw invalidRequest(
			`Amount must be at least ${minimum} ${currency} minor units; ${amount} is too small.`,
			{ code: 'amount_too_small', param },
		)
	}
}
