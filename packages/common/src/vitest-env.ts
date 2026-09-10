import { ENV as _ENV } from 'varlock/env'

const testEnv = new Proxy(
	{},
	{
		get(_target, prop) {
			const fromProcess = process.env[String(prop)]
			if (fromProcess !== undefined && fromProcess !== '') {
				return fromProcess
			}
			try {
				return _ENV[prop as keyof typeof _ENV]
			} catch {
				return undefined
			}
		},
	},
)

/** Vitest reads `process.env`; production uses Varlock's resolved ENV. */
export const ENV =
	typeof process !== 'undefined' && process.env.VITEST === 'true'
		? testEnv
		: _ENV
