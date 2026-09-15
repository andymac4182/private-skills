import {
  FilesSdkBlobStore,
  type FilesClientLike,
  type FilesSdkBlobStoreOptions,
} from "./files.js";
import { digestBytes } from "./digest.js";

/** Providers supported by the current files-sdk adapter catalog. */
export type FilesProvider =
  | "fs"
  | "s3"
  | "r2"
  | "gcs"
  | "azure"
  | "vercel-blob";

/** Explicit credentials accepted by the corresponding Files SDK adapter. */
export interface FilesProviderCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  accountId?: string;
  accountName?: string;
  accountKey?: string;
  connectionString?: string;
  sasToken?: string;
  clientEmail?: string;
  privateKey?: string;
  token?: string;
  oidcToken?: string;
  storeId?: string;
}

export interface NodeFilesSdkOptions
  extends Omit<FilesSdkBlobStoreOptions, "client"> {
  provider: FilesProvider;
  /** Files SDK fs adapter root. */
  root?: string;
  /** Bucket name for S3, R2, and GCS. */
  bucket?: string;
  /** Azure uses the Files SDK's `container` spelling. */
  container?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  projectId?: string;
  credentials?: FilesProviderCredentials;
}

type AdapterFactory = (options: Record<string, unknown>) => unknown;

/**
 * Keep these imports in the explicit Node entry point. The package root and
 * the edge runtime never import this module, so optional native provider
 * dependencies cannot enter their bundles. The runtime specifier stays
 * variable so Node-aware bundlers leave the optional provider peers external,
 * while test runners and native Node still use a real import callback.
 */
type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;
const dynamicImport: DynamicImport = (specifier) =>
  import(specifier) as unknown as Promise<Record<string, unknown>>;

function required(
  value: string | undefined,
  label: string
): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Files SDK ${label} is required`);
  }
  return value;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

function sdkModuleError(provider: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Unable to load Files SDK provider ${provider}. Install files-sdk@2.4.0 and its optional provider peer dependencies: ${message}`
  );
}

