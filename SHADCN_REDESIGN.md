# ShadCN UI Redesign Documentation

## Overview

This document explains the ShadCN-inspired redesign of the ClaudeMarble overlay component. The redesign improves accessibility, visual hierarchy, responsiveness, and follows modern design best practices.

## 🎨 Design Principles

### 1. **Clean, Minimalist Color Palette**
- Uses ShadCN's slate color palette for a professional look
- Subtle shadows and borders for depth without visual clutter
- Supports both light and dark modes via CSS custom properties

### 2. **Smooth Transitions**
- All interactive elements have smooth transitions (150-300ms)
- Uses cubic-bezier easing for natural motion
- Respects user's reduced-motion preferences

### 3. **Consistent Spacing**
- Based on 4px scale (0.25rem increments)
- Predictable spacing creates visual rhythm
- Responsive adjustments for smaller viewports

### 4. **Modern Typography**
- Inter font family for clean, modern text
- Monospace font for code/status displays
- Proper font sizing hierarchy (0.75rem - 1.25rem)

### 5. **Full Accessibility**
- ARIA attributes on all interactive elements
- Keyboard navigation support
- Focus indicators for keyboard users
- Screen reader announcements

### 6. **Responsive Design**
- Mobile-first approach
- Grid system adapts to viewport size
- Touch-friendly tap targets (minimum 44x44px)

## 📁 Files Changed

### New Files

1. **`src/overlay-shadcn.css`** (627 lines)
   - Complete ShadCN-inspired design system
   - CSS custom properties for theming
   - Responsive utilities
   - Accessibility helpers

2. **`examples/shadcn-react-reference.tsx`** (550+ lines)
   - Full React + TypeScript + ShadCN implementation
   - Reference for future migration
   - Production-ready component

3. **`examples/tailwind.config.js`**
   - Tailwind configuration for ShadCN
   - Custom theme tokens
   - Animation utilities

### Modified Files

1. **`src/Overlay.js`**
   - Added `addAccessibility()` method
   - Added `enableKeyboardNavigation()` method
   - Enhanced `handleDrag()` with ARIA support

## 🎯 Key Features

### Accessibility Improvements

#### Keyboard Navigation
- **Tab**: Navigate through interactive elements
- **Enter/Space**: Activate buttons
- **Escape**: Minimize/close overlay
- **Arrow keys**: Move overlay when drag handle is focused
  - Hold Shift for larger steps (50px vs 10px)

#### ARIA Attributes
```javascript
// Drag handle
dragHandle.setAttribute('role', 'button');
dragHandle.setAttribute('aria-label', 'Drag to move overlay. Use arrow keys to reposition.');
dragHandle.setAttribute('tabindex', '0');

// Overlay container
overlayElement.setAttribute('role', 'dialog');
overlayElement.setAttribute('aria-modal', 'false');
```

#### Screen Reader Support
- Semantic HTML elements (buttons, inputs, labels)
- Hidden decorative elements with `aria-hidden`
- Status announcements via `aria-live` regions

### Visual Design

#### Color System
```css
:root {
  /* Slate palette - light mode */
  --overlay-bg: 255 255 255;
  --overlay-fg: 15 23 42;
  --overlay-border: 226 232 240;
  --overlay-primary: 15 23 42;
  --overlay-destructive: 239 68 68;
  --overlay-ring: 148 163 184;
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Slate palette - dark mode */
    --overlay-bg: 15 23 42;
    --overlay-fg: 248 250 252;
    /* ... */
  }
}
```

#### Shadows
- **sm**: `0 1px 2px 0 rgb(0 0 0 / 0.05)`
- **md**: `0 4px 6px -1px rgb(0 0 0 / 0.1)`
- **lg**: `0 10px 15px -3px rgb(0 0 0 / 0.1)`
- **xl**: `0 20px 25px -5px rgb(0 0 0 / 0.1)`

#### Border Radius
- **sm**: `0.375rem` (6px)
- **md**: `0.5rem` (8px)
- **lg**: `0.75rem` (12px)
- **xl**: `1rem` (16px)

### Responsive Breakpoints

```css
/* Mobile */
@media (max-width: 640px) {
  #bm-overlay {
    max-width: calc(100vw - 2rem);
    padding: 1rem;
    gap: 1rem;
  }

  #bm-contain-coords #bm-contain-inputs {
    grid-template-columns: repeat(2, 1fr); /* 2 columns instead of 4 */
  }
}
```

## 🚀 Usage

### Vanilla JavaScript (Current Implementation)

#### 1. Include the CSS

```html
<!-- In your userscript metadata -->
// @resource CSS-SHADCN https://raw.githubusercontent.com/.../overlay-shadcn.css
```

```javascript
// In your main.js
const shadcnCSS = GM_getResourceText('CSS-SHADCN');
GM_addStyle(shadcnCSS);
```

#### 2. Use Accessibility Methods

```javascript
import Overlay from './Overlay.js';

const overlay = new Overlay();

// Build your overlay
overlay
  .addDiv({ id: 'my-overlay' })
    .addButton({ id: 'my-button', textContent: 'Click me' }, (instance, btn) => {
      // Add accessibility
      instance.addAccessibility(btn, {
        role: 'button',
        label: 'Submit form',
      });
    })
    .buildElement()
  .buildOverlay(document.body);

// Enable keyboard navigation
overlay.handleDrag('my-overlay', 'drag-handle');
// Keyboard navigation is automatically enabled by handleDrag
```

