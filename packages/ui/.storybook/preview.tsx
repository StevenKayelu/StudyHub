import './storybook.css';

import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';

import { compileAccent, consoleThemeCss, type FontPreset, themeCss } from '../src/theme/index.js';

/** The default theme and two demo school themes used by the axe and visual tests (07 M3 AC 1). */
const THEMES: Record<string, { accent: string | null; fontPreset: FontPreset }> = {
  copperline: { accent: null, fontPreset: 'COPPERLINE' },
  'school-teal': { accent: '#0b7285', fontPreset: 'HUMANIST' },
  'school-violet': { accent: '#6d28d9', fontPreset: 'GEOMETRIC' },
};

function cssFor(name: string): string {
  const theme = THEMES[name] ?? THEMES.copperline!;
  const compiled = theme.accent === null ? null : compileAccent(theme.accent);
  if (compiled !== null && !compiled.ok) throw new Error(`Demo theme ${name} does not compile`);
  return themeCss({ accent: compiled?.accent ?? null, fontPreset: theme.fontPreset });
}

const withTheme: Decorator = (Story, context) => {
  const theme = String(context.globals.theme ?? 'copperline');
  const scheme = String(context.globals.scheme ?? 'light');
  // The console never takes a school theme (06 §10.3).
  const isConsole = context.parameters.console === true;
  useEffect(() => {
    document.documentElement.dataset.theme = scheme;
    let style = document.getElementById('school-theme');
    if (style === null) {
      style = document.createElement('style');
      style.id = 'school-theme';
      document.head.append(style);
    }
    style.textContent = isConsole ? consoleThemeCss() : cssFor(theme);
    // Lets the story tests wait until the requested theme is applied.
    document.documentElement.dataset.appliedTheme = `${isConsole ? 'console' : theme}:${scheme}`;
  }, [theme, scheme, isConsole]);
  return <Story />;
};

const preview: Preview = {
  decorators: [withTheme],
  initialGlobals: { theme: 'copperline', scheme: 'light' },
  globalTypes: {
    theme: {
      description: 'School theme',
      toolbar: { title: 'Theme', items: Object.keys(THEMES), dynamicTitle: true },
    },
    scheme: {
      description: 'Colour scheme',
      toolbar: { title: 'Scheme', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
  },
};

export default preview;
