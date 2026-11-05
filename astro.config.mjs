import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://sandeepdolai.github.io',
  base: '/Downloadmedia',
  output: 'static',
  build: {
    format: 'directory'
  }
});