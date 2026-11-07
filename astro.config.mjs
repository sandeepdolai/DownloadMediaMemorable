import { defineConfig } from 'astro/config';

const isVercel = process.env.VERCEL === '1';

export default defineConfig({
  site: isVercel ? 'https://memorableday.in' : 'https://sandeepdolai.github.io',
  base: isVercel ? '/' : '/Downloadmedia',
  output: 'static',
  build: {
    format: 'directory'
  }
});