/** Build an actual files-sdk `Files` client with the selected adapter. */
export async function createNodeFilesClient(
  options: NodeFilesSdkOptions
): Promise<FilesClientLike> {
  const provider = options.provider;
  const credentials = options.credentials ?? {};
  try {
    const core = await dynamicImport("files-sdk");
    const Files = core.Files;
    if (typeof Files !== "function") {
      throw new Error("files-sdk did not export Files");
    }

    let adapter: unknown;
    switch (provider) {
      case "fs": {
        const module = await dynamicImport("files-sdk/fs");
        const createAdapter = module.fs;
        if (typeof createAdapter !== "function") {
          throw new Error("files-sdk/fs did not export fs");
        }
        adapter = (createAdapter as AdapterFactory)({
          root: required(options.root, "fs root"),
        });
        break;
      }
      case "s3": {
        const module = await dynamicImport("files-sdk/s3");
        const createAdapter = module.s3;
        if (typeof createAdapter !== "function") {
          throw new Error("files-sdk/s3 did not export s3");
        }
        adapter = (createAdapter as AdapterFactory)(
          withoutUndefined({
            bucket: required(options.bucket, "S3 bucket"),
            region: options.region,
            endpoint: options.endpoint,
            forcePathStyle: options.forcePathStyle,
            credentials:
              credentials.accessKeyId && credentials.secretAccessKey
                ? {
                    accessKeyId: credentials.accessKeyId,
                    secretAccessKey: credentials.secretAccessKey,
                    sessionToken: credentials.sessionToken,
                  }
                : undefined,
            // A private registry must never configure a public base URL. The
            // adapter therefore falls back to signed URLs or gateway reads.
            publicBaseUrl: undefined,
          })
        );
        break;
      }
      case "r2": {
        const module = await dynamicImport("files-sdk/r2");
        const createAdapter = module.r2;
        if (typeof createAdapter !== "function") {
          throw new Error("files-sdk/r2 did not export r2");
        }
        adapter = (createAdapter as AdapterFactory)(
          withoutUndefined({
            bucket: required(options.bucket, "R2 bucket"),
            accountId: credentials.accountId,
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            endpoint: options.endpoint,
            client: "fetch",
            publicBaseUrl: undefined,
          })
        );
        break;
      }
      case "gcs": {
        const module = await dynamicImport("files-sdk/gcs");
        const createAdapter = module.gcs;
        if (typeof createAdapter !== "function") {
          throw new Error("files-sdk/gcs did not export gcs");
        }
        adapter = (createAdapter as AdapterFactory)(
          withoutUndefined({
            bucket: required(options.bucket, "GCS bucket"),
            projectId: options.projectId,
            credentials:
              credentials.clientEmail && credentials.privateKey
                ? {
                    client_email: credentials.clientEmail,
                    private_key: credentials.privateKey,
                  }
                : undefined,
            publicBaseUrl: undefined,
          })
        );
        break;
      }
      case "azure": {
        const module = await dynamicImport("files-sdk/azure");
        const createAdapter = module.azure;
        if (typeof createAdapter !== "function") {
          throw new Error("files-sdk/azure did not export azure");
        }
        adapter = (createAdapter as AdapterFactory)(
          withoutUndefined({
            container: required(
              options.container ?? options.bucket,
              "Azure container"
            ),
            connectionString: credentials.connectionString,
            accountName: credentials.accountName,
            accountKey: credentials.accountKey,
            sasToken: credentials.sasToken,
            endpoint: options.endpoint,
            publicBaseUrl: undefined,
          })
        );
        break;
      }
      case "vercel-blob": {
        const module = await dynamicImport("files-sdk/vercel-blob");
        const createAdapter = module.vercelBlob;
        if (typeof createAdapter !== "function") {
          throw new Error("files-sdk/vercel-blob did not export vercelBlob");
        }
        adapter = (createAdapter as AdapterFactory)(
          withoutUndefined({
            token: credentials.token,
            oidcToken: credentials.oidcToken,
            storeId: credentials.storeId,
            // Vercel Blob defaults to public; explicitly force private access.
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: false,
          })
        );
        break;
      }
      default:
        throw new Error(`unsupported Files SDK provider ${String(provider)}`);
    }

    return new (Files as new (options: { adapter: unknown }) => FilesClientLike)({
      adapter,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Files SDK ")) {
      throw error;
    }
    throw sdkModuleError(provider, error);
  }
}

/** Convenience factory for the private BlobStore used by Node/Nitro hosts. */
export async function createNodeFilesSdkBlobStore(
  options: NodeFilesSdkOptions
): Promise<FilesSdkBlobStore> {
  const client = await createNodeFilesClient(options);
  const providerBinding = options.providerBinding ?? await derivedProviderBinding(options);
  return new FilesSdkBlobStore({
    client,
    maxBytes: options.maxBytes,
    prefix: options.prefix,
    providerBinding,
  });
}

/**
 * Build a stable non-secret identity when the host did not provide one.
 * Credentials are intentionally excluded; rotation of a credential for the
 * same bucket/account must not make a completed object look like another
 * provider. Vercel Blob has no public store identity unless the host supplies
 * `storeId`, so it must receive an explicit binding in that configuration.
 */
async function derivedProviderBinding(options: NodeFilesSdkOptions): Promise<string> {
  const storeId = options.credentials?.storeId;
  if (options.provider === "vercel-blob" && !storeId) {
    throw new Error(
      "Files SDK vercel-blob requires providerBinding or credentials.storeId for durable storage recovery",
    );
  }
  const identity = {
    provider: options.provider,
    prefix: options.prefix ?? "",
    root: options.root ?? null,
    bucket: options.bucket ?? null,
    container: options.container ?? null,
    region: options.region ?? null,
    endpoint: options.endpoint ?? null,
    forcePathStyle: options.forcePathStyle ?? null,
    projectId: options.projectId ?? null,
    accountId: options.credentials?.accountId ?? null,
    accountName: options.credentials?.accountName ?? null,
    storeId: storeId ?? null,
  };
  const digest = await digestBytes(new TextEncoder().encode(JSON.stringify(identity)));
  return `files-sdk:${options.provider}:${digest}`;
}
