import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { logger } from "../util/log.js";

const log = logger("oauth");

// drive.file is a non-sensitive scope: the app can only see files it
// creates plus those a user explicitly hands to it via the picker. This
// keeps the verification footprint small and the user's other Drive
// content invisible to the archiver.
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// Embedded OAuth client for the published hydra-acp-archiver app. For
// installed/desktop OAuth clients the "secret" is not actually secret —
// Google's docs state plainly that desktop apps cannot keep it
// confidential. The real security boundary is the loopback redirect +
// explicit user consent, not this string.
const CLIENT_ID = "774694216181-tq9raja8oij25bb0okq00g5fvg002u3k.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

interface StoredToken {
  refresh_token?: string | null;
  access_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

async function loadToken(path: string): Promise<StoredToken | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as StoredToken;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function saveToken(path: string, token: StoredToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

function tryOpenBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      log.info("could not auto-open browser; copy the URL above into a browser");
    });
    child.unref();
  } catch {
    log.info("could not auto-open browser; copy the URL above into a browser");
  }
}

export interface GoogleAuthOptions {
  tokenPath: string;
}

// Runtime-side: load token, return an OAuth2Client that auto-refreshes
// its access token. Throws with a clear message if the user hasn't run
// the login flow yet.
export async function loadGoogleAuth(
  opts: GoogleAuthOptions,
): Promise<OAuth2Client> {
  const token = await loadToken(opts.tokenPath);
  if (!token || !token.refresh_token) {
    throw new Error(
      `No Google OAuth token at ${opts.tokenPath}. Run \`hydra-acp-archiver-login\` first.`,
    );
  }
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  client.setCredentials(token);
  // Persist refreshed tokens whenever google-auth-library issues a new
  // access token, so we keep the latest expiry on disk for future runs.
  client.on("tokens", (next) => {
    const merged: StoredToken = { ...token, ...next };
    void saveToken(opts.tokenPath, merged).catch((err: unknown) => {
      log.warn(`failed to persist refreshed token: ${(err as Error).message}`);
    });
  });
  return client;
}

// Login-side: interactive flow using a loopback redirect on a
// kernel-assigned port. Writes refresh+access tokens to tokenPath.
export async function runGoogleLogin(
  opts: GoogleAuthOptions,
): Promise<void> {
  // Bind loopback server first so we can build the redirect_uri with
  // the assigned port.
  const { port, codePromise, close } = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    redirectUri,
  );
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    // prompt=consent forces a refresh_token even if the user previously
    // granted access — without it, repeat logins return only an access
    // token.
    prompt: "consent",
  });

  log.info("Open this URL in a browser to authorize the archiver:");
  log.info(authUrl);
  tryOpenBrowser(authUrl);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    close();
  }

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke the app at https://myaccount.google.com/permissions and try again.",
    );
  }
  await saveToken(opts.tokenPath, tokens as StoredToken);
  log.info(`token saved to ${opts.tokenPath}`);
}

interface CallbackServer {
  port: number;
  codePromise: Promise<string>;
  close: () => void;
}

async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode: (code: string) => void = () => void 0;
  let rejectCode: (err: Error) => void = () => void 0;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`Authorization error: ${error}\n\nYou can close this tab.`);
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Missing ?code parameter. You can close this tab.");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hydra-acp-archiver: authorization complete. You can close this tab.");
      resolveCode(code);
    } catch (err) {
      res.statusCode = 500;
      res.end("internal error");
      rejectCode(err as Error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("failed to determine callback server port");
  }
  const port = addr.port;
  log.info(`listening for OAuth redirect on http://127.0.0.1:${port}`);

  return {
    port,
    codePromise,
    close: () => {
      try {
        server.close();
      } catch {
        // ignore
      }
    },
  };
}
