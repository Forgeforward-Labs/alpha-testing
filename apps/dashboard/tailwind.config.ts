import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0d0d0f',
        card: '#111115',
        border: '#1e1e26',
        muted: '#6b7280',
        accent: '#22c55e',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
};

export default config;
