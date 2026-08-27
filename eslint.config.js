/**
 * Flat ESLint config (ESLint 9).
 *
 * Deliberately lean: correctness rules that catch real mistakes, not style
 * opinions. Formatting is not enforced here.
 */

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  fetch: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  structuredClone: "readonly",
  __dirname: "readonly",
  // Web-standard APIs available as Node globals since 18.
  FormData: "readonly",
  Blob: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
};

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  console: "readonly",
  fetch: "readonly",
  WebSocket: "readonly",
  MediaRecorder: "readonly",
  Blob: "readonly",
  FileReader: "readonly",
  AudioContext: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  localStorage: "readonly",
  URL: "readonly",
  btoa: "readonly",
  atob: "readonly",
  Element: "readonly",
  HTMLElement: "readonly",
  HTMLAnchorElement: "readonly",
  Blob: "readonly",
  Node: "readonly",
  MediaRecorder: "readonly",
  Uint8Array: "readonly",
  MediaStream: "readonly",
  FormData: "readonly",
};

import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "dist/**",
      "**/dist/**",
      "coverage/**",
      "client/src/version.json",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      // An unhandled async rejection in a route handler is a silent 500.
      "no-async-promise-executor": "error",
      "require-atomic-updates": "warn",
    },
  },
  {
    files: ["server/**/*.js", "scripts/**/*.mjs"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ["client/**/*.js", "client/**/*.jsx"],
    languageOptions: { globals: browserGlobals },
    plugins: { react, "react-hooks": reactHooks },
    rules: {
      // Without these, ESLint cannot see that JSX references a binding and
      // reports every imported component as unused.
      "react/jsx-uses-react": "error",
      "react/jsx-uses-vars": "error",
      // Hook misuse is a real source of stale-state bugs, not a style matter.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: [
      "server/tests/**/*.js",
      "client/src/**/*.test.{js,jsx}",
      "client/src/test/**/*.js",
    ],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
    rules: {
      // Reassigning shared fixtures between async hooks is normal in tests and
      // not the race this rule is designed to catch.
      "require-atomic-updates": "off",
    },
  },
];
