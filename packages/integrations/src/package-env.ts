import { ENV as _base } from '@repo/common/vitest-env'
import type { CoercedEnvSchema } from './env.ts'

export const ENV: Readonly<CoercedEnvSchema> =
	_base as Readonly<CoercedEnvSchema>
