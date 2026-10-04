/** JSON action responses from `settings+/chat` (client + server). */
export type ChatSettingsActionResult =
	| { ok: true }
	| {
			ok: false
			error?: string
			fieldErrors?: Partial<Record<'name' | 'roleIds' | 'memberIds', string>>
	  }
