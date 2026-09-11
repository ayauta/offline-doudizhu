export function runtimeModuleSpecifiers(source: string): string[];
export function runtimeImportClosure(
  sources: ReadonlyMap<string, string>,
  entryPath: string,
): ReadonlySet<string>;
