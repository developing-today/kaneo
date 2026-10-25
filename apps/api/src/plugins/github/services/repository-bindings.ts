import { and, eq, ne, or } from "drizzle-orm";
import db from "../../../database";
import { integrationRepositoryTable } from "../../../database/schema";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RepositoryBindingInput = {
  repositoryOwner: string;
  repositoryName: string;
  repositoryId?: number;
  installationId?: number | null;
  verifiedGithubAccountId?: string;
  verifiedByUserId?: string;
};

/** The repository fields a binding carries, mirrored from the integration config. */
export function repositoryBindingValues(config: RepositoryBindingInput) {
  return {
    repositoryOwner: config.repositoryOwner,
    repositoryName: config.repositoryName,
    repositoryId: config.repositoryId ?? null,
    installationId: config.installationId ?? null,
    verifiedGithubAccountId: config.verifiedGithubAccountId ?? null,
    verifiedByUserId: config.verifiedByUserId ?? null,
  };
}

/**
 * Ensures the integration has a primary binding matching `config`, and that no
 * other binding for the same integration claims primary. Idempotent.
 */
export async function upsertPrimaryBinding(
  integrationId: string,
  config: RepositoryBindingInput,
  database: DbOrTx = db,
) {
  const values = repositoryBindingValues(config);
  // Demote any other primary first: the per-integration partial unique index
  // rejects a second `isPrimary` row, so the demotion must precede the insert.
  await database
    .update(integrationRepositoryTable)
    .set({ isPrimary: false })
    .where(
      and(
        eq(integrationRepositoryTable.integrationId, integrationId),
        or(
          ne(
            integrationRepositoryTable.repositoryOwner,
            config.repositoryOwner,
          ),
          ne(integrationRepositoryTable.repositoryName, config.repositoryName),
        ),
      ),
    );
  await database
    .insert(integrationRepositoryTable)
    .values({ ...values, integrationId, isPrimary: true })
    .onConflictDoNothing({
      target: [
        integrationRepositoryTable.integrationId,
        integrationRepositoryTable.repositoryOwner,
        integrationRepositoryTable.repositoryName,
      ],
    });
  await database
    .update(integrationRepositoryTable)
    .set({ ...values, isPrimary: true })
    .where(
      and(
        eq(integrationRepositoryTable.integrationId, integrationId),
        eq(integrationRepositoryTable.repositoryOwner, config.repositoryOwner),
        eq(integrationRepositoryTable.repositoryName, config.repositoryName),
      ),
    );
}

export async function listRepositoryBindings(integrationId: string) {
  return db.query.integrationRepositoryTable.findMany({
    where: eq(integrationRepositoryTable.integrationId, integrationId),
  });
}

/**
 * Resolves an integration to a single repository binding. Primary bindings are
 * preferred; when `repositoryId` is known it is authoritative. Returns
 * `undefined` when the integration has no binding (e.g. an unverified legacy
 * integration that has not yet been re-connected).
 */
export async function findRepositoryBinding(
  integrationId: string,
  repositoryId?: number,
) {
  const bindings = await listRepositoryBindings(integrationId);
  if (bindings.length === 0) return undefined;
  if (repositoryId != null) {
    const byId = bindings.find(
      (binding) => binding.repositoryId === repositoryId,
    );
    if (byId) return byId;
  }
  return (
    bindings.find((binding) => binding.isPrimary) ??
    bindings.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
  );
}
