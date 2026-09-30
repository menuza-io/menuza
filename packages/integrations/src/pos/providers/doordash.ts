import { BasePosProvider } from './base.ts'

/** DoorDash uses JWT access keys in env; merchant Connect does not use OAuth. */
export class DoorDashProvider extends BasePosProvider {
	readonly provider = 'doordash' as const
	readonly name = 'doordash'
	readonly displayName = 'DoorDash'
	readonly description =
		'Sync your DoorDash storefront menu, categories and item availability'
	readonly icon = 'doordash'
}
