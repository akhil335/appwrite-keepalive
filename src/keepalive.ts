import { Client, Databases, Permission, Role, ID } from "node-appwrite";
import {
  type KeepaliveResult,
  type ProjectConfig,
  type SiteKeepaliveResult,
} from "./types.js";

/** User-Agent string sent on Site HTTP keepalive pings */
const SITE_KEEPALIVE_USER_AGENT =
  "appwrite-keepalive/1.1 (+https://github.com/OthmanAdi/appwrite-keepalive)";

/** Timeout (ms) for HTTP keepalive ping against a deployed Appwrite Site */
const SITE_KEEPALIVE_TIMEOUT_MS = 15_000;

async function pingSite(url: string): Promise<SiteKeepaliveResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_KEEPALIVE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": SITE_KEEPALIVE_USER_AGENT,
        "Cache-Control": "no-cache",
      },
    });

    return {
      url,
      success: response.ok,
      status: response.status,
      message: response.ok
        ? `HTTP ${response.status}`
        : `HTTP ${response.status} (treated as failure)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      success: false,
      message: message || "unknown fetch error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSiteUrls(input: ProjectConfig["siteUrls"]): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : [input];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

export async function keepaliveProject(config: ProjectConfig): Promise<KeepaliveResult> {
  const { endpoint, projectId, apiKey, name } = config;
  const timestamp = new Date().toISOString();
  const projectLabel = name || projectId;

  const siteUrls = normalizeSiteUrls(config.siteUrls);
  const [dbResult, siteResults] = await Promise.all([
    runDatabaseHeartbeat({ endpoint, projectId, apiKey, projectLabel, timestamp }),
    siteUrls.length > 0
      ? runSiteHeartbeat(projectLabel, siteUrls)
      : Promise.resolve<SiteKeepaliveResult[]>([]),
  ]);

  const allSitesOk = siteResults.every((r) => r.success);
  const success = dbResult.success && allSitesOk;
  const messages: string[] = [dbResult.message];
  if (siteResults.length > 0) {
    const okCount = siteResults.filter((r) => r.success).length;
    messages.push(`site keepalive ${okCount}/${siteResults.length} ok`);
  }

  return {
    projectId,
    name,
    success,
    message: messages.join("; "),
    timestamp,
    ...(siteResults.length > 0 ? { siteResults } : {}),
  };
}

interface DatabaseHeartbeatArgs {
  endpoint: string;
  projectId: string;
  apiKey: string;
  projectLabel: string;
  timestamp: string;
}

interface DatabaseHeartbeatResult {
  success: boolean;
  message: string;
}

async function runDatabaseHeartbeat(args: DatabaseHeartbeatArgs): Promise<DatabaseHeartbeatResult> {
  const { endpoint, projectId, apiKey, projectLabel, timestamp } = args;
  try {
    const client = new Client();
    client.setEndpoint(endpoint).setProject(projectId).setKey(apiKey);

    const databases = new Databases(client);

    // Read your existing database and collection IDs from environment variables
    const targetDatabaseId = process.env.APPWRITE_DATABASE_ID;
    const targetCollectionId = process.env.APPWRITE_COLLECTION_ID;

    if (!targetDatabaseId || !targetCollectionId) {
      return { 
        success: false, 
        message: "db keepalive failed: APPWRITE_DATABASE_ID or APPWRITE_COLLECTION_ID environment variables are missing." 
      };
    }

    // Write a minor log document directly to your existing collection to trigger activity
    await databases.createDocument({
      databaseId: targetDatabaseId,
      collectionId: targetCollectionId,
      documentId: ID.unique(),
      data: { 
        timestamp, 
        source: "github-actions" 
      },
      permissions: [Permission.read(Role.any())],
    });

    console.log(`[${projectLabel}] db heartbeat sent to database ${targetDatabaseId} at ${timestamp}`);
    return { success: true, message: "db heartbeat sent to existing collection" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${projectLabel}] db keepalive failed: ${errorMessage}`);
    return { success: false, message: `db keepalive failed: ${errorMessage}` };
  }
}

async function runSiteHeartbeat(
  projectLabel: string,
  urls: string[],
): Promise<SiteKeepaliveResult[]> {
  return Promise.all(urls.map((u) => pingSite(u))).then((results) => {
    for (const r of results) {
      const tag = r.success ? "ok" : "FAIL";
      console.log(`[${projectLabel}] site ${tag}: ${r.url} (${r.message})`);
    }
    return results;
  });
}
