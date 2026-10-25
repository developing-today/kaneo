import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import createIntegration from "../../apps/api/src/github-integration/controllers/create-github-integration";
import { migrateIntegrationRepositories } from "../../apps/api/src/migrations/integration-repository-migration";
import {
  findRepositoryBinding,
  upsertPrimaryBinding,
} from "../../apps/api/src/plugins/github/services/repository-bindings";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock(
  "../../apps/api/src/github-integration/controllers/verify-repository-owner",
  () => ({
    verifyRepositoryOwner: verify,
  }),
);

beforeEach(async () => {
  await resetTestDatabase();
  verify.mockReset();
});

async function seedGithubIntegration(
  projectId: string,
  config: Record<string, unknown>,
) {
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId,
      type: "github",
      isActive: true,
      config: JSON.stringify(config),
    })
    .returning();
  return integration;
}

describe("integration_repository backfill migration", () => {
  it("creates a primary binding for an existing single-repo integration and re-attaches its links", async () => {
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const integration = await seedGithubIntegration(project.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 42,
      installationId: 7,
      verifiedGithubAccountId: "9",
      verifiedByUserId: "user-1",
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Task", number: 1 })
      .returning();
    const [link] = await db
      .insert(schema.externalLinkTable)
      .values({
        taskId: task.id,
        integrationId: integration.id,
        resourceType: "issue",
        externalId: "1",
        url: "https://github.com/owner/repo/issues/1",
      })
      .returning();

    await migrateIntegrationRepositories();

    const bindings = await db.query.integrationRepositoryTable.findMany();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      integrationId: integration.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 42,
      installationId: 7,
      verifiedGithubAccountId: "9",
      verifiedByUserId: "user-1",
      isPrimary: true,
    });

    const attached = await db.query.externalLinkTable.findFirst({
      where: eq(schema.externalLinkTable.id, link.id),
    });
    expect(attached?.integrationRepositoryId).toBe(bindings[0].id);
  });

  it("is idempotent without the completion marker", async () => {
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await seedGithubIntegration(project.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 1,
      installationId: 2,
    });

    await migrateIntegrationRepositories();
    // Simulate a crash before the marker committed, then re-run: the upsert
    // path must not duplicate the binding.
    await db
      .delete(schema.dataMigrationTable)
      .where(eq(schema.dataMigrationTable.id, "integration-repository-v1"));
    await migrateIntegrationRepositories();

    const bindings = await db.query.integrationRepositoryTable.findMany();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].isPrimary).toBe(true);
  });

  it("skips a malformed config without blocking the backfill", async () => {
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await seedGithubIntegration(project.id, {
      // Missing repositoryOwner/repositoryName; not a binding.
      installationId: 2,
    });

    await migrateIntegrationRepositories();
    expect(await db.query.integrationRepositoryTable.findMany()).toHaveLength(
      0,
    );
    expect(
      await db.query.dataMigrationTable.findFirst({
        where: eq(schema.dataMigrationTable.id, "integration-repository-v1"),
      }),
    ).toBeDefined();
  });
});

describe("repository binding service", () => {
  it("upserts a primary binding and demotes any other primary", async () => {
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const integration = await seedGithubIntegration(project.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 1,
    });

    await upsertPrimaryBinding(integration.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 1,
    });
    await upsertPrimaryBinding(integration.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 1,
    });
    // A second repository joins the project and takes primary.
    await upsertPrimaryBinding(integration.id, {
      repositoryOwner: "owner",
      repositoryName: "second",
      repositoryId: 2,
    });
    // The first repository is re-confirmed and demotes the second.
    await upsertPrimaryBinding(integration.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 1,
    });

    const bindings = await db.query.integrationRepositoryTable.findMany();
    expect(bindings).toHaveLength(2);
    expect(
      bindings
        .filter((binding) => binding.isPrimary)
        .map((b) => b.repositoryName),
    ).toEqual(["repo"]);

    expect(
      (await findRepositoryBinding(integration.id, 2))?.repositoryName,
    ).toBe("second");
    expect((await findRepositoryBinding(integration.id))?.repositoryName).toBe(
      "repo",
    );
  });

  it("updates the existing binding in place when a repository is renamed", async () => {
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const integration = await seedGithubIntegration(project.id, {
      repositoryOwner: "old-owner",
      repositoryName: "old-name",
      repositoryId: 42,
      installationId: 7,
    });

    await upsertPrimaryBinding(integration.id, {
      repositoryOwner: "old-owner",
      repositoryName: "old-name",
      repositoryId: 42,
      installationId: 7,
    });
    const [original] = await db.query.integrationRepositoryTable.findMany();
    // Attach a link to the original binding; it must survive the rename.
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Task", number: 1 })
      .returning();
    const [link] = await db
      .insert(schema.externalLinkTable)
      .values({
        taskId: task.id,
        integrationId: integration.id,
        integrationRepositoryId: original.id,
        resourceType: "issue",
        externalId: "1",
        url: "https://github.com/old-owner/old-name/issues/1",
      })
      .returning();

    // Same numeric repository ID, new owner/name (rename or transfer).
    await upsertPrimaryBinding(integration.id, {
      repositoryOwner: "new-owner",
      repositoryName: "renamed",
      repositoryId: 42,
      installationId: 7,
    });

    const bindings = await db.query.integrationRepositoryTable.findMany();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: original.id,
      repositoryOwner: "new-owner",
      repositoryName: "renamed",
      repositoryId: 42,
      isPrimary: true,
    });
    const attached = await db.query.externalLinkTable.findFirst({
      where: eq(schema.externalLinkTable.id, link.id),
    });
    expect(attached?.integrationRepositoryId).toBe(original.id);
  });

  it("returns undefined when an integration has no binding", async () => {
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const integration = await seedGithubIntegration(project.id, {
      repositoryOwner: "owner",
      repositoryName: "repo",
    });
    expect(await findRepositoryBinding(integration.id)).toBeUndefined();
  });
});

describe("create GitHub integration writes a binding", () => {
  it("persists a primary binding alongside the integration row", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    verify.mockResolvedValue({
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 2,
      installationId: 1,
      verifiedGithubAccountId: "3",
      verifiedByUserId: user.id,
    });

    const created = await createIntegration({
      userId: user.id,
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    const bindings = await db.query.integrationRepositoryTable.findMany();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      integrationId: created.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 2,
      installationId: 1,
      isPrimary: true,
    });
  });

  it("reconnecting a renamed repository updates the same binding", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const binding = {
      repositoryOwner: "owner",
      repositoryName: "repo",
      repositoryId: 2,
      installationId: 1,
      verifiedGithubAccountId: "3",
      verifiedByUserId: user.id,
    };
    verify.mockResolvedValue(binding);
    const created = await createIntegration({
      userId: user.id,
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
    });
    const [original] = await db.query.integrationRepositoryTable.findMany();

    verify.mockResolvedValue({
      ...binding,
      repositoryOwner: "new-owner",
      repositoryName: "renamed",
    });
    const reconnected = await createIntegration({
      userId: user.id,
      projectId: project.id,
      repositoryOwner: "new-owner",
      repositoryName: "renamed",
    });

    expect(reconnected.id).toBe(created.id);
    const bindings = await db.query.integrationRepositoryTable.findMany();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: original.id,
      repositoryOwner: "new-owner",
      repositoryName: "renamed",
      repositoryId: 2,
      isPrimary: true,
    });
  });
});
