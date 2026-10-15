import {
	createContext,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from 'react'
import { useGlobalHotkeys } from '#app/hooks/use-hotkeys.ts'
import { CommandMenu } from './command-menu.tsx'

type CommandPaletteContextValue = {
	open: boolean
	setOpen: (open: boolean) => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
	null,
)

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false)
	useGlobalHotkeys(setOpen)

	const value = useMemo(() => ({ open, setOpen }), [open])

	return (
		<CommandPaletteContext.Provider value={value}>
			{children}
			<CommandMenu open={open} onOpenChange={setOpen} />
		</CommandPaletteContext.Provider>
	)
}

export function useCommandPalette() {
	const ctx = useContext(CommandPaletteContext)
	if (!ctx) {
		throw new Error(
			'useCommandPalette must be used within CommandPaletteProvider',
		)
	}
	return ctx
}
