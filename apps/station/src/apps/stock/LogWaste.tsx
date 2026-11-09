import { useStock } from './useStock.ts'
import { WasteSheet } from './WasteSheet.tsx'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/**
 * Kitchen's "Log waste" button opens this: the same sheet and the same outbox
 * as Stock's Waste tile, mounted only while it is open (so Kitchen's screen
 * does nothing for Stock otherwise).
 */
export function LogWaste({
	settings,
	session,
	online,
	onClose,
}: {
	settings: PosSettings
	session: Session | null
	online: boolean
	onClose: () => void
}) {
	const stock = useStock(settings, session, online)
	return <WasteSheet stock={stock} open onClose={onClose} />
}
