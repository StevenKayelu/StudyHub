// @studyhub/ui/theme: framework-free theming (usable by the API and the web app).
export { contrastRatio, deltaE, type Hex, hexToOklch, normalizeHex, oklchToHex } from './color.js';
export {
  ACCENT_MIN_CONTRAST,
  type AccentRatios,
  type AccentRejection,
  compileAccent,
  type CompiledAccent,
  type CompileResult,
  MAX_LIGHTNESS_SHIFT,
  ratiosPass,
} from './compiler.js';
export {
  consoleThemeCss,
  FONT_PRESET_FAMILIES,
  FONT_PRESETS,
  type FontPreset,
  fontPresetVariables,
  themeCss,
  type ThemeCssInput,
} from './theme-css.js';
export {
  ACCENT_ROLES,
  type AccentTokens,
  type ColorRole,
  type ColorScheme,
  consoleAccent,
  contrastRequirements,
  darkColors,
  lightColors,
} from '../tokens/tokens.js';
