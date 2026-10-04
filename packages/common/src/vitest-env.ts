import { ENV as _ENV } from 'varlock/env'

const envProxy = new Proxy(
	{},
	{
		get(_target, prop) {
			if (typeof process !== 'undefined') {
				const fromProcess = process.env[String(prop)]
				if (fromProcess !== undefined && fromProcess !== '') {
					return fromProcess
				}
			}
			try {
				return _ENV[prop as keyof typeof _ENV]
			} catch {
				return undefined
			}
		},
	},
)

/** Reads `process.env` with fallback to Varlock's resolved ENV. */
export const ENV = envProxy as typeof _ENV
