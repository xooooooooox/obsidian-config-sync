export const CONFIG_DIR_VARIABLE = "{configDir}";
export const STORE_CONFIG_DIR = "configdir";

export class PathingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathingError";
  }
}

export function groupRealPath(groupPath: string, configDir: string): string {
  if (groupPath.startsWith(CONFIG_DIR_VARIABLE + "/")) {
    return configDir + groupPath.slice(CONFIG_DIR_VARIABLE.length);
  }
  return groupPath;
}

export function groupStorePath(groupPath: string): string {
  if (groupPath.startsWith(CONFIG_DIR_VARIABLE + "/")) {
    return STORE_CONFIG_DIR + groupPath.slice(CONFIG_DIR_VARIABLE.length);
  }
  if (groupPath.startsWith(".")) {
    return groupPath.slice(1);
  }
  return groupPath;
}

export function relativeTo(base: string, full: string): string {
  if (!full.startsWith(base + "/")) {
    throw new PathingError(`"${full}" is not inside "${base}"`);
  }
  return full.slice(base.length + 1);
}
