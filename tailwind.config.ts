import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d1117',
        panel: '#161b22',
        panel2: '#1c2230',
        edge: '#2a3140',
        ink: '#e6edf3',
        muted: '#8b949e',
        accent: '#f0883e',
        accent2: '#58a6ff',
        good: '#3fb950',
        warn: '#d29922',
        bad: '#f85149',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
