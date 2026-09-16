// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, Trash2 } from "lucide-react";
import { useDeleteGitRepo, useUpdateGitRepo } from "../api/use-git-repos";
import { EditorSheet } from "@/components/ui/editor-sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { useGitConnections } from "@/features/integrations/api/use-git-connections";
import type { GitProvider, GitRepo } from "@/types/git";

const PROVIDER_VALUES: GitProvider[] = [
  "github",
  "gitlab",
  "gitea",
  "bitbucket",
  "other",
];

// Sentinel for "no credential bound" — a Select cannot carry null as a value,
// and the empty string is how the trigger renders its placeholder.
const NO_CONNECTION = "__none__";

interface GitRepoEditorProps {
  repo: GitRepo;
  slug: string;
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
}

export function GitRepoEditor({
  repo,
  slug,
  boardId,
  open,
  onOpenChange,
  isAdmin,
}: GitRepoEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(repo.name);
  const [url, setUrl] = useState(repo.url);
  const [provider, setProvider] = useState<GitProvider>(repo.provider);
  const [defaultBranch, setDefaultBranch] = useState(repo.default_branch);
  const [integrationBranch, setIntegrationBranch] = useState(
    repo.integration_branch ?? "",
  );
  const [description, setDescription] = useState(repo.description);
  const [connectionId, setConnectionId] = useState(
    repo.connection_id ?? NO_CONNECTION,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updateGitRepo = useUpdateGitRepo(slug, boardId);
  const deleteGitRepo = useDeleteGitRepo(slug, boardId);
  const connectionsQuery = useGitConnections(slug);
  // A credential for another forge can never authenticate this repo, and the
  // backend 422s on the mismatch — so only same-provider accounts are offered.
  const matchingConnections =
    connectionsQuery.data?.filter((c) => c.provider === provider) ?? [];

  useEffect(() => {
    setName(repo.name);
    setUrl(repo.url);
    setProvider(repo.provider);
    setDefaultBranch(repo.default_branch);
    setIntegrationBranch(repo.integration_branch ?? "");
    setDescription(repo.description);
    setConnectionId(repo.connection_id ?? NO_CONNECTION);
  }, [repo]);

  function handleSave() {
    updateGitRepo.mutate({
      repoId: repo.id,
      name,
      url,
      provider,
      default_branch: defaultBranch,
      integration_branch: integrationBranch.trim() === "" ? null : integrationBranch.trim(),
      description,
      // Always explicit: the backend patches with exclude_unset, so `null` is
      // the only way to say "unbind" and an omitted key would keep the old one.
      connection_id: connectionId === NO_CONNECTION ? null : connectionId,
    });
  }

  function handleDelete() {
    deleteGitRepo.mutate(repo.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        onOpenChange(false);
      },
    });
  }

  return (
    <>
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      a11yTitle={t("gitRepos.editTitle")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={updateGitRepo.isPending}>
            {updateGitRepo.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("gitRepos.namePlaceholder")}</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("gitRepos.namePlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("gitRepos.urlPlaceholder")}</label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("gitRepos.urlPlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-sm font-medium">
          {t("gitRepos.providerPlaceholder")}
          <RichTooltip i18nKey="workspace.git.provider" side="right">
            <HelpCircle
              aria-label={t("gitRepos.providerPlaceholder")}
              className="h-3.5 w-3.5 text-muted-foreground"
            />
          </RichTooltip>
        </label>
        <Select value={provider} onValueChange={(v) => setProvider(v as GitProvider)}>
          <SelectTrigger aria-label={t("gitRepos.providerPlaceholder")}>
            <SelectValue placeholder={t("gitRepos.providerPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_VALUES.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`gitRepos.providers.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("gitRepos.connectionLabel")}
        </label>
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger
            aria-label={t("gitRepos.connectionLabel")}
            disabled={!isAdmin}
          >
            <SelectValue placeholder={t("gitRepos.connectionNone")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CONNECTION}>
              {t("gitRepos.connectionNone")}
            </SelectItem>
            {matchingConnections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.account_login}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {!isAdmin
            ? t("gitRepos.connectionAdminOnly")
            : matchingConnections.length === 0
              ? t("gitRepos.connectionNoneAvailable", {
                  provider: t(`gitRepos.providers.${provider}`),
                })
              : t("gitRepos.connectionHint")}
        </p>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-sm font-medium">
          {t("gitRepos.branchEditPlaceholder")}
          <RichTooltip i18nKey="workspace.git.branchProtection" side="right">
            <HelpCircle
              aria-label={t("gitRepos.branchEditPlaceholder")}
              className="h-3.5 w-3.5 text-muted-foreground"
            />
          </RichTooltip>
        </label>
        <Input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder={t("gitRepos.branchEditPlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("gitRepos.integrationBranchLabel")}
        </label>
        <Input
          value={integrationBranch}
          onChange={(e) => setIntegrationBranch(e.target.value)}
          placeholder={t("gitRepos.integrationBranchPlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("common.descriptionOptional")}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("common.descriptionOptional")}
          className="min-h-[160px] resize-none"
        />
      </div>
    </EditorSheet>
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title={t("gitRepos.deleteTitle")}
      description={t("gitRepos.deleteConfirm")}
      confirmLabel={t("common.delete")}
      cancelLabel={t("common.cancel")}
      pending={deleteGitRepo.isPending}
      onConfirm={handleDelete}
    />
    </>
  );
}
