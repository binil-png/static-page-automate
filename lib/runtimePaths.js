import { existsSync } from "node:fs";
import path from "node:path";

export function runtimeDir() {
  const fromEnv = String(process.env.DATA_DIR || "").trim();
  return fromEnv ? path.resolve(fromEnv) : process.cwd();
}

export function runtimeFile(name) {
  return path.join(runtimeDir(), name);
}

export function generatedDir() {
  return path.join(runtimeDir(), "generated");
}

export function getServiceAccountWritePath() {
  const keyPath = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./credentials.json").trim();
  if (keyPath.startsWith("/etc/secrets/")) {
    return path.join(process.cwd(), "credentials.json");
  }
  return path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
}

export function serviceAccountReadPaths() {
  const paths = [];
  const fromEnv = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "").trim();
  if (fromEnv) {
    paths.push(path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv));
  }
  paths.push("/etc/secrets/credentials.json");
  paths.push("/etc/secrets/google-service-account.json");
  paths.push(path.join(process.cwd(), "credentials.json"));
  return [...new Set(paths)];
}

export function existingServiceAccountFile() {
  return serviceAccountReadPaths().find((filePath) => existsSync(filePath)) || "";
}
