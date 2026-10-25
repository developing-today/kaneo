import { and, eq, ne } from "drizzle-orm";
import db from "../../../database";
import {
  externalLinkTable,
  integrationRepositoryTable,
} from "../../../database/schema";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RepositoryBindingInput = {
  repositoryOwner: string;
  repositoryName: string;
  repositoryId?: number | null;
  installationId?: number | null;
  verifiedGithubAccountId?: string | null;
  verifiedByUserId?: string | null;
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
  const bindings = await database.query.integrationRepositoryTable.findMany({
    where: eq(integrationRepositoryTable.integrationId, integrationId),
  });
  // A renamed or transferred repository keeps its numeric ID, so that ID is
  // the authoritative match; owner/name is the fallback for legacy bindings
  // that predate verified IDs.
  const byRepositoryId =
    config.repositoryId != null
      ? bindings.find((binding) => binding.repositoryId === config.repositoryId)
      : undefined;
  const byName = bindings.find(
    (binding) =>
      binding.repositoryOwner.toLowerCase() ===
        config.repositoryOwner.toLowerCase() &&
      binding.repositoryName.toLowerCase() ===
        config.repositoryName.toLowerCase(),
  );
  const target = byRepositoryId ?? byName;
  const duplicate =
    target && byName && byName.id !== target.id ? byName : undefined;

  // Demote any other primary first: the per-integration partial unique index
  // rejects a second `isPrimary` row, so the demotion must precede the update.
  await database
    .update(integrationRepositoryTable)
    .set({ isPrimary: false })
    .where(
      and(
        eq(integrationRepositoryTable.integrationId, integrationId),
        target ? ne(integrationRepositoryTable.id, target.id) : undefined,
      ),
    );

  if (target && duplicate) {
    // Both identities already have a row (e.g. an unverified name-only row
    // plus the verified ID row). Keep the ID row and its identity, move the
    // duplicate's links onto it, then drop the duplicate.
    await database
      .update(externalLinkTable)
      .set({ integrationRepositoryId: target.id })
      .where(eq(externalLinkTable.integrationRepositoryId, duplicate.id));
    await database
      .delete(integrationRepositoryTable)
      .where(eq(integrationRepositoryTable.id, duplicate.id));
  }

  if (target) {
    // Update in place so the binding ID — and every external link pointing
    // at it — survives a rename or transfer.
    await database
      .update(integrationRepositoryTable)
      .set({ ...values, isPrimary: true })
      .where(eq(integrationRepositoryTable.id, target.id));
    return;
  }

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
