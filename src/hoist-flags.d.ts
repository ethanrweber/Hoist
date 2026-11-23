// The flags module that build.ts makes for page.ts when it bundles the page: each flag's SVG from src/flags/, by
// code, resized at build time. tsconfig.page.json includes this file, so page.ts imports the module with this type.
declare module "hoist:flags" {
  const FLAGS: Readonly<Record<import("./core.ts").Code, string>>;
  export default FLAGS;
}
