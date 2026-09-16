---
name: project-ui-guidelines
description:
  Guide accessible UI, shared components, Tailwind CSS 4, responsive layouts,
  forms, i18n, and design-system lint in this project.
---

# Project UI guidelines

## When to use this skill

Use this skill when creating or reviewing App/Admin UI, shared components,
forms, dialogs, responsive layouts, loading states, keyboard interactions,
localization, or accessibility behavior. For Expo/iOS/Android UI, combine this
guidance with [project-mobile](../project-mobile/SKILL.md) and the platform
constraints.

## Use the design system

Prefer existing components and primitives from `@repo/ui`, including their
variants and sizes. Follow the component’s `no-restyle` contract. The shared
ESLint policy flags raw palette colors, arbitrary values, inline styles, and
caller restyling that bypasses the design system; extend a contract only when
the design system intentionally supports the new variant.

```tsx
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'

export function EmptyState() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>No projects yet</CardTitle>
			</CardHeader>
			<CardContent>
				<Button>Create project</Button>
			</CardContent>
		</Card>
	)
}
```

Use `cn()` from `@repo/ui` for conditional classes. Keep shared UI in
`packages/ui`; keep product-specific composition in the owning app. Do not add a
second component library or duplicate a primitive already available there.

## Semantic and accessible HTML

- Use `main`, `nav`, `header`, `section`, `article`, headings, lists, buttons,
  and links according to meaning.
- Every form control has a visible label or an equivalent accessible name. Reuse
  the form field components so `aria-invalid` and `aria-describedby` connect
  errors correctly.
- Use buttons for actions and links for navigation; do not make a `div`
  clickable.
- Dialogs, menus, tabs, popovers, and comboboxes should use the shared/Radix
  primitives for focus management, keyboard interaction, and announcements.
- Preserve visible focus, logical tab order, sufficient contrast, and touch
  targets. Do not communicate state by color alone.
- Add skip navigation and meaningful page/region headings where a layout needs
  them.

## Responsive and stateful UI

Design for small screens first and use Tailwind responsive utilities for layout
changes. Do not hide essential actions only on mobile without an equivalent
path. Every network-backed interaction should have intentional loading,
disabled, empty, error, and success states; use the route/fetcher pending state
instead of a second ad-hoc request flag when possible.

Keep user-entered values visible after validation errors. Announce dynamic
errors/statuses appropriately and do not move focus unexpectedly. Test keyboard
navigation and mobile layouts for important workflows.

## Forms, HTML, and media

Use Conform/Zod and the shared field components for forms. Keep error text
specific and linked to its field. Use descriptive alt text for informative
images and empty alt text for decorative images. Videos and icon-only controls
need accessible labels and usable controls.

Never render untrusted HTML. Route CMS/rich content through the project’s
sanitization path before intentionally using HTML rendering.

## Localization and motion

Use Lingui for translatable UI. Avoid concatenating sentence fragments, allow
text expansion, and test RTL layouts when the feature is localized. Do not bake
English-only date/number assumptions into reusable components.

App/Admin/Sites share content locales where configured; tenant native clients
currently ship `en`, `ar`, `de`, `es`, `fr`, and `zh`. Keep locale negotiation
and organization-enabled locales in the existing helpers instead of inventing
per-component fallback logic.

Motion should clarify state or hierarchy, not block work. Keep it subtle,
composite-friendly, and keyboard-safe; honor `prefers-reduced-motion` with a
useful reduced/no-motion variant. Never make essential information depend only
on animation.

## References

- [UI package](../../../packages/ui/README.md)
- [Forms skill](../project-forms/SKILL.md)
- [Accessibility E2E tests](../../../apps/app/tests/e2e/accessibility.test.ts)
- [i18n docs](../../README.md)
