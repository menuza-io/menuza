import { z } from 'zod'

/**
 * Zod 3 reported a missing value as "Required". Zod 4 says "Invalid input:
 * expected string, received undefined", and forms show Zod's own message
 * whenever a schema sets none, so restore the short text. A message set on the
 * schema still wins, and every other default message is Zod's.
 *
 * `z.config` is global to the Zod instance, so call this once per entry point
 * (an app's `root.tsx` runs on both the server and the client).
 */
export function installRequiredMessage() {
	z.config({
		customError: (issue) =>
			(issue.code === 'invalid_type' || issue.code === 'invalid_value') &&
			issue.input === undefined
				? 'Required'
				: undefined,
	})
}
