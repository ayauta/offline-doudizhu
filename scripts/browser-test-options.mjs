export function parseBrowserTestArguments(arguments_) {
  return Object.freeze({
    skipBuild: arguments_.includes("--skip-build"),
    testArguments: Object.freeze(
      arguments_.filter(
        (argument) => argument !== "--skip-build" && argument !== "--",
      ),
    ),
  });
}
