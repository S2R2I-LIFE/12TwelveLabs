# Tailwind Dark Mode & Mobile Responsive Design

## Dark Mode Setup

### 1. Enable in `tailwind.config.ts`
```typescript
export default {
  content: ["./src/**/*.tsx"],
  darkMode: "class",   // ← add this
  theme: { ... },
} satisfies Config;
```

### 2. ThemeProvider — applies `dark` class to `<html>`

```tsx
// src/components/theme-provider.tsx
"use client";
import { useEffect } from "react";
import { useUIStore } from "~/stores/ui-store";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const isDarkMode = useUIStore((s) => s.isDarkMode);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
  }, [isDarkMode]);

  return <>{children}</>;
}
```

### 3. Wrap children in root layout

```tsx
// src/app/layout.tsx
import { ThemeProvider } from "~/components/theme-provider";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-white dark:bg-gray-900">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

### 4. Add toggle to Zustand store

```typescript
// src/stores/ui-store.ts
interface UIState {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
}

// in create():
isDarkMode: false,
toggleDarkMode: () => set((state) => ({ isDarkMode: !state.isDarkMode })),
```

### 5. Toggle button in sidebar

```tsx
import { IoMoonOutline, IoSunnyOutline } from "react-icons/io5";
const { isDarkMode, toggleDarkMode } = useUIStore();

<button onClick={toggleDarkMode}>
  {isDarkMode ? <IoSunnyOutline /> : <IoMoonOutline />}
</button>
```

## Dark Mode Color Mapping

| Light class | Dark variant | Use case |
|---|---|---|
| `bg-white` | `dark:bg-gray-900` | Main surfaces (sidebar, page bg) |
| `bg-gray-50` | `dark:bg-gray-800` | Slightly elevated surfaces |
| `bg-gray-100` | `dark:bg-gray-700` | Active/selected, hover targets |
| `bg-gray-200` | `dark:bg-gray-600` | Badges, dividers |
| `border-gray-200` | `dark:border-gray-700` | Standard borders |
| `border-gray-100` | `dark:border-gray-800` | Subtle borders |
| `text-gray-900` | `dark:text-white` | Primary text |
| `text-gray-700` | `dark:text-gray-300` | Secondary text |
| `text-gray-500/600` | `dark:text-gray-400` | Muted text |
| `text-gray-400` | `dark:text-gray-500` | Very muted text |
| `hover:bg-gray-100` | `dark:hover:bg-gray-700` | Hover states on surfaces |
| `hover:bg-gray-50` | `dark:hover:bg-gray-800` | Lighter hover states |
| `bg-red-50` | `dark:bg-red-900/20` | Error backgrounds |
| `text-red-700` | `dark:text-red-400` | Error text |
| `bg-green-50` | `dark:bg-green-900/20` | Success backgrounds |
| `text-green-800` | `dark:text-green-400` | Success text |
| `bg-amber-50` | `dark:bg-amber-900/20` | Warning backgrounds |

## Primary Action Buttons (inverted in dark mode)

Black buttons become white in dark mode for contrast:
```tsx
className="bg-black text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-100"
```

Log console stays dark in both modes, just slightly darker in dark mode:
```tsx
className="bg-gray-900 text-green-400 dark:bg-gray-950"
```

## Mobile Responsive Patterns

### Responsive Padding
```tsx
// Content area padding
className="px-3 py-3 md:px-6 md:py-5"

// Form padding on small screens
className="p-4 sm:p-8"
```

### Responsive Layout (stacked → side-by-side)
```tsx
// Train wizard stepper + content
className="flex h-full flex-col gap-4 md:flex-row md:gap-6"

// Stepper panel
className="md:w-52 md:flex-shrink-0"  // full width on mobile
```

### Mobile Step Indicator Pattern

Show compact horizontal dots on mobile, full vertical list on desktop:
```tsx
{/* Mobile: horizontal dots */}
<div className="flex items-center gap-1 overflow-x-auto pb-1 md:hidden">
  {STEP_LABELS.map((label, idx) => {
    const n = idx + 1;
    const done = n < step;
    const active = n === step;
    return (
      <div key={n} className="flex flex-shrink-0 flex-col items-center gap-1">
        <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium
          ${active ? "bg-gray-900 text-white" : done ? "bg-green-500 text-white" : "bg-gray-200 text-gray-400"}`}>
          {done ? <IoCheckmarkCircle className="h-4 w-4" /> : n}
        </div>
        {active && <span className="max-w-[56px] text-center text-[10px] leading-tight">{label}</span>}
      </div>
    );
  })}
</div>

{/* Desktop: vertical list */}
<ol className="hidden space-y-1 md:block">
  {/* full stepper */}
</ol>
```

### Mobile Drawer (already in this project)

`page-layout.tsx` already has mobile drawer infrastructure:
- `isMobileScreen` — set via `window.innerWidth < 1024` resize listener
- `toggleMobileDrawer` — shows/hides the sidebar via `translate-x`
- `MobileSettingsButton` — fixed bottom-right FAB that opens the settings sheet
- `SpeechSidebar` — already has a bottom sheet (`translate-y`) for mobile

### Breakpoints Used

| Prefix | Min-width | Use case |
|---|---|---|
| (none) | 0px | Mobile first |
| `sm:` | 640px | Small phone → tablet |
| `md:` | 768px | Tablet — hide mobile-only UI |
| `lg:` | 1024px | Desktop — show full sidebar |

## Pitfalls

### `[]` triggers block mode in Next.js `allowedDevOrigins`
```js
// WRONG — [] causes Next.js to block all origins
allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",") ?? []

// CORRECT — omit entirely when unset
...(process.env.ALLOWED_DEV_ORIGINS
  ? { allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS.split(",").map(h => h.trim()) }
  : {})
```

### Dark class must be on `<html>`, not a wrapper div
`darkMode: "class"` looks for the `dark` class on `document.documentElement` (`<html>`). Toggling it on a div only affects descendants of that div, not the full page (body bg, etc.).
