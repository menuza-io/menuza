# @repo/email

A centralized email template package for the Epic Stack application using React
Email.

## Overview

This package contains all React email templates used throughout the application.
It provides a consistent way to create, maintain, and reuse email templates
across different parts of the application.

Transactional templates are composed from a shared boxed layout and a small set
of element primitives, so the look is defined once instead of in every template:

- `EmailLayout` — the document: tinted page, square white sheet, brand header
  row, footer. Renders `<Html>`/`<Tailwind>`/`<Head>`/`<Preview>`/`<Body>`, so a
  template never has to.
- `EmailCard` — a tinted rounded panel on the sheet. Cards are the structural
  unit of every email. `size="message"` for a single-message email, the default
  `section` for a card holding several blocks.
- `EmailEyebrow`, `EmailHeading`, `EmailParagraph`, `EmailNote` — typography.
- `EmailButton` — the primary CTA.
- `EmailCode` — white inset box for a one-time code.
- `EmailQuote` — white inset box for quoted content (e.g. the comment that
  triggered the email).
- `EmailField` — label over value, for detail rows.
- `EmailLink` — inline link.
- `EmailSteps` / `EmailStep` — numbered list.

Every primitive owns its own bottom margin, taken from the scale below, and
accepts an optional `className` that is appended. Templates therefore do not
invent spacing: the only override a template should need is `className="mb-0"`
on the last element of a card.

### Spacing and type scale

The layout is a port of the React Email demo at `apps/demo/emails/01-Barebone`
in the `resend/react-email` repo. The numbers are deliberate and should not be
re-invented per template:

| Token           | Value                                                    |
| --------------- | -------------------------------------------------------- |
| Page            | `Body` has no padding; the sheet owns the inset          |
| Sheet           | `px-[24px] py-[16px]`, `mobile:px-[8px]`, **square**     |
| Card gutter     | `mb-[24px]`, `mobile:mb-[8px]`                           |
| Card, `section` | `rounded-[10px] px-[20px] py-[56px]`                     |
| Card, `message` | `rounded-[8px] px-[40px] py-[64px]`                      |
| Header row      | `mb-[12px] px-[24px]`, columns `py-[7px]`, logo 23px     |
| Footer          | `px-[24px] py-[40px]`, tagline `mb-[32px] max-w-[280px]` |
| Step rows       | `mb-[36px]`                                              |
| Text measure    | headings `440px`, body `420px`, notes `400px`            |

Type comes from `emailFontSize`, mirrored from the demo's `theme.ts`:

```
11  legal            13  eyebrow / footnote    16  body
24  section title    28  h1 (transactional)     32  h2 (marketing)   40  h1 (hero)
```

Each step carries its own `lineHeight` and `letterSpacing` — sizes alone are not
enough, and the tracking is most of what makes the type read as designed.
Weights are set explicitly with `font-medium`/`font-semibold`; see the comment
on `emailFontSize` for why weight stays out of the tokens.

### Colors

Email clients support neither `oklch()` nor CSS custom properties, so
`src/theme.ts` mirrors the app's shadcn tokens as literal hex values and feeds
them to React Email's `<Tailwind config>`. Templates then use the same semantic
class names as the app (`bg-muted`, `text-foreground`, `bg-primary`, …). If the
app theme changes, update `emailThemeColors` to match.

`src/theme.ts` also adds a `mobile` screen so the fixed padding collapses on
phones, and exports `emailBrandLogoUrl` — the raster brand mark used in the
header, derived from `brand.url`. It must stay a raster asset: Gmail does not
render SVG images.

### Copy rules

These templates ship to every fork of the repo, so:

1. **Keep copy domain-neutral.** No product-specific language — a fork could be
   a devtools product or a restaurant SaaS. `email-templates.test.ts` guards
   this and fails if forbidden terms reappear.
2. **Prefer brand-driven strings.** Interpolate `brand.name`, `brand.tagline`
   and friends from `@repo/config/brand` rather than hardcoding prose, so a
   renamed fork renders correctly without editing a template.

## Installation

This package is automatically included in the web app's dependencies. No
additional installation is required.

## Usage

Import email templates from the package:

```typescript
import { OrganizationInviteEmail, ForgotPasswordEmail, SignupEmail } from '@repo/email'
import { sendEmail } from '#app/utils/email.server.ts'

// Use in your server-side code
const response = await sendEmail({
  to: 'user@example.com',
  subject: 'Welcome!',
  react: <SignupEmail onboardingUrl="https://app.com/verify/123" otp="123456" />
})
```

