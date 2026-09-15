import { plugin as shadcn } from '@shadcn/lint'
import { default as defaultConfig } from '@epic-web/config/eslint'

/**
 * Shared @shadcn/lint design-system policy.
 *
 * The rules below describe how this design system's components may be styled:
 *
 * - `no-restyle`: `layout` classes are allowed everywhere. Each component's
 *   contract lists the appearance categories callers may change. Components
 *   here are flexible primitives used with `className` (see AGENTS.md), so
 *   contracts mirror how the design system is used today. Tighten a contract
 *   when the component gains a variant or size for a change.
 * - `no-raw-colors`: status colors (success/warning/danger/info) and neutrals
 *   intentionally use the Tailwind palette; EmDash CMS plugin components use
 *   `kumo-*` tokens supplied by the CMS host. Everything else must use theme
 *   tokens.
 * - `no-arbitrary-values`: `layout` values are allowed, along with the
 *   structural values (transitions, timings, shadows) and dense-UI text sizes
 *   the design uses.
 * - `no-inline-styles`: inline styles are allowed for the properties that are
 *   genuinely dynamic (computed colors, positions, drag previews, React
 *   Native shadows).
 * - Component internals are exempted in `packages/ui/eslint.config.js`.
 */
export default [
	...defaultConfig,
	// add custom config objects here for all packages
	{
		plugins: { shadcn },
		settings: {
			shadcn: {
				ui: '@repo/ui',
			},
		},
		rules: {
			'shadcn/no-restyle': [
				'error',
				{
					allow: ['layout'],
					contracts: [
						// Icon-like components are colored and animated by their callers.
						{ pattern: '^Icon$', allow: ['layout', 'color', 'effects', 'motion', 'shape', 'typography'] },
						{ pattern: '^(Logo|VideoPoster)$', allow: ['layout', 'motion', 'spacing', 'typography', 'shape'] },
						// Text and label primitives set typography and color.
						{ pattern: '^(Label|FieldLabel)$', allow: ['layout', 'color', 'effects', 'shape', 'spacing', 'typography'] },
						{ pattern: '^(CardTitle|DialogDescription|FramePanel|FrameTitle|ItemTitle|SheetDescription)$', allow: ['layout', 'color', 'spacing', 'typography'] },
						{ pattern: '^(CardDescription|DrawerDescription|DrawerTitle|DropdownMenuShortcut|SelectTrigger)$', allow: ['layout', 'color', 'typography'] },
						{ pattern: '^(AlertDialogDescription|DropdownMenuCheckboxItem|ErrorText)$', allow: ['layout', 'typography'] },
						{ pattern: '^(DropdownMenuLabel|ItemDescription|SheetTitle)$', allow: ['layout', 'spacing', 'typography'] },
						{ pattern: '^(TableCell|Badge)$', allow: ['layout', 'color', 'motion', 'shape', 'spacing', 'typography'] },
						{ pattern: '^(Avatar|AvatarImage|AvatarFallback|UserAvatar|DrawerContent)$', allow: ['layout', 'color', 'shape', 'typography'] },
						// Containers let callers adjust surfaces, spacing, and shape.
						{ pattern: '^(Card|CardContent|DropdownMenuContent|DropdownMenuSubContent)$', allow: ['layout', 'color', 'effects', 'motion', 'shape', 'spacing'] },
						{ pattern: '^(CardHeader|DialogContent|InputGroupAddon|PopoverContent|SelectContent|SheetHeader)$', allow: ['layout', 'shape', 'spacing'] },
						{ pattern: '^(CardFooter|DropdownMenuSubTrigger|DropdownMenuTrigger)$', allow: ['layout', 'color', 'shape', 'spacing', 'typography'] },
						{ pattern: '^(DialogTitle|SheetContent|StatusButton|TabsList)$', allow: ['layout', 'color', 'spacing'] },
						{ pattern: '^(DropdownMenuSeparator|Frame|Progress|ResizableHandle|ResizablePanelGroup|Screen|ScrollArea|Separator)$', allow: ['layout', 'color'] },
						{ pattern: '^(CommandDialog|SidebarInset)$', allow: ['layout', 'effects', 'shape'] },
						{ pattern: '^(DrawerOverlay|TableRow)$', allow: ['layout', 'color', 'effects', 'motion'] },
						{ pattern: '^(SelectItem|SheetFooter)$', allow: ['layout', 'color', 'shape', 'spacing'] },
						{ pattern: '^ContextMenuContent$', allow: ['layout', 'effects'] },
						// Form controls take contextual color, type, spacing, and shape.
						{ pattern: '^(DropdownMenuItem|Input|SidebarMenuButton|Textarea)$', allow: ['layout', 'color', 'effects', 'shape', 'spacing', 'typography'] },
						{ pattern: '^(InputGroup|ButtonGroupText)$', allow: ['layout', 'color', 'effects', 'shape', 'spacing'] },
						{ pattern: '^Field$', allow: ['layout', 'spacing'] },
						{ pattern: '^CollapsibleTrigger$', allow: ['layout', 'color', 'motion', 'spacing'] },
						// Buttons are used as flexible primitives across the app.
						{ pattern: '^Button$', allow: ['layout', 'color', 'effects', 'motion', 'shape', 'spacing', 'typography'] },
						// Layout helpers.
						{ pattern: '^(CardAction|DialogFooter|FrameFooter|ItemActions|ItemGroup|PaginationLink|RadioGroup|SidebarGroupLabel|SidebarHeader|Tabs|TabsContent|TabsTrigger)$', allow: ['layout', 'spacing'] },
						{ pattern: '^(ResizablePanel|SidebarMenuAction|Skeleton)$', allow: ['layout', 'shape'] },
					],
				},
			],
			'shadcn/no-raw-colors': [
				'error',
				{
					allow: [
						// Status colors (success/warning/danger/info) and neutrals use the palette by design.
						'*-emerald-*',
						'*-green-*',
						'*-blue-*',
						'*-orange-*',
						'*-amber-*',
						'*-yellow-*',
						'*-red-*',
						'*-gray-*',
						'*-slate-*',
						'*-zinc-*',
						// Auth screens use a fixed gradient backdrop.
						'from-purple-400',
						'via-pink-500',
						'to-red-500',
						// EmDash CMS plugin components receive @cloudflare/kumo tokens from the CMS host.
						'*-kumo-*',
					],
				},
			],
			'shadcn/no-arbitrary-values': [
				'error',
				{
					allow: [
						'layout',
						// Motion and transitions.
						'transition',
						'duration',
						'ease',
						'animate',
						// Dense-UI text sizes.
						'text-[9px]',
						'text-[10px]',
						'text-[10.5px]',
						'text-[11px]',
						'text-[12.5px]',
						'text-[13px]',
						// Structural values (shadows, gradients, masks, radii, brand colors).
						'shadow-[0px_1px_1px_0px_rgba(0,0,0,0.05),0px_1px_1px_0px_rgba(255,252,240,0.5)_inset,0px_0px_0px_1px_hsla(0,0%,100%,0.1)_inset,0px_0px_1px_0px_rgba(28,27,26,0.5)]',
						'dark:shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_0_0_1px_rgba(255,255,255,0.03)_inset,0_0_0_1px_rgba(0,0,0,0.1),0_2px_2px_0_rgba(0,0,0,0.1),0_4px_4px_0_rgba(0,0,0,0.1),0_8px_8px_0_rgba(0,0,0,0.1)]',
						'shadow-[0px_0px_0px_1px_rgba(0,0,0,.07),0px_0px_0px_3px_#fff,0px_0px_0px_4px_rgba(0,0,0,.08)]',
						'dark:shadow-[0px_0px_0px_1px_rgba(0,0,0,.07),0px_0px_0px_3px_rgba(0,0,0,0.8),0px_0px_0px_4px_rgba(0,0,0,.08)]',
						'dark:shadow-[0px_1px_1px_0px_rgba(0,0,0,0.15),0px_1px_1px_0px_rgba(0,0,0,0.15)_inset,0px_0px_0px_1px_rgba(0,0,0,0.15)_inset,0px_0px_1px_0px_rgba(0,0,0,0.15)]',
						'[transition-timing-function:cubic-bezier(0.19,1,0.22,1)]',
						'rounded-[4px]',
						'rounded-[8px]',
						'rounded-[2rem]',
						'rounded-[inherit]',
						'rounded-tr-[16px]',
						'after:rounded-[4px]',
						'after:rounded-[inherit]',
						'pr-[27.25rem]',
						'bg-[linear-gradient(135deg,#94a3b8_0%,#64748b_100%)]',
						'bg-[linear-gradient(135deg,#94a3b8,#64748b)]',
						// Discord brand colors (waitlist community button).
						'bg-[#5865F2]',
						'hover:bg-[#4752C4]',
						'hover:bg-[#5865F2]/10',
						'border-[#5865F2]',
						'text-[#5865F2]',
						// Search-result preview colors.
						'text-[#202124]',
						'text-[#1a0dab]',
					],
				},
			],
			'shadcn/no-inline-styles': [
				'error',
				{
					allow: [
						// Dynamic values: computed colors, geometry, drag previews, masks,
						// charts, and React Native shadows.
						'WebkitMask',
						'WebkitMaskComposite',
						'backgroundColor',
						'backgroundImage',
						'backgroundPosition',
						'backgroundRepeat',
						'backgroundSize',
						'borderBottomLeftRadius',
						'borderBottomRightRadius',
						'borderRadius',
						'borderTopLeftRadius',
						'borderTopRightRadius',
						'color',
						'cursor',
						'display',
						'elevation',
						'fontFamily',
						'height',
						'left',
						'marginLeft',
						'mask',
						'maskComposite',
						'maskType',
						'maxWidth',
						'opacity',
						'overflow',
						'padding',
						'paddingBottom',
						'paddingTop',
						'pointerEvents',
						'shadowColor',
						'shadowOffset',
						'shadowOpacity',
						'shadowRadius',
						'strokeWidth',
						'top',
						'transform',
						'transformOrigin',
						'transition',
						'width',
						'zIndex',
					],
				},
			],
			'shadcn/no-unknown-classes': [
				'error',
				{
					allow: [
						// Styling hooks on vendored shadcn components.
						'cn-calendar-dropdown-root',
						'cn-calendar-caption-label',
						'cn-input-otp',
						'toaster',
					],
				},
			],
			'shadcn/require-static-classes': 'error',
		},
	},
]
