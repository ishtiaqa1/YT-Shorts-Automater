import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      /** Standard data-fetch + form patterns call setState in effects when responses arrive — too noisy here. */
      'react-hooks/set-state-in-effect': 'off',
      /** Render timing / ETA widgets commonly read clocks; forbidding Date.now during render breaks simple UX polish. */
      'react-hooks/purity': 'off',
      /** Auth modules export hooks alongside providers — Vite Fast Refresh tolerates this. */
      'react-refresh/only-export-components': 'off',
    },
  },
])
