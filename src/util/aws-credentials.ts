import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
}

function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";"))
      continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      // config file uses "[profile name]", credentials file uses "[name]"
      const name = line.slice(1, -1).trim().replace(/^profile\s+/, "");
      current = new Map();
      sections.set(name, current);
    } else if (current) {
      const eq = line.indexOf("=");
      if (eq >= 0)
        current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return sections;
}

function readSection(path: string, profile: string): Map<string, string> | undefined {
  try {
    return parseIni(readFileSync(path, "utf8")).get(profile);
  } catch {
    return undefined;
  }
}

// Credential chain: env vars > ~/.aws/credentials > ~/.aws/config
export function loadAwsCredentials(profile?: string): AwsCredentials {
  const profileName =
    profile ??
    process.env.AWS_PROFILE ??
    process.env.AWS_DEFAULT_PROFILE ??
    "default";

  const envKey = process.env.AWS_ACCESS_KEY_ID;
  const envSecret = process.env.AWS_SECRET_ACCESS_KEY;
  if (envKey && envSecret) {
    return {
      accessKeyId: envKey,
      secretAccessKey: envSecret,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }

  const home = homedir();
  const credsPath =
    process.env.AWS_SHARED_CREDENTIALS_FILE ??
    resolve(home, ".aws", "credentials");
  const cfgPath =
    process.env.AWS_CONFIG_FILE ?? resolve(home, ".aws", "config");

  const creds = readSection(credsPath, profileName);
  const cfg = readSection(cfgPath, profileName);

  const accessKeyId =
    creds?.get("aws_access_key_id") ?? cfg?.get("aws_access_key_id");
  const secretAccessKey =
    creds?.get("aws_secret_access_key") ?? cfg?.get("aws_secret_access_key");

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `No AWS credentials found for profile "${profileName}". ` +
      `Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or configure ~/.aws/credentials.`,
    );
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken:
      creds?.get("aws_session_token") ?? cfg?.get("aws_session_token"),
  };
}

// Region resolution: explicit > env vars > ~/.aws/config > us-east-1
export function resolveRegion(explicit?: string, profile?: string): string {
  if (explicit) return explicit;
  if (process.env.AWS_REGION) return process.env.AWS_REGION;
  if (process.env.AWS_DEFAULT_REGION) return process.env.AWS_DEFAULT_REGION;

  const profileName =
    profile ??
    process.env.AWS_PROFILE ??
    process.env.AWS_DEFAULT_PROFILE ??
    "default";
  const cfgPath =
    process.env.AWS_CONFIG_FILE ??
    resolve(homedir(), ".aws", "config");
  return readSection(cfgPath, profileName)?.get("region") ?? "us-east-1";
}
