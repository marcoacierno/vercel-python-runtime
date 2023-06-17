import { join, dirname, basename } from "path";
import execa from "execa";
import fs from "fs";
import { promisify } from "util";
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
import {
  GlobOptions,
  BuildOptions,
  // getWriteableDirectory,
  download,
  glob,
  createLambda,
  shouldServe,
  debug,
  // NowBuildError,
} from "@vercel/build-utils";
import { installRequirement, installRequirementsFile } from "./install";
import { getLatestPythonVersion } from "./version";

export const version = 3;

export async function downloadFilesInWorkPath({
  entrypoint,
  workPath,
  files,
  meta = {},
}: Pick<BuildOptions, "entrypoint" | "workPath" | "files" | "meta">) {
  debug("Downloading user files...");
  let downloadedFiles = await download(files, workPath, meta);
  if (meta.isDev) {
    // Old versions of the CLI don't assign this property
    const { devCacheDir = join(workPath, ".now", "cache") } = meta;
    const destCache = join(devCacheDir, basename(entrypoint, ".py"));
    await download(downloadedFiles, destCache);
    downloadedFiles = await glob("**", destCache);
    workPath = destCache;
  }
  return workPath;
}

export const build = async ({
  workPath,
  files: originalFiles,
  entrypoint,
  meta = {},
  config,
}: BuildOptions) => {
  let pythonVersion = getLatestPythonVersion(meta);

  workPath = await downloadFilesInWorkPath({
    workPath,
    files: originalFiles,
    entrypoint,
    meta,
  });

  console.log("Installing required dependencies...");

  await installRequirement({
    pythonPath: pythonVersion.pythonPath,
    pipPath: pythonVersion.pipPath,
    dependency: "werkzeug",
    version: "1.0.1",
    workPath,
    meta,
  });

  await installRequirement({
    pythonPath: pythonVersion.pythonPath,
    pipPath: pythonVersion.pipPath,
    dependency: "urllib3",
    version: "1.26.6",
    workPath,
    meta,
  });

  let fsFiles = await glob("**", workPath);
  const entryDirectory = dirname(entrypoint);

  fsFiles = await glob("**", workPath);
  const requirementsTxt = join(entryDirectory, "requirements.txt");

  if (fsFiles[requirementsTxt]) {
    debug('Found local "requirements.txt"');
    const requirementsTxtPath = fsFiles[requirementsTxt].fsPath;
    await installRequirementsFile({
      pythonPath: pythonVersion.pythonPath,
      pipPath: pythonVersion.pipPath,
      filePath: requirementsTxtPath,
      workPath,
      meta,
    });
  } else if (fsFiles["requirements.txt"]) {
    debug('Found global "requirements.txt"');
    const requirementsTxtPath = fsFiles["requirements.txt"].fsPath;
    await installRequirementsFile({
      pythonPath: pythonVersion.pythonPath,
      pipPath: pythonVersion.pipPath,
      filePath: requirementsTxtPath,
      workPath,
      meta,
    });
  }

  const originalPyPath = join(__dirname, "..", "vc_init.py");
  const originalHandlerPyContents = await readFile(originalPyPath, "utf8");
  debug("Entrypoint is", entrypoint);
  const moduleName = entrypoint.replace(/\//g, ".").replace(/\.py$/, "");
  // Since `vercel dev` renames source files, we must reference the original
  const suffix = meta.isDev && !entrypoint.endsWith(".py") ? ".py" : "";
  const entrypointWithSuffix = `${entrypoint}${suffix}`;
  debug("Entrypoint with suffix is", entrypointWithSuffix);
  const handlerPyContents = originalHandlerPyContents
    .replace(/__VC_HANDLER_MODULE_NAME/g, moduleName)
    .replace(/__VC_HANDLER_ENTRYPOINT/g, entrypointWithSuffix);

  // in order to allow the user to have `server.py`, we need our `server.py` to be called
  // somethig else
  const handlerPyFilename = "vc__handler__python";

  await writeFile(join(workPath, `${handlerPyFilename}.py`), handlerPyContents);

  const globOptions: GlobOptions = {
    // @ts-ignore
    cwd: workPath,
    ignore:
      config && typeof config.excludeFiles === "string"
        ? config.excludeFiles
        : "node_modules/**",
  };

  const lambda = await createLambda({
    files: await glob("**", globOptions),
    handler: `${handlerPyFilename}.vc_handler`,
    runtime: pythonVersion.runtime,
    environment: {},
  });

  return { output: lambda };
};

export { shouldServe };

// internal only - expect breaking changes if other packages depend on these exports
export { installRequirement, installRequirementsFile };
