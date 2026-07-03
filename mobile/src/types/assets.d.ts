/** Ambient declarations for non-code imports used by Expo web (CSS / CSS modules). */

declare module '*.css';

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
