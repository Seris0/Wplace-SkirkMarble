# ShadCN Overlay Quick Reference

## 🎨 Color Tokens

```css
/* Light Mode */
--overlay-bg: 255 255 255          /* White background */
--overlay-fg: 15 23 42             /* Slate-900 text */
--overlay-border: 226 232 240      /* Slate-200 border */
--overlay-primary: 15 23 42        /* Slate-900 primary */
--overlay-destructive: 239 68 68   /* Red-500 danger */
--overlay-ring: 148 163 184        /* Slate-400 focus */

/* Dark Mode */
--overlay-bg: 15 23 42             /* Slate-900 background */
--overlay-fg: 248 250 252          /* Slate-50 text */
--overlay-border: 51 65 85         /* Slate-700 border */
```

## 📏 Spacing Scale

| Token | Value | Pixels |
|-------|-------|--------|
| `--spacing-1` | 0.25rem | 4px |
| `--spacing-2` | 0.5rem | 8px |
| `--spacing-3` | 0.75rem | 12px |
| `--spacing-4` | 1rem | 16px |
| `--spacing-5` | 1.25rem | 20px |
| `--spacing-6` | 1.5rem | 24px |
| `--spacing-8` | 2rem | 32px |

## 🔲 Border Radius

| Token | Value | Pixels |
|-------|-------|--------|
| `--radius-sm` | 0.375rem | 6px |
| `--radius-md` | 0.5rem | 8px |
| `--radius-lg` | 0.75rem | 12px |
| `--radius-xl` | 1rem | 16px |

## 🌓 Shadows

```css
--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05)
--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1)
--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1)
--shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1)
```

## ⏱️ Transitions

```css
--transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1)
--transition-base: 200ms cubic-bezier(0.4, 0, 0.2, 1)
--transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1)
```

## 🎯 Accessibility Features

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Navigate elements |
| `Enter` / `Space` | Activate button |
| `Escape` | Minimize overlay |
| `Arrow Keys` | Move overlay (when drag handle focused) |
| `Shift + Arrow` | Move overlay faster (50px steps) |

### ARIA Attributes

```javascript
// Button
element.setAttribute('role', 'button');
element.setAttribute('aria-label', 'Descriptive label');

// Dialog
element.setAttribute('role', 'dialog');
element.setAttribute('aria-modal', 'false');

// Drag handle
element.setAttribute('aria-label', 'Drag to move overlay');
element.setAttribute('tabindex', '0');
```

## 🎨 Component Patterns

### Button

```css
.button {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-2);
  padding: var(--spacing-2) var(--spacing-4);
  background: rgb(var(--overlay-primary));
  color: rgb(var(--overlay-primary-fg));
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.button:hover {
  background: rgb(var(--overlay-primary) / 0.9);
}

.button:focus-visible {
  outline: 2px solid rgb(var(--overlay-ring));
  outline-offset: 2px;
}
```

### Input

```css
.input {
  padding: var(--spacing-2) var(--spacing-3);
  background: rgb(var(--overlay-input));
  border: 1px solid rgb(var(--overlay-border));
  border-radius: var(--radius-md);
  transition: border-color var(--transition-fast);
}

.input:focus {
  border-color: rgb(var(--overlay-ring));
  box-shadow: 0 0 0 3px rgb(var(--overlay-ring) / 0.1);
}
```

### Card

```css
.card {
  padding: var(--spacing-4);
  background: rgb(var(--overlay-muted));
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
```

## 📱 Responsive Breakpoints

```css
/* Mobile */
@media (max-width: 640px) {
  /* 2-column grid */
  grid-template-columns: repeat(2, 1fr);
  padding: var(--spacing-4);
}

/* Tablet */
@media (min-width: 641px) and (max-width: 1024px) {
  /* 3-column grid */
  grid-template-columns: repeat(3, 1fr);
}

/* Desktop */
@media (min-width: 1025px) {
  /* 4-column grid */
  grid-template-columns: repeat(4, 1fr);
}
```

## 🔧 Utility Classes

```css
/* Flexbox */
.flex { display: flex; }
.flex-col { flex-direction: column; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }

/* Spacing */
.gap-2 { gap: var(--spacing-2); }
.gap-4 { gap: var(--spacing-4); }
.p-4 { padding: var(--spacing-4); }

/* Text */
.text-sm { font-size: 0.875rem; }
.text-muted { color: rgb(var(--overlay-muted-fg)); }
.font-medium { font-weight: 500; }

/* Borders */
.rounded-md { border-radius: var(--radius-md); }
.rounded-lg { border-radius: var(--radius-lg); }
```

## 🚀 Quick Start

### 1. Include CSS

```javascript
// In your userscript
const shadcnCSS = GM_getResourceText('CSS-SHADCN');
GM_addStyle(shadcnCSS);
```

### 2. Build Overlay

```javascript
const overlay = new Overlay();

overlay
  .addDiv({ id: 'bm-overlay' })
    .addButton({ textContent: 'Click Me' })
    .buildElement()
  .buildOverlay(document.body);
```

### 3. Enable Drag & Keyboard

```javascript
overlay.handleDrag('bm-overlay', 'drag-handle');
// Keyboard navigation is auto-enabled!
```

## 🎨 Customization Examples

### Change Primary Color

```css
:root {
  --overlay-primary: 59 130 246;  /* Blue-500 */
}
```

### Change Spacing Scale

```css
:root {
  --spacing-4: 1.5rem;  /* 24px instead of 16px */
}
```

### Add Custom Shadow

```css
.custom-shadow {
  box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25);
}
```

## 📦 File Structure

```
ClaudeMarble/
├── src/
│   ├── overlay-shadcn.css      ← New design system
│   ├── Overlay.js              ← Updated with a11y
│   ├── overlay.css             ← Original styles
│   └── ...
├── examples/
│   ├── shadcn-react-reference.tsx  ← React example
│   ├── tailwind.config.js          ← Tailwind config
│   └── QUICK_REFERENCE.md          ← This file
└── SHADCN_REDESIGN.md          ← Full documentation
```

## 🔗 Resources

- [Full Documentation](../SHADCN_REDESIGN.md)
- [ShadCN UI](https://ui.shadcn.com/)
- [Radix UI](https://www.radix-ui.com/)
- [WCAG Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

---

**Quick Tip**: Use browser DevTools to inspect CSS variables and see live values!

```javascript
// In browser console
getComputedStyle(document.documentElement)
  .getPropertyValue('--overlay-primary')
// Output: " 15 23 42"
```
