/** @type {import('tailwindcss').Config} */
export default {
  content: ['./public/**/*.html', './public/**/*.js'],
  theme: {
    extend: {
      colors: {
        hkbg: '#0b0f14',
        hkpanel: '#121923',
        hkaccent: '#ffd000',
      },
    },
  },
  plugins: [],
};