### React + TypeScript (Migration Path)

If you want to migrate to React + TypeScript with actual ShadCN UI:

#### 1. Install Dependencies

```bash
npm install react react-dom
npm install -D @types/react @types/react-dom typescript
npm install @radix-ui/react-dialog
npm install class-variance-authority
npm install tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

#### 2. Configure Tailwind

```bash
# Copy the reference config
cp examples/tailwind.config.js tailwind.config.js
```

#### 3. Add CSS Variables

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
}
```

#### 4. Use the Component

```tsx
import { MarbleOverlay } from './components/MarbleOverlay';

export default function App() {
  return <MarbleOverlay version="1.0.0" />;
}
```

See `examples/shadcn-react-reference.tsx` for the complete implementation.

## 🎨 Design Choices

### Why ShadCN UI?

1. **Modern & Professional**: Used by companies like Vercel, Cal.com, and Supabase
2. **Accessible by Default**: Built on Radix UI primitives
3. **Customizable**: Uses CSS variables for easy theming
4. **No Lock-in**: Components are copied to your project, not installed
5. **Type-safe**: First-class TypeScript support

### Why These Colors?

- **Slate palette**: Professional, neutral, works in light and dark modes
- **High contrast**: Meets WCAG AA accessibility standards
- **Subtle gradients**: Modern without being distracting

### Why This Spacing Scale?

- **4px base**: Consistent with Tailwind and modern design systems
- **Powers of 2**: 4, 8, 12, 16, 20, 24, 32 - easy mental math
- **Flexible**: Can be combined for custom spacing

## 📊 Before & After Comparison

### Before (Original)
```css
#bm-overlay button {
  background-color: #144eb9;
  border-radius: 1em;
  padding: 0 0.75ch;
}
```
- Hard-coded colors
- Inconsistent units (em, ch)
- No accessibility considerations

### After (ShadCN-inspired)
```css
#bm-overlay button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-2);
  padding: var(--spacing-2) var(--spacing-4);

  background: rgb(var(--overlay-primary));
  color: rgb(var(--overlay-primary-fg));
  border-radius: var(--radius-md);

  transition: all var(--transition-fast);
}

#bm-overlay button:focus-visible {
  outline: 2px solid rgb(var(--overlay-ring));
  outline-offset: 2px;
}
```
- Uses CSS custom properties (themable)
- Consistent spacing scale
- Accessibility focus states
- Smooth transitions

## 🧪 Testing

### Accessibility Testing

1. **Keyboard Navigation**
   - Tab through all interactive elements
   - Use arrow keys on drag handle
   - Press Escape to minimize

2. **Screen Reader Testing**
   - Test with NVDA (Windows) or VoiceOver (Mac)
   - Verify all buttons are announced correctly
   - Check form labels are associated

3. **Color Contrast**
   - Use WebAIM Contrast Checker
   - Verify WCAG AA compliance (4.5:1 for text)

### Responsive Testing

1. **Desktop** (1920x1080)
   - Overlay should be 400px wide
   - All elements visible

2. **Tablet** (768x1024)
   - Overlay adapts to screen width
   - Touch targets are 44x44px minimum

3. **Mobile** (375x667)
   - Grid switches to 2 columns
   - Reduced padding for more content space

## 🔧 Customization

### Changing Colors

```css
:root {
  /* Change primary color to blue */
  --overlay-primary: 59 130 246;
  --overlay-primary-fg: 248 250 252;
}
```

### Changing Spacing

```css
:root {
  /* Use 8px base instead of 4px */
  --spacing-1: 0.5rem;  /* 8px */
  --spacing-2: 1rem;    /* 16px */
  --spacing-3: 1.5rem;  /* 24px */
  --spacing-4: 2rem;    /* 32px */
}
```

### Adding Dark Mode Toggle

```javascript
// Add button to toggle dark mode
const toggleDarkMode = () => {
  document.documentElement.classList.toggle('dark');
};

overlay.addButton({
  textContent: 'Toggle Dark Mode',
  onclick: toggleDarkMode
});
```

## 📚 Resources

- [ShadCN UI Documentation](https://ui.shadcn.com/)
- [Radix UI Primitives](https://www.radix-ui.com/)
- [Tailwind CSS](https://tailwindcss.com/)
- [WCAG Accessibility Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [MDN Web Docs - ARIA](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA)

## 🐛 Known Issues

1. **File input styling**: Native file inputs are difficult to style consistently
   - Workaround: Use hidden input with custom button trigger

2. **Drag on mobile**: Touch events can conflict with scrolling
   - Workaround: Use `touch-action: none` on drag handle

3. **Focus outline**: Some browsers show double outline
   - Workaround: Use `:focus-visible` instead of `:focus`

## 🚧 Future Improvements

1. **Animation Library**: Add micro-interactions with Framer Motion
2. **Virtualization**: For large template lists, use react-window
3. **Persistence**: Save overlay position to localStorage
4. **Themes**: Add pre-built themes (ocean, forest, sunset)
5. **Shortcuts**: Add customizable keyboard shortcuts

## 📝 License

This redesign follows the same license as the ClaudeMarble project (MPL-2.0).

## 🙏 Credits

- Design inspired by [ShadCN UI](https://ui.shadcn.com/)
- Icons from [Feather Icons](https://feathericons.com/)
- Color palette from [Tailwind CSS](https://tailwindcss.com/docs/customizing-colors)

---

**Last Updated**: 2025-10-31
**Version**: 1.0.0
