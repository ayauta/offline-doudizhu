export function parseBrowserTestArguments(arguments_: readonly string[]): Readonly<{
  skipBuild: boolean;
  testArguments: readonly string[];
}>;
