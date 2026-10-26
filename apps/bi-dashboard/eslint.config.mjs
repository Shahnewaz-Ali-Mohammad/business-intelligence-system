import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = [{ ignores: ['.next-development/**'] }, ...nextVitals, ...nextTs];

export default eslintConfig;