## Available Templates

### OrganizationInviteEmail

Used when inviting users to join an organization.

**Props:**

- `inviteUrl: string` - The invitation acceptance URL
- `organizationName: string` - Name of the organization
- `inviterName: string` - Name of the person sending the invite

### ForgotPasswordEmail

Used for password reset emails.

**Props:**

- `onboardingUrl: string` - The password reset URL
- `otp: string` - One-time password code

### SignupEmail

Used for user registration verification.

**Props:**

- `onboardingUrl: string` - The verification URL
- `otp: string` - One-time password code

### EmailChangeEmail

Used when users change their email address.

**Props:**

- `verifyUrl: string` - The email verification URL
- `otp: string` - One-time password code

### EmailChangeNoticeEmail

Used to notify users when their email has been changed.

**Props:**

- `userId: string` - The user's account ID

### ContactTemplate

Used for contact form submissions.

**Props:**

- `name: string` - Contact's name
- `email: string` - Contact's email
- `message: string` - Contact's message

### InvoiceEmail

Used for sending invoices.

**Props:**

- `orderNumber: string` - Invoice number
- `invoiceDate: string` - Invoice date
- `customerName: string` - Customer name
- `customerEmail: string` - Customer email
- `items: Array<{name, description, quantity, amount}>` - Invoice items
- `subtotal: string` - Subtotal amount
- `tax: string` - Tax amount
- `total: string` - Total amount
- `downloadUrl: string` - Invoice download URL

## Development

### Previewing

```bash
npm run dev -w email    # React Email preview server on port 3012
```

### Building the Package

```bash
cd packages/email
npm run build
```

### Type Checking

```bash
cd packages/email
npm run typecheck
```

### Testing

```bash
npm test -w @repo/email
```

`src/templates/email-templates.test.ts` renders every template with its
`PreviewProps` and asserts the shell renders, the brand values are present, the
CTA href survives, and no `oklch(` leaks into the output. It also fails if
domain-specific copy creeps back into a template.

### Adding New Templates

1. Create a new template file in `src/templates/`
2. Compose it from `EmailLayout` + `EmailCard` + the element primitives
3. Export the template and its props interface
4. Add exports to `src/index.ts`
5. Add it to the cases in `src/templates/email-templates.test.ts`
6. Build the package
7. Use the template in your application

### Template Structure

Compose the shell from the shared layout and keep card copy domain-neutral:

```typescript
import { brand } from '@repo/config/brand'

import {
  EmailButton,
  EmailCard,
  EmailHeading,
  EmailLayout,
  EmailParagraph,
} from '../components'

export interface MyEmailProps {
  name: string
  actionUrl: string
}

export default function MyEmail({ name, actionUrl }: MyEmailProps) {
  return (
    <EmailLayout
      preview={`${brand.name} notification`}
      fallbackUrl={actionUrl}
    >
      <EmailCard size="message">
        <EmailHeading>Hello, {name}</EmailHeading>
        <EmailParagraph>
          Something happened in your {brand.name} account.
        </EmailParagraph>
        <EmailButton href={actionUrl} className="mb-0">
          Open {brand.name}
        </EmailButton>
      </EmailCard>
    </EmailLayout>
  )
}

MyEmail.PreviewProps = {
  name: 'Alex',
  actionUrl: 'https://example.com/action/123',
} as MyEmailProps
```

Note what the template does _not_ do: it sets no vertical margins other than
`mb-0` on the card's last element, and no font sizes. Both come from the
primitives and the scale.

Use a second `EmailCard` only when the email genuinely has a second section (for
example an invoice's meta block, order summary and CTA). The reference's
transactional emails are a **single** card with the footnote inside it, which is
what the `message` size is for. Every template must:

- Export a props interface
- Include `PreviewProps` for development and testing
- Pass `fallbackUrl` when a button's link is unusable if the button is stripped

## Dependencies

- `@react-email/components` - React Email component library
- `react` - React library
- `resend` - Email service provider
- `zod` - Schema validation

## Notes

- All templates are built with TypeScript for type safety
- Templates use React Email components for consistent rendering across email
  clients
- The package is configured as a private workspace package
- Templates include preview props for development and testing
