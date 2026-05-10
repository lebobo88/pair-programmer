/**
 * Templates for design-system / UX artifacts the harness expects from
 * the designer / design-system-curator agents. These are markdown stubs
 * the agents fill in.
 */

export const SCREEN_STATE_MATRIX_TEMPLATE = `# Screen-state matrix

| Component | default | hover | focus | active | loading | empty | error | disabled |
|-----------|---------|-------|-------|--------|---------|-------|-------|----------|
| <name>    |         |       |       |        |         |       |       |          |

For each cell, state:
- visual treatment (color, shape, motion)
- behavior (what happens on this state's transitions)
- a11y treatment (aria attributes, keyboard, screen reader)

The WCAG 2.2 AA rubric requires 8/8 states named per component.
`;

export const PERMISSION_AWARE_UX_TEMPLATE = `# Permission-aware UX

| Role | Action | Resource | Condition | Visible affordance |
|------|--------|----------|-----------|--------------------|
|      |        |          |           |                    |

If a role lacks permission for an action, the affordance MUST be either hidden
or shown disabled with explanatory tooltip. Don't hide silently when the user
might reasonably expect the affordance.
`;

export const LOCALIZATION_PLAN_TEMPLATE = `# Localization plan

## String-ID inventory
| Key | Source phrase | Notes |
|-----|---------------|-------|
|     |               |       |

## Locales
- shipped: en-US
- planned: ...

## RTL handling
- mirrored: true | false (per surface)
- specific exceptions: ...

## Pluralization
- ICU MessageFormat used? yes/no
- per-locale plural categories handled
`;

export const RESPONSIVE_MATRIX_TEMPLATE = `# Responsive matrix

| Breakpoint | Width range | Layout | Tested states |
|------------|-------------|--------|---------------|
| mobile     | <640        |        |               |
| tablet     | 640-1023    |        |               |
| desktop    | >=1024      |        |               |

Note: covers viewport sizes, not device categories.
`;

export const A11Y_PLAN_TEMPLATE = `# Accessibility plan (WCAG 2.2 AA)

## Keyboard navigation
- Tab order:
- Focus indicator:
- Focus traps (e.g., modals): ...

## Screen reader
- Landmark roles:
- Headings hierarchy:
- Live regions:
- Image alt text rule:

## Color and contrast
- Min contrast: 4.5:1 (normal text) / 3:1 (large text + UI components)
- Failures to fix: ...

## Motion
- Respect prefers-reduced-motion: yes/no
- Specific exceptions: ...

## Forms
- Labels associated: yes
- Error message location: inline + summary
- Required-field indicator beyond color
`;

export const TEMPLATES_BY_KIND: Record<string, string> = {
  screen_state_matrix: SCREEN_STATE_MATRIX_TEMPLATE,
  permission_aware_ux: PERMISSION_AWARE_UX_TEMPLATE,
  localization_plan:   LOCALIZATION_PLAN_TEMPLATE,
  responsive_matrix:   RESPONSIVE_MATRIX_TEMPLATE,
  a11y_plan:           A11Y_PLAN_TEMPLATE,
};

export function getDesignTemplate(kind: string): string | null {
  return TEMPLATES_BY_KIND[kind] ?? null;
}
