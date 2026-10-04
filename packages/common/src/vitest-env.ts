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

function useTestEnv() {
	return typeof process !== 'undefined' && process.env.VITEST === 'true'
}

/** Vitest reads `process.env`; production uses Varlock's resolved ENV. */
export const ENV = new Proxy({} as typeof _ENV, {
	get(_target, prop) {
		const source = useTestEnv() ? testEnv : _ENV
		return source[prop as keyof typeof _ENV]
	},
})
