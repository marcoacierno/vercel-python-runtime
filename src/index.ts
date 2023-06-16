import { join, dirname, basename } from "path";
import execa from "execa";
import fs from "fs";
import { promisify } from "util";
import os from "os";
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
import {
  GlobOptions,
  BuildOptions,
  getWriteableDirectory,
  download,
  glob,
  createLambda,
  shouldServe,
  debug,
  NowBuildError,
} from "@vercel/build-utils";
import { installRequirement, installRequirementsFile } from "./install";
import { getLatestPythonVersion, getSupportedPythonVersion } from "./version";

async function pipenvConvert(cmd: string, srcDir: string) {
  debug("Running pipfile2req...");
  try {
    const out = await execa.stdout(cmd, [], {
      cwd: srcDir,
    });
    debug("Contents of requirements.txt is: " + out);
    fs.writeFileSync(join(srcDir, "requirements.txt"), out);
  } catch (err) {
    console.log('Failed to run "pipfile2req"');
    throw err;
  }
}

async function collectstatic(srcDir: string, _pythonPath: any) {
  console.log("collecting static!");
  // const globtest = await glob("**", srcDir);
  // console.log("Running collectstatic...", srcDir, globtest);

  const vers = await execa.stdout("python3.9", ["--version"], {
    cwd: srcDir,
  });
  console.log("tt ->", vers);

  try {
    const out = await execa.stdout(
      "python3.9",
      ["manage.py", "collectstatic", "--no-input"],
      {
        cwd: srcDir,
      }
    );
    console.log("Collectstatic output " + out);
  } catch (err) {
    console.log('Failed to run "collectstatic"', err);
    throw err;
  }
}

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

  //  sudo apt-get install openssl
  await execa("yum", ["remove", "openssl-devel"], {
    cwd: workPath,
  });
  await execa(
    "yum",
    [
      "install",
      "openssl11",
      "openssl11-devel",
      "libffi-devel",
      "bzip2-devel",
      "wget",
      "-y",
    ],
    {
      cwd: workPath,
    }
  );
  await execa(
    "wget",
    ["https://www.python.org/ftp/python/3.10.4/Python-3.10.4.tgz"],
    {
      cwd: workPath,
    }
  );
  await execa("tar", ["-xvf", "Python-3.10.4.tgz"], {
    cwd: workPath,
  });
  await execa("./configure", ["--enable-optimizations"], {
    cwd: `${workPath}/Python-3.10.4`,
  });
  await execa("make", ["-j", os.cpus().length.toString()], {
    cwd: `${workPath}/Python-3.10.4`,
  });
  await execa("make", ["altinstall"], {
    cwd: `${workPath}/Python-3.10.4`,
  });

  const out = await execa("python3.9", ["--version"], {
    cwd: workPath,
  });
  console.log("!!", pythonVersion, "out", out);

  await execa(pythonVersion.pipPath, ["install", "pdm"], {
    cwd: workPath,
  });

  await execa("pdm", ["install"], {
    cwd: workPath,
  });

  try {
    // See: https://stackoverflow.com/a/44728772/376773
    //
    // The `setup.cfg` is required for `vercel dev` on MacOS, where without
    // this file being present in the src dir then this error happens:
    //
    // distutils.errors.DistutilsOptionError: must supply either home
    // or prefix/exec-prefix -- not both
    if (meta.isDev) {
      const setupCfg = join(workPath, "setup.cfg");
      await writeFile(setupCfg, "[install]\nprefix=\n");
    }
  } catch (err) {
    console.log('Failed to create "setup.cfg" file');
    throw err;
  }

  console.log("Installing required dependencies...");

  await installRequirement({
    pythonPath: pythonVersion.pythonPath,
    pipPath: pythonVersion.pipPath,
    dependency: "werkzeug",
    version: "1.0.1",
    workPath,
    meta,
  });

  let fsFiles = await glob("**", workPath);
  const entryDirectory = dirname(entrypoint);

  const pipfileLockDir = fsFiles[join(entryDirectory, "Pipfile.lock")]
    ? join(workPath, entryDirectory)
    : fsFiles["Pipfile.lock"]
    ? workPath
    : null;

  if (pipfileLockDir) {
    debug('Found "Pipfile.lock"');

    let lock: {
      _meta?: {
        requires?: {
          python_version?: string;
        };
      };
    } = {};
    try {
      const json = await readFile(join(pipfileLockDir, "Pipfile.lock"), "utf8");
      lock = JSON.parse(json);
    } catch (err) {
      throw new NowBuildError({
        code: "INVALID_PIPFILE_LOCK",
        message: "Unable to parse Pipfile.lock",
      });
    }

    pythonVersion = getSupportedPythonVersion({
      isDev: meta.isDev,
      pipLockPythonVersion: lock?._meta?.requires?.python_version,
    });

    // Convert Pipenv.Lock to requirements.txt.
    // We use a different`workPath` here because we want `pipfile-requirements` and it's dependencies
    // to not be part of the lambda environment. By using pip's `--target` directive we can isolate
    // it into a separate folder.
    const tempDir = await getWriteableDirectory();
    await installRequirement({
      pythonPath: pythonVersion.pythonPath,
      pipPath: pythonVersion.pipPath,
      dependency: "pipfile-requirements",
      version: "0.3.0",
      workPath: tempDir,
      meta,
      args: ["--no-warn-script-location"],
    });

    // Python needs to know where to look up all the packages we just installed.
    // We tell it to use the same location as used with `--target`
    process.env.PYTHONPATH = tempDir;
    const convertCmd = join(tempDir, "bin", "pipfile2req");
    await pipenvConvert(convertCmd, pipfileLockDir);
  }

  fsFiles = await glob("**", workPath);
  // const requirementsTxt = join(entryDirectory, "requirements.txt");

  // if (fsFiles[requirementsTxt]) {
  //   debug('Found local "requirements.txt"');
  //   const requirementsTxtPath = fsFiles[requirementsTxt].fsPath;
  //   await installRequirementsFile({
  //     pythonPath: pythonVersion.pythonPath,
  //     pipPath: pythonVersion.pipPath,
  //     filePath: requirementsTxtPath,
  //     workPath,
  //     meta,
  //   });
  // } else if (fsFiles["requirements.txt"]) {
  //   debug('Found global "requirements.txt"');
  //   const requirementsTxtPath = fsFiles["requirements.txt"].fsPath;
  //   await installRequirementsFile({
  //     pythonPath: pythonVersion.pythonPath,
  //     pipPath: pythonVersion.pipPath,
  //     filePath: requirementsTxtPath,
  //     workPath,
  //     meta,
  //   });
  // }
  console.log("run collect static!");
  await collectstatic(workPath, pythonVersion.pythonPath);
  console.log("after static!");

  const originalPyPath = join(__dirname, "..", "vc_init.py");
  const originalHandlerPyContents = await readFile(originalPyPath, "utf8");
  console.log("Entrypoint is", entrypoint);
  const moduleName = entrypoint.replace(/\//g, ".").replace(/\.py$/, "");
  // Since `vercel dev` renames source files, we must reference the original
  const suffix = meta.isDev && !entrypoint.endsWith(".py") ? ".py" : "";
  const entrypointWithSuffix = `${entrypoint}${suffix}`;
  console.log("Entrypoint with suffix is", entrypointWithSuffix);
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

  console.log("hello there!");

  return { output: lambda };
};

export { shouldServe };

// internal only - expect breaking changes if other packages depend on these exports
export { installRequirement, installRequirementsFile };
